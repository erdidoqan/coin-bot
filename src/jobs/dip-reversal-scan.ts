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
import { listOpenPositions } from '../db/open-positions';
import type { TickScanRow } from '../durable-objects/market-data-do';
import { fetchKlinesFromDo, fetchTickRank } from '../exchange/market-data-client';
import {
  evaluateDipReversalSignal,
  windowDrawdownPct,
  type DipReversalSignal,
  type DipReversalThresholds,
} from '../strategy/dip-reversal';
import {
  resolveAdaptiveThresholds,
  type DipReversalAdaptContext,
  type DipReversalMode,
} from '../strategy/dip-reversal-adapt';
import type { DipReversalAdaptSnapshot } from './dip-reversal-context';
import { windowDropPctFromCloses } from '../strategy/grid-flash-drop';
import { rollingReturnPct } from '../strategy/grid-readiness';
import { isSystemTradeBlockedSymbol } from '../config/system-trade-rules';
import { bn } from '../math/decimal';

/** Live panel: 1m kline üst sınırı (reversalScore sırası + tüm prePass birleşimi). */
export const DIP_LIVE_KLINE_MAX = 30;

/** 1m kapanış sayısı — 3/10/30 dk getiri (ref = length - 1 - barsAgo). */
const DIP_1M_BARS_FOR_ROLLING = 35;

/** Canlı panel: paralel DO kline isteği (sıralı 100×2 istek timeout yapıyordu). */
const DIP_KLINE_FETCH_CONCURRENCY = 10;

interface DipKlineMetrics {
  windowDropPct: number | null;
  change1mPct: number | null;
  change3mPct: number | null;
  change10mPct: number | null;
  change30mPct: number | null;
  flashDrop3mPct: number | null;
}

async function fetchDipKlineMetrics(
  env: Env,
  symbol: string,
  mid: number,
  cfg: DipReversalConfig,
  flashBars: number,
  needCapitulation: boolean,
  need1m: boolean,
): Promise<DipKlineMetrics> {
  const empty: DipKlineMetrics = {
    windowDropPct: null,
    change1mPct: null,
    change3mPct: null,
    change10mPct: null,
    change30mPct: null,
    flashDrop3mPct: null,
  };
  if (!needCapitulation && !need1m) return empty;

  const [klines5m, klines1m] = await Promise.all([
    needCapitulation ? fetchKlinesFromDo(env, symbol, '5m', flashBars) : Promise.resolve(null),
    need1m ? fetchKlinesFromDo(env, symbol, '1m', DIP_1M_BARS_FOR_ROLLING) : Promise.resolve(null),
  ]);

  const out = { ...empty };
  if (needCapitulation && klines5m && klines5m.length >= 2) {
    const highs = klines5m.map((k) => Number(k.high)).filter((c) => c > 0);
    const lows = klines5m.map((k) => Number(k.low)).filter((c) => c > 0);
    out.windowDropPct = windowDrawdownPct(highs, lows, mid, cfg.flashWindowMin);
  }
  if (need1m && klines1m && klines1m.length >= 2) {
    const closes1m = klines1m.map((k) => ({ close: Number(k.close) }));
    const closes = closes1m.map((k) => Number(k.close)).filter((c) => c > 0);
    out.change1mPct = rollingReturnPct(mid, closes1m, 1);
    out.change3mPct = rollingReturnPct(mid, closes1m, 3);
    out.change10mPct = rollingReturnPct(mid, closes1m, 10);
    out.change30mPct = rollingReturnPct(mid, closes1m, 30);
    if (closes.length >= 2) {
      out.flashDrop3mPct = Number(windowDropPctFromCloses(closes, mid, 3).toFixed(2));
    }
  }
  return out;
}

async function enrichKlinesInParallel(
  env: Env,
  cfg: DipReversalConfig,
  flashBars: number,
  jobs: Array<{
    outIndex: number;
    symbol: string;
    mid: number;
    needCapitulation: boolean;
    need1m: boolean;
  }>,
  out: DipReversalScanRow[],
  thr: DipReversalThresholds,
): Promise<void> {
  for (let i = 0; i < jobs.length; i += DIP_KLINE_FETCH_CONCURRENCY) {
    const batch = jobs.slice(i, i + DIP_KLINE_FETCH_CONCURRENCY);
    await Promise.all(
      batch.map(async (job) => {
        const metrics = await fetchDipKlineMetrics(
          env,
          job.symbol,
          job.mid,
          cfg,
          flashBars,
          job.needCapitulation,
          job.need1m,
        );
        const prev = out[job.outIndex]!;
        const signal = evaluateDipReversalSignal(
          {
            windowDropPct: metrics.windowDropPct ?? 0,
            wsDeclinePct: prev.wsDeclinePct,
            recoveryFromWsLowPct: prev.recoveryFromWsLowPct,
            reversalScore: prev.reversalScore,
            secSinceTrough: prev.secSinceTrough,
            midSlopeOk: prev.midSlopeOk,
          },
          thr,
        );
        const eligible = prev.excluded === null && signal.eligible;
        out[job.outIndex] = {
          ...prev,
          ...metrics,
          signal,
          eligible,
          score: eligible ? signal.score : null,
        };
      }),
    );
  }
}

export type DipReversalExclusion =
  | 'system_blocked'
  | 'no_mid'
  | 'grid'
  | 'open_position'
  | 'cooldown'
  | null;

export type DipReversalPanelMode = 'live' | 'full';

export interface DipReversalScanOpts {
  /** `full` = tüm satırlarda capitulation; `live` = top-K 1m + prePass 5m (panel hızlı poll). */
  panelMode?: DipReversalPanelMode;
  /** Geriye uyumluluk: `true` → full, `false` → live. */
  full?: boolean;
  adaptSnapshot?: DipReversalAdaptSnapshot | null;
  /** Verilmişse ikinci `fetchTickRank` atlanır. */
  rank?: { rows: TickScanRow[] } | null;
}

export interface DipReversalScanRow {
  symbol: string;
  mid: string | null;
  windowDropPct: number | null;
  change1mPct: number | null;
  change3mPct: number | null;
  change10mPct: number | null;
  change30mPct: number | null;
  /** 1m kapanış: son 3 dk tepe → şimdi (ani flash). */
  flashDrop3mPct: number | null;
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

export interface DipReversalScanAdaptMeta {
  mode: DipReversalMode;
  context: DipReversalAdaptContext;
  baseThresholds: DipReversalThresholds;
  effectiveThresholds: DipReversalThresholds;
}

export interface DipReversalScanResult {
  rows: DipReversalScanRow[];
  adapt: DipReversalScanAdaptMeta | null;
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

export function resolvePanelMode(opts: DipReversalScanOpts): DipReversalPanelMode {
  if (opts.panelMode) return opts.panelMode;
  if (opts.full === true) return 'full';
  if (opts.full === false) return 'live';
  return 'full';
}

export async function gridHeldSymbols(db: D1Database): Promise<Set<string>> {
  const { results } = await db
    .prepare("SELECT DISTINCT symbol FROM grid_state WHERE status IN ('ACTIVE','RECOVERING')")
    .all<{ symbol: string }>();
  return new Set((results ?? []).map((r) => r.symbol));
}

/** Son X dk içinde kapanan dip_reversal sembolleri (panel/sniper batch). */
export async function dipReversalCooldownSymbols(
  db: D1Database,
  minutes: number,
): Promise<Set<string>> {
  if (minutes <= 0) return new Set();
  const { results } = await db
    .prepare(
      `SELECT payload FROM trade_log
       WHERE event_type = 'POSITION_CLOSED'
         AND payload LIKE '%"entry_mode":"dip_reversal"%'
         AND created_at >= datetime('now', ?)
       ORDER BY id DESC LIMIT 200`,
    )
    .bind(`-${minutes} minutes`)
    .all<{ payload: string }>();
  const out = new Set<string>();
  for (const r of results ?? []) {
    try {
      const d = JSON.parse(r.payload) as { symbol?: string };
      if (typeof d.symbol === 'string' && d.symbol) out.add(d.symbol);
    } catch {
      /* atla */
    }
  }
  return out;
}

export async function dipReversalOpenSymbols(db: D1Database): Promise<Set<string>> {
  const rows = await listOpenPositions(db, { entryMode: 'dip_reversal' });
  return new Set(rows.map((p) => p.symbol));
}

/** Tek sembol cooldown (test / nadir kullanım). */
export async function inPostExitCooldown(
  db: D1Database,
  symbol: string,
  minutes: number,
): Promise<boolean> {
  if (minutes <= 0) return false;
  const set = await dipReversalCooldownSymbols(db, minutes);
  return set.has(symbol);
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

export function resolveScanThresholds(
  cfg: DipReversalConfig,
  adaptSnapshot: DipReversalAdaptSnapshot | null | undefined,
): { thr: DipReversalThresholds; adapt: DipReversalScanAdaptMeta | null } {
  const base = thresholdsFromConfig(cfg);
  if (!cfg.adapt.enabled || !adaptSnapshot) {
    return { thr: base, adapt: null };
  }
  const effectiveThresholds = resolveAdaptiveThresholds(
    base,
    adaptSnapshot.mode,
    cfg.adapt.thresholds,
  );
  return {
    thr: effectiveThresholds,
    adapt: {
      mode: adaptSnapshot.mode,
      context: adaptSnapshot.context,
      baseThresholds: base,
      effectiveThresholds,
    },
  };
}

function buildLiveKlineSymbolSet(
  rankRows: TickScanRow[],
  prePassBySymbol: Map<string, boolean>,
  /** Açık dip pozisyonları — panelde üstte sabitlensin diye canlı kline her zaman çekilir. */
  trackSymbols?: Iterable<string>,
): Set<string> {
  const set = new Set<string>();
  for (const row of rankRows.slice(0, DIP_LIVE_KLINE_MAX)) {
    set.add(row.symbol);
  }
  for (const row of rankRows) {
    if (prePassBySymbol.get(row.symbol)) set.add(row.symbol);
  }
  if (trackSymbols) {
    for (const sym of trackSymbols) set.add(sym);
  }
  return set;
}

export async function scanDipReversalCandidates(
  env: Env,
  cfg: DipReversalConfig,
  opts: DipReversalScanOpts = {},
): Promise<DipReversalScanResult> {
  const panelMode = resolvePanelMode(opts);
  const tickCfg = await getTickScalpConfig(env.DB, env);
  const rank = opts.rank ?? (await fetchTickRank(env, tickCfg));
  if (!rank || rank.rows.length === 0) return { rows: [], adapt: null };

  const { thr, adapt } = resolveScanThresholds(cfg, opts.adaptSnapshot);
  const [gridSymbols, openSymbols, cooldownSymbols] = await Promise.all([
    gridHeldSymbols(env.DB),
    dipReversalOpenSymbols(env.DB),
    dipReversalCooldownSymbols(env.DB, cfg.postExitCooldownMin),
  ]);
  const flashBars = Math.max(3, Math.ceil(cfg.flashWindowMin / 5) + 1);

  const prePassBySymbol = new Map<string, boolean>();
  const prelim: Array<{
    row: TickScanRow;
    wsDecline: number | null;
    recovery: number | null;
    excluded: DipReversalExclusion;
    prePass: boolean;
  }> = [];

  for (const row of rank.rows) {
    const symbol = row.symbol;
    const wsDecline = row.wsDeclinePct != null ? Number(row.wsDeclinePct) : null;
    const recovery =
      row.recoveryFromWsLowPct != null ? Number(row.recoveryFromWsLowPct) : null;

    let excluded: DipReversalExclusion = null;
    if (isSystemTradeBlockedSymbol(symbol)) excluded = 'system_blocked';
    else if (!row.mid || !bn(row.mid).gt(0)) excluded = 'no_mid';
    else if (gridSymbols.has(symbol)) excluded = 'grid';
    else if (openSymbols.has(symbol)) excluded = 'open_position';
    else if (cooldownSymbols.has(symbol)) excluded = 'cooldown';

    const prePass = reversalPrePass(row, wsDecline, recovery, thr);
    prePassBySymbol.set(symbol, prePass);
    prelim.push({ row, wsDecline, recovery, excluded, prePass });
  }

  const liveKlineSymbols =
    panelMode === 'live'
      ? buildLiveKlineSymbolSet(rank.rows, prePassBySymbol, openSymbols)
      : null;

  const out: DipReversalScanRow[] = [];
  const klineJobs: Array<{
    outIndex: number;
    symbol: string;
    mid: number;
    needCapitulation: boolean;
    need1m: boolean;
  }> = [];

  for (const { row, wsDecline, recovery, excluded, prePass } of prelim) {
    const symbol = row.symbol;
    const canFetchMid = excluded !== 'no_mid' && row.mid;
    const inLiveKlineSet = liveKlineSymbols?.has(symbol) ?? false;
    const needCapitulation =
      canFetchMid && (panelMode === 'full' ? true : prePass || inLiveKlineSet);
    const need1m = canFetchMid && (panelMode === 'full' ? true : inLiveKlineSet);

    const signal = evaluateDipReversalSignal(
      {
        windowDropPct: 0,
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
      windowDropPct: null,
      change1mPct: null,
      change3mPct: null,
      change10mPct: null,
      change30mPct: null,
      flashDrop3mPct: null,
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

    if (needCapitulation || need1m) {
      klineJobs.push({
        outIndex: out.length - 1,
        symbol,
        mid: Number(row.mid),
        needCapitulation: Boolean(needCapitulation),
        need1m: Boolean(need1m),
      });
    }
  }

  if (klineJobs.length > 0) {
    await enrichKlinesInParallel(env, cfg, flashBars, klineJobs, out, thr);
  }

  return { rows: out, adapt };
}
