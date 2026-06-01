import {
  getBotState,
  resetToIdle,
  setActiveOrderId,
  clearTrailingOrderId,
  setStatus,
  ensurePositionOpenedAt,
  resolveEntryMode,
} from '../db/bot-state';
import { countOpenPositions } from '../db/open-positions';
import { runScalpReconcile } from './scalp-reconcile';
import { runTickMultiReconcile } from './tick-multi-reconcile';
import { logEvent } from '../db/trade-log';
import { TradingGateway } from '../exchange/gateway';
import { isOrderGoneError } from '../exchange/order-errors';
import { isMockOrderId } from '../exchange/mock-order-id';
import { baseAssetFromSymbol } from '../exchange/fill-utils';
import {
  formatQuantity,
  meetsMinQty,
  parseSymbolFilters,
} from '../exchange/symbol-filters';
import { emergencyMarketSell, sellFreeBalanceFromAccount } from './emergency-exit';
import { checkAndExecuteHardStop } from '../risk/hard-stop';
import { checkAndExecuteWatchlistRotation } from '../risk/watchlist-rotation';
import { ensureTrailingCanceled } from '../exchange/ensure-trailing-canceled';
import { cancelAllOpenOrdersForSymbol } from '../exchange/cancel-open-orders';
import { bn, subtract } from '../math/decimal';
import { isHybridEnabled, isMicroScalpEnabled, isTickScalpEnabled } from '../db/bot-config';
import { isScalpEntryMode } from '../db/bot-state';
import { listWatchlist } from '../db/watchlist';
import { refreshWatchlistMomentumRankings } from './momentum-watchlist';

const TERMINAL_FAIL = new Set(['CANCELED', 'EXPIRED', 'REJECTED']);

export async function runReconcile(env: Env): Promise<void> {
  let state = await getBotState(env.DB);
  const tickEnabled = await isTickScalpEnabled(env.DB, env);
  if (tickEnabled) {
    const tickOpenCount = await countOpenPositions(env.DB, { entryMode: 'tick_scalp' });
    if (tickOpenCount > 0) {
      const gateway = new TradingGateway(env);
      try {
        await runTickMultiReconcile(env, gateway);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await logEvent(env.DB, 'CRON_ERROR', {
          job: 'tick-multi-reconcile',
          message,
        });
        console.error('tick-multi-reconcile error', err);
        throw err;
      }
      return;
    }
  }

  if (state.status === 'ERROR') {
    if (state.active_symbol && bn(state.net_base_qty).gt(0)) {
      await setStatus(env.DB, 'TIER_1_BULL');
      state = await getBotState(env.DB);
      await logEvent(env.DB, 'ERROR_RECOVERED', { symbol: state.active_symbol });
    } else {
      await resetToIdle(env.DB);
      return;
    }
  }

  if (state.status !== 'TIER_1_BULL' && state.status !== 'MANUAL_INTERVENTION') return;
  if (!state.active_symbol) return;

  const gateway = new TradingGateway(env);
  const symbol = state.active_symbol;

  try {
    const microOn = await isMicroScalpEnabled(env.DB, env);
    if (!microOn && (await isHybridEnabled(env.DB, env))) {
      try {
        const wl = await listWatchlist(env.DB);
        if (wl.length > 0) {
          await refreshWatchlistMomentumRankings(
            env,
            gateway,
            wl.map((w) => w.symbol),
          );
        }
      } catch (momErr) {
        const msg = momErr instanceof Error ? momErr.message : String(momErr);
        if (!msg.includes('subrequests')) {
          await logEvent(env.DB, 'MOMENTUM_SCAN_SKIP', { reason: msg, during: 'reconcile' });
        }
      }
    }

    if (state.status === 'TIER_1_BULL') {
      if (isScalpEntryMode(resolveEntryMode(state))) {
        await runScalpReconcile(env, gateway);
        return;
      }
      if (state.trailing_order_id) {
        await reconcileTrailing(env, gateway, symbol, state);
        return;
      }
    }

    if (state.status === 'MANUAL_INTERVENTION') {
      await reconcileManual(env, gateway, symbol, state);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/insufficient balance/i.test(message)) {
      await logEvent(env.DB, 'INSUFFICIENT_BALANCE_RECONCILE', {
        symbol: state.active_symbol,
        message,
      });
      return;
    }
    await logEvent(env.DB, 'CRON_ERROR', {
      job: 'reconcile',
      message,
    });
    console.error('reconcile error', err);
    throw err;
  }
}

async function reconcileTrailing(
  env: Env,
  gateway: TradingGateway,
  symbol: string,
  state: Awaited<ReturnType<typeof getBotState>>,
): Promise<void> {
  await ensurePositionOpenedAt(env.DB, state);
  const freshState = await getBotState(env.DB);

  const hardStopFired = await checkAndExecuteHardStop(env, gateway, freshState);
  if (hardStopFired) return;

  if (!isScalpEntryMode(resolveEntryMode(freshState))) {
    const rotationFired = await checkAndExecuteWatchlistRotation(env, gateway, freshState);
    if (rotationFired) return;
  }

  let order;
  try {
    order = await gateway.getOrder(symbol, freshState.trailing_order_id!);
  } catch (err) {
    if (isOrderGoneError(err)) {
      await logEvent(env.DB, 'RECONCILE_ORDER_GONE', {
        symbol,
        orderId: freshState.trailing_order_id,
        mockId: isMockOrderId(freshState.trailing_order_id, String(env.TRADING_ENABLED) === 'true'),
        message: err instanceof Error ? err.message : String(err),
      });
      await setStatus(env.DB, 'MANUAL_INTERVENTION');
      return;
    }
    throw err;
  }

  if (order.status === 'FILLED') {
    const proceeds = order.cummulativeQuoteQty ?? '0';
    const pnl = subtract(proceeds, freshState.total_usdt_spent);
    await logEvent(env.DB, 'POSITION_CLOSED', {
      symbol,
      proceeds,
      spent: freshState.total_usdt_spent,
      pnl,
      orderId: order.orderId,
    });
    await resetToIdle(env.DB);
    return;
  }

  if (TERMINAL_FAIL.has(order.status)) {
    await logEvent(env.DB, 'ORDER_ANOMALY', { symbol, status: order.status, orderId: order.orderId });
    await setStatus(env.DB, 'MANUAL_INTERVENTION');
    await emergencyMarketSell(env, gateway, symbol, freshState.net_base_qty);
  }
}

async function reconcileManual(
  env: Env,
  gateway: TradingGateway,
  symbol: string,
  state: Awaited<ReturnType<typeof getBotState>>,
): Promise<void> {
  if (String(env.TRADING_ENABLED) === 'true') {
    await cancelAllOpenOrdersForSymbol(env.DB, gateway.binance, symbol);
  }

  if (state.trailing_order_id) {
    const trailingId = state.trailing_order_id;
    const result = await ensureTrailingCanceled(gateway, symbol, trailingId);
    await clearTrailingOrderId(env.DB);
    if (result === 'filled') {
      const order = await gateway.getOrder(symbol, trailingId);
      const proceeds = order.cummulativeQuoteQty ?? '0';
      const pnl = subtract(proceeds, state.total_usdt_spent);
      await logEvent(env.DB, 'POSITION_CLOSED', {
        symbol,
        proceeds,
        spent: state.total_usdt_spent,
        pnl,
        source: 'manual_trailing_filled',
        orderId: order.orderId,
      });
      await resetToIdle(env.DB);
      return;
    }
  }

  if (state.active_order_id) {
    let order: Awaited<ReturnType<TradingGateway['getOrder']>> | null = null;
    try {
      order = await gateway.getOrder(symbol, state.active_order_id);
    } catch (err) {
      if (isOrderGoneError(err)) {
        await logEvent(env.DB, 'RECONCILE_ORDER_GONE', {
          symbol,
          orderId: state.active_order_id,
          mockId: isMockOrderId(state.active_order_id, String(env.TRADING_ENABLED) === 'true'),
          message: err instanceof Error ? err.message : String(err),
        });
        await setActiveOrderId(env.DB, null);
      } else {
        throw err;
      }
    }

    if (order?.status === 'FILLED') {
      const proceeds = order.cummulativeQuoteQty ?? '0';
      const pnl = subtract(proceeds, state.total_usdt_spent);
      await logEvent(env.DB, 'POSITION_CLOSED', {
        symbol,
        proceeds,
        spent: state.total_usdt_spent,
        pnl,
        source: 'emergency_sell',
        orderId: order.orderId,
      });
      await resetToIdle(env.DB);
      return;
    }
  }

  if (bn(state.net_base_qty).gt(0)) {
    const baseAsset = baseAssetFromSymbol(symbol);
    try {
      const info = await gateway.binance.getExchangeInfo(symbol);
      const sym = info.symbols[0];
      if (!sym) return;
      const filters = parseSymbolFilters(sym);
      const sellQty = formatQuantity(state.net_base_qty, filters.stepSize);

      if (!meetsMinQty(sellQty, filters.minQty)) {
        await sellFreeBalanceFromAccount(env, gateway, symbol, baseAsset);
        await logEvent(env.DB, 'DUST_REMAINDER', { symbol, net_base_qty: state.net_base_qty });
        await resetToIdle(env.DB);
        return;
      }

      const sell = await gateway.marketSell(symbol, sellQty);
      if (sell.status === 'FILLED' || String(env.TRADING_ENABLED) !== 'true') {
        const proceeds = sell.cummulativeQuoteQty ?? '0';
        const pnl = subtract(proceeds, state.total_usdt_spent);
        await logEvent(env.DB, 'POSITION_CLOSED', {
          symbol,
          proceeds,
          pnl,
          source: 'manual_balance_sell',
        });
        await resetToIdle(env.DB);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('insufficient balance') || msg.includes('NOTIONAL')) {
        await logEvent(env.DB, 'INSUFFICIENT_BALANCE_RETRY', { symbol, message: msg });
        if (String(env.TRADING_ENABLED) === 'true') {
          await cancelAllOpenOrdersForSymbol(env.DB, gateway.binance, symbol);
        }
        const trailingId = (await getBotState(env.DB)).trailing_order_id;
        if (trailingId) {
          await ensureTrailingCanceled(gateway, symbol, trailingId);
          await clearTrailingOrderId(env.DB);
        }
        await sellFreeBalanceFromAccount(env, gateway, symbol, baseAsset);
        const refreshed = await getBotState(env.DB);
        if (refreshed.status === 'MANUAL_INTERVENTION' && bn(refreshed.net_base_qty).gt(0)) {
          try {
            const info = await gateway.binance.getExchangeInfo(symbol);
            const sym = info.symbols[0];
            if (sym) {
              const filters = parseSymbolFilters(sym);
              const sellQty = formatQuantity(refreshed.net_base_qty, filters.stepSize);
              if (meetsMinQty(sellQty, filters.minQty)) {
                const sell = await gateway.marketSell(symbol, sellQty);
                const proceeds = sell.cummulativeQuoteQty ?? '0';
                const pnl = subtract(proceeds, refreshed.total_usdt_spent);
                await logEvent(env.DB, 'POSITION_CLOSED', {
                  symbol,
                  proceeds,
                  spent: refreshed.total_usdt_spent,
                  pnl,
                  source: 'manual_retry_sell',
                  orderId: sell.orderId,
                });
                await resetToIdle(env.DB);
              }
            }
          } catch {
            /* bir sonraki cron dener */
          }
        }
      } else {
        await setStatus(env.DB, 'ERROR');
        await logEvent(env.DB, 'RECONCILE_FAILED', { symbol, message: msg });
      }
    }
  } else {
    await resetToIdle(env.DB);
  }
}
