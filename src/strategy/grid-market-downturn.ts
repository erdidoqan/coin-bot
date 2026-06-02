/**
 * Grid piyasa düşüş modu — yeni grid kurulumunu makro/zayıf breadth koşullarında kilitler.
 * Micro-scalp regimeAllowsEntry ile karışmaması için grid'e özel.
 */
import type { BinanceClient, Kline } from '../exchange/binance';
import {
  detectMarketRegime,
  refreshMarketRegime,
  type MarketRegimeResult,
} from '../indicators/market-regime';
import { closedCandlesOnly, ema } from '../indicators/technical';
import { bn } from '../math/decimal';
import { getRegimeCache, setRegimeCache } from '../db/trade-features';
import { logEvent } from '../db/trade-log';
import type { GridConfig } from '../db/grid';

/** detectMarketRegime varsayılanları 0–1 ölçeğinde; breadthPct 0–100. */
const REGIME_THRESHOLDS_PCT = {
  btcAtrPanicPct: 1.2,
  breadthPanicMax: 35,
  breadthChopMax: 45,
};

export interface GridMarketDownturnThresholds {
  breadthWeakMaxPct: number;
  btc24hPct: number;
  btc15mReturnPct: number;
  btc15mReturnBars: number;
  blockPanic: boolean;
}

export interface GridMarketDownturnMetrics {
  breadthPct: string;
  btc24hChangePct: number | null;
  btc15mReturnPct: number | null;
  btcAtrPct: string | null;
  regime: string;
  ema9Above21: boolean;
}

export interface GridMarketDownturnResult {
  active: boolean;
  reasons: string[];
  metrics: GridMarketDownturnMetrics;
  regime: MarketRegimeResult;
}

export function downturnThresholdsFromGrid(cfg: GridConfig): GridMarketDownturnThresholds {
  return {
    breadthWeakMaxPct: cfg.marketDownturnBreadthMaxPct,
    btc24hPct: cfg.marketDownturnBtc24hPct,
    btc15mReturnPct: cfg.marketDownturnBtc15mReturnPct,
    btc15mReturnBars: 4,
    blockPanic: cfg.marketDownturnBlockPanic,
  };
}

function shortNetReturnPct(closes: number[], bars: number): number | null {
  if (bars < 1 || closes.length < bars + 1) return null;
  const start = closes[closes.length - bars - 1]!;
  const end = closes[closes.length - 1]!;
  if (!(start > 0)) return null;
  return ((end - start) / start) * 100;
}

function btc15mBearish(klines15m: Kline[], returnBars: number): {
  ema9Above21: boolean;
  shortReturnPct: number | null;
} {
  const closed = closedCandlesOnly(klines15m);
  const closes = closed.map((k) => k.close);
  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const ema9Above21 = Boolean(ema9 && ema21 && bn(ema9).gt(ema21));
  const shortReturnPct = shortNetReturnPct(closes, returnBars);
  return { ema9Above21, shortReturnPct };
}

export function evaluateGridMarketDownturn(input: {
  enabled: boolean;
  /** Manuel kilidi — eşiklere bakmadan yeni grid kurulumu kapalı. */
  forceActive?: boolean;
  regime: MarketRegimeResult;
  btcKlines15m: Kline[];
  btc24hChangePct: number | null;
  thresholds?: GridMarketDownturnThresholds;
}): GridMarketDownturnResult {
  const th =
    input.thresholds ??
    ({
      breadthWeakMaxPct: 38,
      btc24hPct: -2.5,
      btc15mReturnPct: -0.8,
      btc15mReturnBars: 4,
      blockPanic: true,
    } satisfies GridMarketDownturnThresholds);

  const breadth = bn(input.regime.breadthPct);
  const { ema9Above21, shortReturnPct } = btc15mBearish(
    input.btcKlines15m,
    th.btc15mReturnBars,
  );

  const metrics: GridMarketDownturnMetrics = {
    breadthPct: input.regime.breadthPct,
    btc24hChangePct: input.btc24hChangePct,
    btc15mReturnPct: shortReturnPct,
    btcAtrPct: input.regime.btcAtrPct,
    regime: input.regime.regime,
    ema9Above21,
  };

  if (input.forceActive) {
    return {
      active: true,
      reasons: ['force_active'],
      metrics,
      regime: input.regime,
    };
  }

  if (!input.enabled) {
    return { active: false, reasons: [], metrics, regime: input.regime };
  }

  const reasons: string[] = [];
  const panic = th.blockPanic && input.regime.regime === 'panic';
  if (panic) reasons.push('panic');

  const breadthWeak = breadth.lte(th.breadthWeakMaxPct);
  if (breadthWeak) reasons.push('breadth_weak');

  const btc24h =
    input.btc24hChangePct != null && input.btc24hChangePct <= th.btc24hPct;
  if (btc24h) reasons.push('btc_24h_drawdown');

  const btc15m =
    !ema9Above21 &&
    shortReturnPct != null &&
    shortReturnPct <= th.btc15mReturnPct;
  if (btc15m) reasons.push('btc_15m_bearish');

  const active =
    panic || (breadthWeak && (btc24h || btc15m));

  return { active, reasons, metrics, regime: input.regime };
}

function findBtc24hChange(tickers: { symbol: string; priceChangePercent: string }[]): number | null {
  const btc = tickers.find((t) => t.symbol === 'BTCUSDT');
  if (!btc) return null;
  const n = Number(btc.priceChangePercent);
  return Number.isFinite(n) ? n : null;
}

export async function resolveGridMarketDownturn(
  env: Env,
  client: BinanceClient,
  cfg: GridConfig,
  watchlistSymbols: string[],
): Promise<GridMarketDownturnResult> {
  const syms = watchlistSymbols.filter((s) => s.endsWith('USDT'));
  const regime = await refreshMarketRegime(client, syms, env);
  const regimePct = detectMarketRegime({
    btcKlines15m: await client.getKlines('BTCUSDT', '15m', 30),
    breadthPct: regime.breadthPct,
    thresholds: REGIME_THRESHOLDS_PCT,
  });
  const mergedRegime: MarketRegimeResult = {
    ...regime,
    regime: regimePct.regime,
    btcAtrPct: regimePct.btcAtrPct,
    detail: { ...regime.detail, ...regimePct.detail },
  };

  let btc24h: number | null = null;
  try {
    const tickers = await client.getTicker24hr();
    btc24h = findBtc24hChange(tickers);
  } catch {
    /* optional */
  }

  const btcKlines = await client.getKlines('BTCUSDT', '15m', 30);
  return evaluateGridMarketDownturn({
    enabled: cfg.marketDownturnEnabled,
    forceActive: cfg.marketDownturnForceActive,
    regime: mergedRegime,
    btcKlines15m: btcKlines,
    btc24hChangePct: btc24h,
    thresholds: downturnThresholdsFromGrid(cfg),
  });
}

/** regime_cache + GRID_MARKET_DOWNTURN geçiş logu. */
export async function syncGridMarketDownturnObservability(
  db: D1Database,
  downturn: GridMarketDownturnResult,
): Promise<void> {
  const prev = await getRegimeCache(db);
  let prevActive = false;
  try {
    if (prev.detail) {
      const d = JSON.parse(prev.detail) as { gridMarketDownturn?: boolean };
      prevActive = Boolean(d.gridMarketDownturn);
    }
  } catch {
    prevActive = false;
  }

  const detail = {
    ...(prev.detail ? (JSON.parse(prev.detail) as Record<string, unknown>) : {}),
    gridMarketDownturn: downturn.active,
    gridMarketDownturnReasons: downturn.reasons,
    breadth: downturn.metrics.breadthPct,
    btc24hChangePct: downturn.metrics.btc24hChangePct,
    btc15mReturnPct: downturn.metrics.btc15mReturnPct,
    btcAtrPct: downturn.metrics.btcAtrPct,
  };

  await setRegimeCache(db, downturn.regime.regime, detail);

  if (downturn.active !== prevActive) {
    await logEvent(db, 'GRID_MARKET_DOWNTURN', {
      active: downturn.active,
      reasons: downturn.reasons,
      metrics: downturn.metrics,
      previous: prevActive,
    });
  }
}

/** setupGrids başında: true → kurulum yapılmaz (GRID_WAIT yazıldı). */
export async function blockSetupForMarketDownturn(
  env: Env,
  client: BinanceClient,
  cfg: GridConfig,
  watchlistSymbols: string[],
  opts?: { manualMode?: boolean },
): Promise<boolean> {
  if (opts?.manualMode && cfg.marketDownturnAllowManual) return false;

  if (cfg.marketDownturnForceActive) {
    await logEvent(env.DB, 'GRID_WAIT', {
      reason: 'force_active',
      reasons: ['force_active'],
      manualLock: true,
    });
    return true;
  }

  if (!cfg.marketDownturnEnabled) return false;

  const downturn = await resolveGridMarketDownturn(env, client, cfg, watchlistSymbols);
  await syncGridMarketDownturnObservability(env.DB, downturn);

  if (!downturn.active) return false;

  const waitReason = downturn.reasons.includes('panic')
    ? 'market_panic'
    : downturn.reasons.includes('force_active')
      ? 'market_downturn'
      : 'market_downturn';

  await logEvent(env.DB, 'GRID_WAIT', {
    reason: waitReason,
    reasons: downturn.reasons,
    breadthPct: downturn.metrics.breadthPct,
    btc24hChangePct: downturn.metrics.btc24hChangePct,
    btc15mReturnPct: downturn.metrics.btc15mReturnPct,
    btcAtrPct: downturn.metrics.btcAtrPct,
    regime: downturn.metrics.regime,
  });
  return true;
}

export function filterPoolForMarketDownturn(
  pool: Array<{ symbol: string; priceChangePercent: number }>,
  downturn: GridMarketDownturnResult,
  minChangePct: number,
): { kept: typeof pool; rejected: Array<{ symbol: string; reason: string }> } {
  if (!downturn.active) return { kept: pool, rejected: [] };
  const kept: typeof pool = [];
  const rejected: Array<{ symbol: string; reason: string }> = [];
  for (const t of pool) {
    if (t.priceChangePercent < minChangePct) {
      rejected.push({ symbol: t.symbol, reason: 'market_downturn_weak_symbol' });
    } else {
      kept.push(t);
    }
  }
  return { kept, rejected };
}
