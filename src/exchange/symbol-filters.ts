import type { SymbolInfo } from './binance';
import { bn, floorToStep, formatPrice, formatQuantity } from '../math/decimal';

export interface ParsedSymbolFilters {
  stepSize: string;
  tickSize: string;
  minQty: string;
  maxQty: string;
  minNotional: string;
}

function filterValue(filters: SymbolInfo['filters'], type: string, key: string): string {
  const f = filters.find((x) => x.filterType === type);
  return f?.[key] ?? '0';
}

/** Ham filtre değeri (yoksa undefined). filterValue '0' default'u truthy olduğundan
 * NOTIONAL/MIN_NOTIONAL `||` zincirini bozuyordu; bunun için ayrı okuma. */
function rawFilterValue(
  filters: SymbolInfo['filters'],
  type: string,
  key: string,
): string | undefined {
  return filters.find((x) => x.filterType === type)?.[key];
}

export function parseSymbolFilters(symbolInfo: SymbolInfo): ParsedSymbolFilters {
  const filters = symbolInfo.filters;
  // Modern parite: NOTIONAL filtresi; eski parite: MIN_NOTIONAL. İkisinden de
  // mevcut olan(lar)ın en büyüğünü al (güvenli taraf). filterValue '0' döndürüp
  // gerçek NOTIONAL kapısını gizliyordu -> seviye başı $4 emir -> NOTIONAL reddi.
  const notionalCandidates = [
    rawFilterValue(filters, 'NOTIONAL', 'minNotional'),
    rawFilterValue(filters, 'MIN_NOTIONAL', 'minNotional'),
  ]
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n) && n > 0);
  const minNotional = notionalCandidates.length ? String(Math.max(...notionalCandidates)) : '0';

  return {
    stepSize: filterValue(filters, 'LOT_SIZE', 'stepSize'),
    tickSize: filterValue(filters, 'PRICE_FILTER', 'tickSize'),
    minQty: filterValue(filters, 'LOT_SIZE', 'minQty'),
    maxQty: filterValue(filters, 'LOT_SIZE', 'maxQty'),
    minNotional,
  };
}

export function meetsMinNotional(quoteUsdt: string, minNotional: string): boolean {
  return bn(quoteUsdt).gte(minNotional);
}

export function meetsMinQty(qty: string, minQty: string): boolean {
  return bn(qty).gte(minQty);
}

export { floorToStep, formatQuantity, formatPrice };
