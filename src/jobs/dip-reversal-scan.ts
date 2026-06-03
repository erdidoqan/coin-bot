/**
 * Dip Reversal Sniper — paylaşılan tarama (hem giriş job'u hem admin paneli kullanır).
 *
 * Tek kaynak: sniper ile panelin AYNI kapıları/eşikleri görmesini garanti eder.
 * Watchlist'i (WS tick verisi) tarar, her sembol için capitulation + bounce
 * metriklerini ve kapı sonuçlarını üretir; uygunluk/çakışma (grid, açık pozisyon,
 * cooldown, sistem-blok) durumunu işaretler. Emir GÖNDERMEZ (saf okuma).
 */
import { getTickScalpConfig } from '../db/bot-config';
import type { DipReversalConfig } from '../db/dip-reversal';
import { hasOpenPositionForSymbol } from '../db/open-positions';
import { fetchKlinesFromDo, fetchTickRank } from '../exchange/market-data-client';
import {
  evaluateDipReversalSignal,
  windowDrawdownPct,
  type DipReversalSignal,
  type DipReversalThresholds,
} from '../strategy/dip-reversal';
import { rollingReturnPct } from '../strategy/grid-readiness';
import { isSystemTradeBlockedSymbol } from '../config/system-trade-rules';
import { bn } from '../math/decimal';

export type DipReversalExclusion =
  | 'system_blocked'
  | 'no_mid'
  | 'grid'
  | 'open_position'
  | 'cooldown'
  | null;

export interface DipReversalScanRow {
  symbol: string;
  mid: string | null;
  windowDropPct: number | null;
  /** Güncel fiyatın 3 dk önceki 1m kapanışa göre değişimi % (panel modunda dolar). */
  change3mPct: number | null;
  /** Güncel fiyatın 10 dk önceki 1m kapanışa göre değişimi % (panel modunda dolar). */
  change10mPct: number | null;
  wsDeclinePct: number | null;
  recoveryFromWsLowPct: number | null;
  reversalScore: number;
  secSinceTrough: number | null;
  midSlopeOk: boolean;
  signal: DipReversalSignal;
  excluded: DipReversalExclusion;
  eligible: boolean;
  score: number | null;
}

export function thresholdsFromConfig(cfg: DipReversalConfig): DipReversalThresholds {
  return {
    minCapitulationDropPct: cfg.minCapitulationDropPct,
    minWsDeclinePct: cfg.minWsDeclinePct,
    minRecoveryFromLowPct: cfg.minRecoveryFromLowPct,
    minReversalScore: cfg.minReversalScore,
    maxSecSinceTrough: cfg.maxSecSinceTrough,
    requireMidSlope: cfg.requireMidSlope,
  };
}

export async function gridHeldSymbols(db: D1Database): Promise<Set<string>> {
  const { results } = await db
    .prepare("SELECT DISTINCT symbol FROM grid_state WHERE status IN ('ACTIVE','RECOVERING')")
    .all<{ symbol: string }>();
  return new Set((results ?? []).map((r) => r.symbol));
}

export async function inPostExitCooldown(
  db: D1Database,
  symbol: string,
  minutes: number,
): Promise<boolean> {
  if (minutes <= 0) return false;
  const row = await db
    .prepare(
      `SELECT 1 as hit FROM trade_log
       WHERE event_type = 'POSITION_CLOSED'
         AND payload LIKE ?
         AND payload LIKE ?
         AND created_at >= datetime('now', ?)
       LIMIT 1`,
    )
    .bind(`%"symbol":"${symbol}"%`, '%"entry_mode":"dip_reversal"%', `-${minutes} minutes`)
    .first<{ hit: number }>();
  return row?.hit === 1;
}

function reversalPrePass(
  row: { reversalScore: number; secSinceTrough: number | null; midSlopeOk: boolean },
  wsDecline: number | null,
  recovery: number | null,
  thr: DipReversalThresholds,
): boolean {
  return (
    wsDecline != null &&
    wsDecline >= thr.minWsDeclinePct &&
    recovery != null &&
    recovery >= thr.minRecoveryFromLowPct &&
    row.reversalScore >= thr.minReversalScore &&
    row.secSinceTrough != null &&
    row.secSinceTrough <= thr.maxSecSinceTrough &&
    (!thr.requireMidSlope || row.midSlopeOk)
  );
}

/**
 * @param opts.full true → tüm (hariç olmayan) semboller için capitulation (windowDrop)
 *   hesaplanır (panel). false → yalnızca reversal ön kapısı geçince hesaplanır (sniper,
 *   DO subrequest tasarrufu).
 */
export async function scanDipReversalCandidates(
  env: Env,
  cfg: DipReversalConfig,
  opts: { full: boolean },
): Promise<DipReversalScanRow[]> {
  const tickCfg = await getTickScalpConfig(env.DB, env);
  const rank = await fetchTickRank(env, tickCfg);
  if (!rank || rank.rows.length === 0) return [];

  const thr = thresholdsFromConfig(cfg);
  const gridSymbols = await gridHeldSymbols(env.DB);
  const flashBars = Math.max(3, Math.ceil(cfg.flashWindowMin / 5) + 1);
  const out: DipReversalScanRow[] = [];

  for (const row of rank.rows) {
    const symbol = row.symbol;
    const wsDecline = row.wsDeclinePct != null ? Number(row.wsDeclinePct) : null;
    const recovery =
      row.recoveryFromWsLowPct != null ? Number(row.recoveryFromWsLowPct) : null;

    let excluded: DipReversalExclusion = null;
    if (isSystemTradeBlockedSymbol(symbol)) excluded = 'system_blocked';
    else if (!row.mid || !bn(row.mid).gt(0)) excluded = 'no_mid';
    else if (gridSymbols.has(symbol)) excluded = 'grid';
    else if (await hasOpenPositionForSymbol(env.DB, symbol)) excluded = 'open_position';
    else if (await inPostExitCooldown(env.DB, symbol, cfg.postExitCooldownMin))
      excluded = 'cooldown';

    const prePass = reversalPrePass(row, wsDecline, recovery, thr);

    let windowDropPct: number | null = null;
    if (excluded !== 'no_mid' && row.mid && (opts.full || prePass)) {
      const klines = await fetchKlinesFromDo(env, symbol, '5m', flashBars);
      if (klines && klines.length >= 2) {
        const highs = klines.map((k) => Number(k.high)).filter((c) => c > 0);
        const lows = klines.map((k) => Number(k.low)).filter((c) => c > 0);
        windowDropPct = windowDrawdownPct(highs, lows, Number(row.mid), cfg.flashWindowMin);
      }
    }

    // 3dk/10dk değişim — yalnızca panelde (full) göster; sniper'a ek DO yükü bindirme.
    let change3mPct: number | null = null;
    let change10mPct: number | null = null;
    if (opts.full && excluded !== 'no_mid' && row.mid) {
      const k1m = await fetchKlinesFromDo(env, symbol, '1m', 12);
      if (k1m && k1m.length >= 2) {
        const closes1m = k1m.map((k) => ({ close: Number(k.close) }));
        const mid = Number(row.mid);
        change3mPct = rollingReturnPct(mid, closes1m, 3);
        change10mPct = rollingReturnPct(mid, closes1m, 10);
      }
    }

    const signal = evaluateDipReversalSignal(
      {
        windowDropPct: windowDropPct ?? 0,
        wsDeclinePct: wsDecline,
        recoveryFromWsLowPct: recovery,
        reversalScore: row.reversalScore,
        secSinceTrough: row.secSinceTrough,
        midSlopeOk: row.midSlopeOk,
      },
      thr,
    );

    const eligible = excluded === null && signal.eligible;
    out.push({
      symbol,
      mid: row.mid ?? null,
      windowDropPct,
      change3mPct,
      change10mPct,
      wsDeclinePct: wsDecline,
      recoveryFromWsLowPct: recovery,
      reversalScore: row.reversalScore,
      secSinceTrough: row.secSinceTrough,
      midSlopeOk: row.midSlopeOk,
      signal,
      excluded,
      eligible,
      score: eligible ? signal.score : null,
    });
  }

  return out;
}
