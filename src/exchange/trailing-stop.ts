import type { SymbolInfo } from './binance';
import { BigNumber, bn, formatPrice } from '../math/decimal';

/** Spot trailing: %0.5 → 50 BIPS (1 BIP = 0.01%). */
export function percentToTrailingDeltaBips(percent: string): number {
  const pct = bn(percent);
  if (!pct.isFinite() || pct.lte(0)) {
    throw new Error(`Invalid trailing percent: ${percent}`);
  }
  return pct.times(100).integerValue(BigNumber.ROUND_HALF_UP).toNumber();
}

export interface TrailingDeltaFilterBelow {
  minTrailingBelowDelta: number;
  maxTrailingBelowDelta: number;
}

export interface TrailingDeltaFilterFull extends TrailingDeltaFilterBelow {
  minTrailingAboveDelta: number;
  maxTrailingAboveDelta: number;
}

export function parseTrailingDeltaFilter(
  filters: SymbolInfo['filters'],
): TrailingDeltaFilterBelow | null {
  const full = parseTrailingDeltaFilterFull(filters);
  if (!full) return null;
  return {
    minTrailingBelowDelta: full.minTrailingBelowDelta,
    maxTrailingBelowDelta: full.maxTrailingBelowDelta,
  };
}

export function parseTrailingDeltaFilterFull(
  filters: SymbolInfo['filters'],
): TrailingDeltaFilterFull | null {
  const f = filters.find((x) => x.filterType === 'TRAILING_DELTA');
  if (!f) return null;
  const minBelow = Number(f.minTrailingBelowDelta);
  const maxBelow = Number(f.maxTrailingBelowDelta);
  const minAbove = Number(f.minTrailingAboveDelta);
  const maxAbove = Number(f.maxTrailingAboveDelta);
  if (
    !Number.isFinite(minBelow) ||
    !Number.isFinite(maxBelow) ||
    !Number.isFinite(minAbove) ||
    !Number.isFinite(maxAbove)
  ) {
    return null;
  }
  return {
    minTrailingBelowDelta: minBelow,
    maxTrailingBelowDelta: maxBelow,
    minTrailingAboveDelta: minAbove,
    maxTrailingAboveDelta: maxAbove,
  };
}

/** SELL + STOP_LOSS trailing: minTrailingBelowDelta ≤ delta ≤ maxTrailingBelowDelta */
export function clampTrailingDeltaForSell(
  deltaBips: number,
  filter: TrailingDeltaFilterBelow | null,
): number {
  const rounded = Math.round(deltaBips);
  if (!filter) return rounded;
  return Math.max(
    filter.minTrailingBelowDelta,
    Math.min(filter.maxTrailingBelowDelta, rounded),
  );
}

/** SELL + TAKE_PROFIT trailing: minTrailingAboveDelta ≤ delta ≤ maxTrailingAboveDelta */
export function clampTrailingDeltaForTakeProfitSell(
  deltaBips: number,
  filter: TrailingDeltaFilterFull | null,
): number {
  const rounded = Math.round(deltaBips);
  if (!filter) return rounded;
  return Math.max(
    filter.minTrailingAboveDelta,
    Math.min(filter.maxTrailingAboveDelta, rounded),
  );
}

/** Maliyet + aktivasyon% → Binance stopPrice (PRICE_FILTER tick). */
export function computeActivationStopPrice(
  avgCost: string,
  activationPct: string,
  tickSize: string,
): string {
  const raw = bn(avgCost).times(bn(1).plus(bn(activationPct).dividedBy(100)));
  return formatPrice(raw.toFixed(18), tickSize);
}

export interface TieredTrailingParams {
  stopPrice: string;
  trailingDeltaBips: number;
}

export function resolveTieredTrailing(
  avgCost: string,
  activationPct: string,
  tightCallbackPct: string,
  tickSize: string,
  symbolFilters: SymbolInfo['filters'],
): TieredTrailingParams {
  const stopPrice = computeActivationStopPrice(avgCost, activationPct, tickSize);
  const raw = percentToTrailingDeltaBips(tightCallbackPct);
  const trailFilter = parseTrailingDeltaFilterFull(symbolFilters);
  const trailingDeltaBips = clampTrailingDeltaForTakeProfitSell(raw, trailFilter);
  return { stopPrice, trailingDeltaBips };
}
