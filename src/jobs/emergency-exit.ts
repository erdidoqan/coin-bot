import { setStatus, setActiveOrderId } from '../db/bot-state';
import { logEvent } from '../db/trade-log';
import type { TradingGateway } from '../exchange/gateway';
import { BinanceClient } from '../exchange/binance';
import {
  formatQuantity,
  meetsMinQty,
  parseSymbolFilters,
} from '../exchange/symbol-filters';
import {
  isInsufficientBalanceError,
  isNotionalFilterError,
  resolveSellQtyFromWallet,
} from '../exchange/position-sell';
import { baseAssetFromSymbol } from '../exchange/fill-utils';
import { bn } from '../math/decimal';

export async function emergencyMarketSell(
  env: Env,
  gateway: TradingGateway,
  symbol: string,
  netBaseQty: string,
): Promise<{ orderId: number; sellQty: string } | null> {
  const resolved = await resolveSellQtyFromWallet(gateway, symbol, netBaseQty);
  if (!resolved) {
    await logEvent(env.DB, 'LOT_SIZE_TOO_SMALL', { symbol, netBaseQty });
    await setStatus(env.DB, 'MANUAL_INTERVENTION');
    return null;
  }

  const { sellQty, free, requested } = resolved;
  if (bn(free).lt(requested)) {
    await logEvent(env.DB, 'SELL_QTY_CAPPED', {
      symbol,
      requestedQty: requested,
      freeBalance: free,
      sellQty,
    });
  }

  try {
    const order = await gateway.marketSell(symbol, sellQty);
    await setActiveOrderId(env.DB, String(order.orderId));
    await logEvent(env.DB, 'EMERGENCY_MARKET_SELL', { symbol, sellQty, orderId: order.orderId });
    return { orderId: order.orderId, sellQty };
  } catch (err) {
    if (isInsufficientBalanceError(err)) {
      await logEvent(env.DB, 'INSUFFICIENT_BALANCE_SELL', {
        symbol,
        netBaseQty,
        freeBalance: free,
        message: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    if (isNotionalFilterError(err)) {
      await logEvent(env.DB, 'SELL_NOTIONAL_TOO_SMALL', {
        symbol,
        netBaseQty,
        freeBalance: free,
        sellQty,
        message: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    throw err;
  }
}

export async function sellFreeBalanceFromAccount(
  env: Env,
  gateway: TradingGateway,
  symbol: string,
  baseAsset: string,
): Promise<{ orderId: number; sellQty: string } | null> {
  const client = new BinanceClient(env);
  const balances = await client.getAccountBalances();
  const free = balances.find((b) => b.asset === baseAsset)?.free ?? '0';

  const info = await client.getExchangeInfo(symbol);
  const sym = info.symbols[0];
  if (!sym) return null;

  const filters = parseSymbolFilters(sym);
  const sellQty = formatQuantity(free, filters.stepSize);

  if (!meetsMinQty(sellQty, filters.minQty)) {
    await logEvent(env.DB, 'DUST_REMAINDER', { symbol, free, sellQty, minQty: filters.minQty });
    return null;
  }

  try {
    const order = await gateway.marketSell(symbol, sellQty);
    await logEvent(env.DB, 'FREE_BALANCE_SELL', { symbol, sellQty, orderId: order.orderId, free });
    return { orderId: order.orderId, sellQty };
  } catch (err) {
    if (isInsufficientBalanceError(err)) {
      await logEvent(env.DB, 'FREE_BALANCE_SELL_FAILED', {
        symbol,
        free,
        message: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    if (isNotionalFilterError(err)) {
      await logEvent(env.DB, 'FREE_BALANCE_SELL_NOTIONAL_TOO_SMALL', {
        symbol,
        free,
        sellQty,
        message: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    throw err;
  }
}

/** Önce cüzdanla sınırlı satış, olmazsa tüm free bakiye. */
export async function closePositionBestEffort(
  env: Env,
  gateway: TradingGateway,
  symbol: string,
  netBaseQty: string,
): Promise<{ orderId: number; sellQty: string } | null> {
  const sell = await emergencyMarketSell(env, gateway, symbol, netBaseQty);
  if (sell) return sell;
  return sellFreeBalanceFromAccount(env, gateway, symbol, baseAssetFromSymbol(symbol));
}
