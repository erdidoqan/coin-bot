import { bn } from '../math/decimal';
import type { TradingGateway } from '../exchange/gateway';
import { isPullbackNearSma, sma } from './technical';

export interface SmaRanking {
  symbol: string;
  lastClose: string;
  sma20: string;
  /** |fiyat − SMA| / SMA × 100 */
  smaDeviationPct: string;
  nearSma: boolean;
}

export function absoluteSmaDeviationPct(price: string, smaValue: string): string {
  const base = bn(smaValue);
  if (base.isZero()) return '999';
  return bn(price).minus(base).abs().dividedBy(base).times(100).toFixed(4);
}

export async function fetchSmaRanking(
  gateway: TradingGateway,
  symbol: string,
  tolerancePct: string,
  useLivePrice = false,
): Promise<SmaRanking | null> {
  const klines = await gateway.binance.getKlines(symbol, '15m', 30);
  const closes = klines.map((k) => k.close);
  const sma20 = sma(closes, 20);
  if (!sma20) return null;

  let lastClose = closes[closes.length - 1];
  if (!lastClose) return null;

  if (useLivePrice) {
    try {
      lastClose = await gateway.binance.getSymbolPrice(symbol);
    } catch {
      /* son kline kapanışı */
    }
  }

  const smaDeviationPct = absoluteSmaDeviationPct(lastClose, sma20);
  return {
    symbol,
    lastClose,
    sma20,
    smaDeviationPct,
    nearSma: isPullbackNearSma(lastClose, sma20, tolerancePct),
  };
}

export async function scanWatchlistSmaRankings(
  gateway: TradingGateway,
  symbols: string[],
  tolerancePct: string,
  useLivePrice = false,
): Promise<SmaRanking[]> {
  const results = await Promise.all(
    symbols.map((symbol) => fetchSmaRanking(gateway, symbol, tolerancePct, useLivePrice)),
  );
  return results.filter((r): r is SmaRanking => r !== null);
}

export type RotationSkipReason =
  | 'window_closed'
  | 'no_watchlist'
  | 'no_rankings'
  | 'no_near_sma_candidate'
  | 'improvement_below_threshold';

export function explainRotationSkip(
  activeSymbol: string,
  rankings: SmaRanking[],
  minImprovementPct: string,
  effectiveMinImprovementPct?: string,
): { reason: RotationSkipReason; detail: Record<string, string> } | null {
  const minPct = effectiveMinImprovementPct ?? minImprovementPct;
  const active = rankings.find((r) => r.symbol === activeSymbol);
  const activeDev = active?.smaDeviationPct ?? '999';

  let best: SmaRanking | null = null;
  for (const r of rankings) {
    if (!r.nearSma || r.symbol === activeSymbol) continue;
    if (!best || bn(r.smaDeviationPct).lt(best.smaDeviationPct)) best = r;
  }

  if (!best) {
    return {
      reason: 'no_near_sma_candidate',
      detail: {
        activeSymbol,
        activeDeviation: activeDev,
        nearSmaCount: String(rankings.filter((r) => r.nearSma).length),
      },
    };
  }

  const improvement = bn(activeDev).minus(best.smaDeviationPct);
  if (improvement.lt(minPct)) {
    return {
      reason: 'improvement_below_threshold',
      detail: {
        activeSymbol,
        activeDeviation: activeDev,
        bestSymbol: best.symbol,
        bestDeviation: best.smaDeviationPct,
        improvementPct: improvement.toFixed(4),
        requiredPct: minPct,
        configuredMinPct: minImprovementPct,
      },
    };
  }

  return null;
}

export interface BetterSmaCandidate {
  symbol: string;
  smaDeviationPct: string;
  index: number;
}

export function pickBetterSmaCandidate(
  activeSymbol: string,
  rankings: SmaRanking[],
  symbolOrder: string[],
  minImprovementPct: string,
  effectiveMinImprovementPct?: string,
): BetterSmaCandidate | null {
  const minPct = effectiveMinImprovementPct ?? minImprovementPct;
  const active = rankings.find((r) => r.symbol === activeSymbol);
  const activeDev = active?.smaDeviationPct ?? '999';

  let best: SmaRanking | null = null;
  for (const r of rankings) {
    if (!r.nearSma || r.symbol === activeSymbol) continue;
    if (!best || bn(r.smaDeviationPct).lt(best.smaDeviationPct)) {
      best = r;
    }
  }
  if (!best) return null;

  const improvement = bn(activeDev).minus(best.smaDeviationPct);
  if (improvement.lt(minPct)) return null;

  const index = symbolOrder.indexOf(best.symbol);
  if (index < 0) return null;

  return { symbol: best.symbol, smaDeviationPct: best.smaDeviationPct, index };
}

export function minutesSinceOpenedAt(openedAt: string | null): number | null {
  if (!openedAt) return null;
  const normalized = openedAt.includes('T') ? openedAt : `${openedAt.replace(' ', 'T')}Z`;
  const opened = Date.parse(normalized);
  if (Number.isNaN(opened)) return null;
  return (Date.now() - opened) / 60_000;
}
