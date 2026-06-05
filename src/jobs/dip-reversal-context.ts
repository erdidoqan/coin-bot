/**
 * Dip Reversal — rejim bağlamı (BTC 15m + watchlist breadth).
 * DO'dan okur; paylaşılan detectMarketRegime / fetchRegimeFromDo kullanılmaz (breadth ölçek hatası).
 */
import {
  fetchBtc15mKlinesForAdapt,
  fetchTickersFromDo,
  fetchTickRank,
} from '../exchange/market-data-client';
import { getTickScalpConfig } from '../db/bot-config';
import type { TickScanRow } from '../durable-objects/market-data-do';
import type { DipReversalAdaptThresholds } from '../strategy/dip-reversal-adapt';
import {
  classifyDipReversalMode,
  resolveTrendFromEma,
  type DipReversalAdaptContext,
  type DipReversalMode,
} from '../strategy/dip-reversal-adapt';
import { atrPctFromKlines, closedCandlesOnly, ema } from '../indicators/technical';

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

export async function getDipReversalAdaptContext(
  env: Env,
  adaptThr: DipReversalAdaptThresholds,
  opts?: { rank?: { rows: TickScanRow[] } | null },
): Promise<DipReversalAdaptSnapshot | null> {
  const tickCfg = await getTickScalpConfig(env.DB, env);
  const rank = opts?.rank ?? (await fetchTickRank(env, tickCfg));
  const watchSymbols = rank?.rows.map((r) => r.symbol) ?? [];

  const [btcKlines, tickers] = await Promise.all([
    fetchBtc15mKlinesForAdapt(env),
    fetchTickersFromDo(env, { scope: 'watchlist' }),
  ]);

  if (!btcKlines) return null;

  const closed = closedCandlesOnly(btcKlines);
  const closes = closed.map((k) => k.close);
  const ema9Str = ema(closes, 9);
  const ema21Str = ema(closes, 21);
  const ema9 = ema9Str != null ? Number(ema9Str) : null;
  const ema21 = ema21Str != null ? Number(ema21Str) : null;
  const { trend, emaSepPct } = resolveTrendFromEma(
    ema9,
    ema21,
    adaptThr.emaMinSepPct,
  );
  const atrStr = atrPctFromKlines(closed, 14);
  const atrPct = atrStr != null ? Number(atrStr) : null;

  const breadthPct =
    tickers && watchSymbols.length > 0
      ? breadthPctFromTickers(tickers, watchSymbols)
      : 0;

  const riskOff = breadthPct < adaptThr.downtrendBreadthMax;

  const context: DipReversalAdaptContext = {
    ema9,
    ema21,
    emaSepPct,
    trend,
    atrPct,
    breadthPct,
    riskOff,
  };

  const mode = classifyDipReversalMode(context, adaptThr);
  return { context, mode };
}
