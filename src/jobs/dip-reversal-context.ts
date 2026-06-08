/**
 * Dip Reversal — rejim bağlamı (BTC 15m + watchlist breadth).
 * DO'dan okur; paylaşılan detectMarketRegime / fetchRegimeFromDo kullanılmaz (breadth ölçek hatası).
 */
import {
  fetchBtc15mKlinesForAdapt,
  fetchMomentumBreadthFromDo,
  fetchTickersFromDo,
  fetchTickRank,
} from '../exchange/market-data-client';
import { getTickScalpConfig } from '../db/bot-config';
import type { TickScanRow } from '../durable-objects/market-data-do';
import type { DipReversalAdaptThresholds } from '../strategy/dip-reversal-adapt';
import type { DipReversalAdaptConfig } from '../db/dip-reversal';
import {
  adaptEntryBlockReason,
  classifyDipReversalMode,
  resolveTrendWithMomentum,
  type DipReversalAdaptContext,
  type DipReversalMode,
  type DipReversalTrend,
} from '../strategy/dip-reversal-adapt';
import { atrPctFromKlines, closedCandlesOnly, ema } from '../indicators/technical';
import { logEvent } from '../db/trade-log';

function breadthPctFromTickers(
  tickers: Array<{ symbol: string; priceChangePercent: string }>,
  symbols: string[],
): number {
  if (symbols.length === 0) return 0;
  const set = new Set(symbols);
  let up = 0;
  let total = 0;
  for (const t of tickers) {
    if (!set.has(t.symbol)) continue;
    total++;
    if (Number(t.priceChangePercent) > 0) up++;
  }
  if (total === 0) return 0;
  return (up / total) * 100;
}

export interface DipReversalAdaptSnapshot {
  context: DipReversalAdaptContext;
  mode: DipReversalMode;
}

/** Momentum breadth lookback: ~15dk hedef. 1m daha güvenilir (DO derin tutar, restart sonrası hızlı dolar). */
function momentumBreadthLookback(interval: string): number {
  if (interval === '1m') return 15;
  if (interval === '5m') return 3;
  return 1; // 15m
}
const BTC_TREND_LOOKBACK = 4;

export async function getDipReversalAdaptContext(
  env: Env,
  adapt: DipReversalAdaptConfig,
  opts?: { rank?: { rows: TickScanRow[] } | null },
): Promise<DipReversalAdaptSnapshot | null> {
  const adaptThr = adapt.thresholds;
  const tickCfg = await getTickScalpConfig(env.DB, env);
  const rank = opts?.rank ?? (await fetchTickRank(env, tickCfg));
  const watchSymbols = rank?.rows.map((r) => r.symbol) ?? [];

  const [btcKlines, tickers, momentumBreadth] = await Promise.all([
    fetchBtc15mKlinesForAdapt(env),
    fetchTickersFromDo(env, { scope: 'watchlist' }),
    fetchMomentumBreadthFromDo(env, {
      interval: adapt.momentumBreadthInterval,
      lookback: momentumBreadthLookback(adapt.momentumBreadthInterval),
      atrMult: adapt.momentumBreadthAtrMult,
      symbols: watchSymbols,
    }),
  ]);

  if (!btcKlines) return null;

  const closed = closedCandlesOnly(btcKlines);
  const closes = closed.map((k) => k.close);
  const ema9Str = ema(closes, 9);
  const ema21Str = ema(closes, 21);
  const ema9 = ema9Str != null ? Number(ema9Str) : null;
  const ema21 = ema21Str != null ? Number(ema21Str) : null;
  const atrStr = atrPctFromKlines(closed, 14);
  const atrPct = atrStr != null ? Number(atrStr) : null;

  // #3 BTC trend momentum override (shadow): trendShadow her zaman hesaplanır,
  // kararda kullanım btcMomentumEnabled flag'ine bağlı.
  const closesNum = closes.map((c) => Number(c));
  const { trend: trendShadow, emaSepPct, btcMomentumPct } = resolveTrendWithMomentum(
    ema9,
    ema21,
    adaptThr.emaMinSepPct,
    closesNum,
    atrPct,
    adaptThr.btcMomentumAtrMult,
    BTC_TREND_LOOKBACK,
  );
  // EMA-only trend (eski mantık) — btcMomentum kapalıyken karar bununla.
  const { trend: trendEmaOnly } = resolveTrendWithMomentum(
    ema9,
    ema21,
    adaptThr.emaMinSepPct,
    closesNum,
    atrPct,
    Number.POSITIVE_INFINITY, // override asla tetiklenmez → saf EMA trend
    BTC_TREND_LOOKBACK,
  );
  const trendUsed: DipReversalTrend = adapt.btcMomentumEnabled ? trendShadow : trendEmaOnly;

  // #1 momentum breadth (shadow): momentumBreadthPct her zaman set; kararda
  // kullanım breadthBasis flag'ine bağlı. Momentum verisi yoksa 24h'e düş.
  const breadth24h =
    tickers && watchSymbols.length > 0
      ? breadthPctFromTickers(tickers, watchSymbols)
      : 0;
  const momentumBreadthPct = momentumBreadth?.breadthPct ?? null;
  const breadthUsed =
    adapt.breadthBasis === 'momentum' && momentumBreadthPct != null
      ? momentumBreadthPct
      : breadth24h;

  const riskOff = breadthUsed < adaptThr.downtrendBreadthMax;

  const context: DipReversalAdaptContext = {
    ema9,
    ema21,
    emaSepPct,
    trend: trendUsed,
    atrPct,
    breadthPct: breadthUsed,
    riskOff,
    momentumBreadthPct,
    breadthBasisLive: adapt.breadthBasis,
    trendShadow,
    btcMomentumPct,
  };

  const mode = classifyDipReversalMode(context, adaptThr);
  return { context, mode };
}
