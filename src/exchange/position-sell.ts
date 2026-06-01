import type { OrderResponse } from './binance';
import { baseAssetFromSymbol } from './fill-utils';
import type { TradingGateway } from './gateway';
import { formatQuantity, meetsMinQty, parseSymbolFilters } from './symbol-filters';
import type { ParsedSymbolFilters } from './symbol-filters';
import { bn } from '../math/decimal';

export function isInsufficientBalanceError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /insufficient balance/i.test(msg);
}

export function isNotionalFilterError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /filter failure:\s*notional|min_notional|notional/i.test(msg);
}

export async function getFreeBaseQty(
  gateway: TradingGateway,
  baseAsset: string,
): Promise<string> {
  const balances = await gateway.binance.getAccountBalances();
  return balances.find((b) => b.asset === baseAsset)?.free ?? '0';
}

export interface ResolvedSellQty {
  sellQty: string;
  free: string;
  requested: string;
  filters: ParsedSymbolFilters;
}

/** Cüzdandaki free bakiyeyi aşmayacak şekilde satılabilir miktar. */
export async function resolveSellQtyFromWallet(
  gateway: TradingGateway,
  symbol: string,
  requestedQty: string,
): Promise<ResolvedSellQty | null> {
  const info = await gateway.binance.getExchangeInfo(symbol);
  const sym = info.symbols[0];
  if (!sym) return null;

  const filters = parseSymbolFilters(sym);
  const free = await getFreeBaseQty(gateway, baseAssetFromSymbol(symbol));
  const capped = bn(free).lt(requestedQty) ? free : requestedQty;
  const sellQty = formatQuantity(capped, filters.stepSize);

  if (!meetsMinQty(sellQty, filters.minQty)) return null;

  return { sellQty, free, requested: requestedQty, filters };
}

export interface PositionSellResult {
  orderId: number;
  sellQty: string;
  order: OrderResponse;
  cappedFromFree: boolean;
}

/**
 * Market satış: DB qty > free ise free ile sınırla.
 */
export async function marketSellPositionBestEffort(
  gateway: TradingGateway,
  symbol: string,
  requestedQty: string,
): Promise<PositionSellResult | null> {
  const resolved = await resolveSellQtyFromWallet(gateway, symbol, requestedQty);
  if (!resolved) return null;

  const { sellQty, free, requested } = resolved;
  const cappedFromFree = bn(free).lt(requested);

  try {
    const order = await gateway.marketSell(symbol, sellQty);
    return { orderId: order.orderId, sellQty, order, cappedFromFree };
  } catch (err) {
    if (!isInsufficientBalanceError(err)) throw err;
    return null;
  }
}
