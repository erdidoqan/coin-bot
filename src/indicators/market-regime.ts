import type { BinanceClient, Kline, Ticker24hr } from '../exchange/binance';
import { atrPctFromKlines, closedCandlesOnly, ema } from './technical';
import { bn } from '../math/decimal';

export type MarketRegime = 'trend' | 'chop' | 'panic' | 'low_liquidity';

export interface MarketRegimeResult {
  regime: MarketRegime;
  btcAtrPct: string | null;
  breadthPct: string;
  detail: Record<string, string | number | boolean>;
}

export interface MarketRegimeThresholds {
  btcAtrPanicPct: number;
  breadthPanicMax: number;
  breadthChopMax: number;
}

const DEFAULT_THRESHOLDS: MarketRegimeThresholds = {
  btcAtrPanicPct: 1.2,
  breadthPanicMax: 0.35,
  breadthChopMax: 0.45,
};

export function computeBreadthPct(tickers: Ticker24hr[], symbols: string[]): string {
  if (symbols.length === 0) return '0';
  const set = new Set(symbols);
  let up = 0;
  let total = 0;
  for (const t of tickers) {
    if (!set.has(t.symbol)) continue;
    total++;
    if (bn(t.priceChangePercent).gt(0)) up++;
  }
  if (total === 0) return '0';
  return bn(up).dividedBy(total).times(100).toFixed(2);
}

export function detectMarketRegime(input: {
  btcKlines15m: Kline[];
  breadthPct: string;
  thresholds?: MarketRegimeThresholds;
}): MarketRegimeResult {
  const th = input.thresholds ?? DEFAULT_THRESHOLDS;
  const closed = closedCandlesOnly(input.btcKlines15m);
  const btcAtrPct = atrPctFromKlines(closed, 14);
  const closes = closed.map((k) => k.close);
  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const breadth = bn(input.breadthPct);

  const ema9Above21 = Boolean(ema9 && ema21 && bn(ema9).gt(ema21));

  let regime: MarketRegime = 'trend';
  if (btcAtrPct && bn(btcAtrPct).gte(th.btcAtrPanicPct) && breadth.lte(th.breadthPanicMax)) {
    regime = 'panic';
  } else if (breadth.lte(th.breadthChopMax)) {
    // Chop = evren genişliği zayıf; tek başına BTC 15m EMA altında kalmak girişi kilitlemez.
    regime = 'chop';
  }

  return {
    regime,
    btcAtrPct,
    breadthPct: input.breadthPct,
    detail: {
      ema9Above21,
      breadth: breadth.toNumber(),
      btcBearish15m: !ema9Above21,
    },
  };
}

export async function refreshMarketRegime(
  client: BinanceClient,
  watchlistSymbols: string[],
  env?: Env,
): Promise<MarketRegimeResult> {
  if (env?.MARKET_DATA) {
    const { fetchRegimeFromDo } = await import('../exchange/market-data-client');
    const fromDo = await fetchRegimeFromDo(env, watchlistSymbols);
    if (fromDo) return fromDo;
  }
  const [btcKlines, tickers] = await Promise.all([
    client.getKlines('BTCUSDT', '15m', 30),
    client.getTicker24hr(),
  ]);
  const breadthPct = computeBreadthPct(tickers, watchlistSymbols);
  return detectMarketRegime({ btcKlines15m: btcKlines, breadthPct });
}

export function regimeAllowsEntry(
  regime: MarketRegime,
  phase3Enabled: boolean,
): { allowed: boolean; reason: string | null } {
  if (!phase3Enabled) return { allowed: true, reason: null };
  if (regime === 'panic' || regime === 'low_liquidity') {
    return { allowed: false, reason: regime };
  }
  if (regime === 'chop') {
    return { allowed: false, reason: 'chop' };
  }
  return { allowed: true, reason: null };
}
