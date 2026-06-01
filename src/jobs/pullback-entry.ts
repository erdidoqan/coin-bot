import { getTradingConfig } from '../db/bot-config';
import { openPosition, setStatus, computeAvgCost } from '../db/bot-state';
import { logEvent } from '../db/trade-log';
import { TradingGateway, netQtyFromBuy } from '../exchange/gateway';
import {
  formatQuantity,
  meetsMinNotional,
  meetsMinQty,
  parseSymbolFilters,
} from '../exchange/symbol-filters';
import { sma, bollinger, isPullbackNearSma } from '../indicators/technical';
import { resolveTieredTrailing } from '../exchange/trailing-stop';
import { emergencyMarketSell } from './emergency-exit';
import type { WatchlistEntry } from '../db/watchlist';
import { isSystemTradeBlockedSymbol } from '../config/system-trade-rules';

export interface PullbackEntryContext {
  gateway: TradingGateway;
  quoteUsdt: string;
  pullbackTolerancePct: string;
  trailingActivationPct: string;
  trailingTightCallbackPct: string;
  entryIndex: number;
}

/**
 * SMA pullback girişi + tiered trailing. Giriş yapıldıysa true.
 */
export async function tryPullbackEntry(
  env: Env,
  entry: WatchlistEntry,
  ctx: PullbackEntryContext,
): Promise<boolean> {
  const symbol = entry.symbol;
  if (isSystemTradeBlockedSymbol(symbol)) {
    await logEvent(env.DB, 'SNIPER_SKIP', {
      reason: 'system_symbol_blocked',
      symbol,
      entry_mode: 'pullback',
    });
    return false;
  }
  const klines = await ctx.gateway.binance.getKlines(symbol, '15m', 30);
  const closes = klines.map((k) => k.close);
  const sma20 = sma(closes, 20);
  if (!sma20) return false;

  const bb = bollinger(closes, 20, 2);
  const lastClose = closes[closes.length - 1] ?? entry.price_at_addition;

  if (!isPullbackNearSma(lastClose, sma20, ctx.pullbackTolerancePct)) return false;

  await logEvent(env.DB, 'SIGNAL', {
    symbol,
    lastClose,
    sma20,
    bollinger: bb,
    tolerancePct: ctx.pullbackTolerancePct,
    entry_mode: 'pullback',
  });

  const info = await ctx.gateway.binance.getExchangeInfo(symbol);
  const symInfo = info.symbols[0];
  if (!symInfo) return false;

  const filters = parseSymbolFilters(symInfo);
  if (!meetsMinNotional(ctx.quoteUsdt, filters.minNotional)) {
    await logEvent(env.DB, 'MIN_NOTIONAL_SKIP', {
      symbol,
      quoteUsdt: ctx.quoteUsdt,
      minNotional: filters.minNotional,
    });
    return false;
  }

  const buyOrder = await ctx.gateway.marketBuy(symbol, ctx.quoteUsdt);
  const net = netQtyFromBuy(buyOrder, symbol);

  if (net.commission_in_base) {
    await logEvent(env.DB, 'COMMISSION_IN_BASE_ASSET', {
      symbol,
      commission: net.commission_base_total,
      hint: 'Hesapta 5-10 USDT değerinde BNB bulundurun',
    });
  }

  await logEvent(env.DB, 'BUY_FILLED', { symbol, order: buyOrder, entry_mode: 'pullback' });
  await logEvent(env.DB, 'NET_QTY_COMPUTED', { symbol, ...net });

  const sellQty = formatQuantity(net.net_base_qty, filters.stepSize);
  if (!meetsMinQty(sellQty, filters.minQty)) {
    await setStatus(env.DB, 'MANUAL_INTERVENTION');
    await logEvent(env.DB, 'LOT_SIZE_TOO_SMALL', { symbol, sellQty, minQty: filters.minQty });
    return true;
  }

  const usdtSpent = buyOrder.cummulativeQuoteQty ?? ctx.quoteUsdt;
  const avgCost = computeAvgCost(usdtSpent, net.net_base_qty);

  try {
    const tiered = resolveTieredTrailing(
      avgCost,
      ctx.trailingActivationPct,
      ctx.trailingTightCallbackPct,
      filters.tickSize,
      symInfo.filters,
    );
    const trail = await ctx.gateway.placeTrailingStop(symbol, sellQty, tiered);
    await openPosition(env.DB, {
      status: 'TIER_1_BULL',
      active_symbol: symbol,
      net_base_qty: net.net_base_qty,
      total_usdt_spent: usdtSpent,
      total_base_qty: net.gross_base_qty,
      avg_cost: avgCost,
      trailing_order_id: String(trail.orderId),
      entry_mode: 'pullback',
      take_profit_price: null,
      watchlist_cursor: ctx.entryIndex,
    });
    await logEvent(env.DB, 'TRAILING_PLACED', {
      symbol,
      orderId: trail.orderId,
      sellQty,
      avg_cost: avgCost,
      activationStopPrice: tiered.stopPrice,
      trailingActivationPct: ctx.trailingActivationPct,
      trailingTightCallbackPct: ctx.trailingTightCallbackPct,
      trailingDeltaBips: tiered.trailingDeltaBips,
      orderType: 'TAKE_PROFIT',
      entry_mode: 'pullback',
    });
  } catch (trailErr) {
    await logEvent(env.DB, 'TRAILING_REJECTED', {
      symbol,
      sellQty,
      error: trailErr instanceof Error ? trailErr.message : String(trailErr),
    });
    await setStatus(env.DB, 'MANUAL_INTERVENTION');
    await openPosition(env.DB, {
      status: 'MANUAL_INTERVENTION',
      active_symbol: symbol,
      net_base_qty: net.net_base_qty,
      total_usdt_spent: usdtSpent,
      total_base_qty: net.gross_base_qty,
      avg_cost: avgCost,
      entry_mode: 'pullback',
      watchlist_cursor: ctx.entryIndex,
    });

    try {
      await emergencyMarketSell(env, ctx.gateway, symbol, net.net_base_qty);
    } catch (sellErr) {
      await setStatus(env.DB, 'ERROR');
      await logEvent(env.DB, 'EMERGENCY_SELL_FAILED', {
        message: sellErr instanceof Error ? sellErr.message : String(sellErr),
      });
    }
  }

  return true;
}
