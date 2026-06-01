import {
  getBotState,
  resetToIdle,
  setStatus,
  clearTrailingOrderId,
} from '../db/bot-state';
import { listOpenPositions } from '../db/open-positions';
import { logEvent } from '../db/trade-log';
import { TradingGateway } from '../exchange/gateway';
import { isInsufficientBalanceError } from '../exchange/position-sell';
import { ensureTrailingCanceled } from '../exchange/ensure-trailing-canceled';
import { cancelAllOpenOrdersForSymbol } from '../exchange/cancel-open-orders';
import { closePositionBestEffort } from './emergency-exit';
import { finalizeOpenPositionClose } from './finalize-open-position-close';
import { bn, subtract } from '../math/decimal';

/**
 * Açık pozisyonu zarar/kâr fark etmeksizin kapatır: trailing iptal + market satış + IDLE.
 */
export async function runForceClose(env: Env): Promise<{ ok: boolean; message: string }> {
  const gateway = new TradingGateway(env);
  const openPositions = await listOpenPositions(env.DB);
  if (openPositions.length > 0) {
    let closed = 0;
    const failedSymbols: string[] = [];
    for (const position of openPositions) {
      await logEvent(env.DB, 'FORCE_CLOSE_STARTED', {
        symbol: position.symbol,
        position_id: position.id,
        status: 'OPEN',
        net_base_qty: position.net_base_qty,
        trailing_order_id: position.trailing_order_id,
      });
      try {
        if (String(env.TRADING_ENABLED) === 'true') {
          await cancelAllOpenOrdersForSymbol(env.DB, gateway.binance, position.symbol);
        }
      } catch {
        /* iptal edilemeyen emirlerde de market çıkış denensin */
      }
      try {
        const ok = await finalizeOpenPositionClose(env, gateway, position, {
          source: 'force_close_market_sell',
        });
        if (ok) {
          closed += 1;
        } else {
          failedSymbols.push(position.symbol);
        }
      } catch (err) {
        failedSymbols.push(position.symbol);
        await logEvent(env.DB, 'FORCE_CLOSE_FAILED', {
          symbol: position.symbol,
          position_id: position.id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (failedSymbols.length === 0) {
      return {
        ok: true,
        message: `${closed} açık pozisyon kapatıldı`,
      };
    }
    return {
      ok: false,
      message: `${closed} pozisyon kapandı, kalan: ${failedSymbols.join(', ')}`,
    };
  }

  let state = await getBotState(env.DB);

  if (state.status === 'ERROR' && state.active_symbol && bn(state.net_base_qty).gt(0)) {
    await setStatus(env.DB, 'TIER_1_BULL');
    state = await getBotState(env.DB);
  }

  if (state.status === 'IDLE' && !state.active_symbol) {
    return { ok: true, message: 'Zaten IDLE' };
  }

  if (!state.active_symbol || bn(state.net_base_qty).lte(0)) {
    await resetToIdle(env.DB);
    return { ok: true, message: 'Sembol/qty yok — state IDLE yapıldı' };
  }

  const symbol = state.active_symbol;
  await logEvent(env.DB, 'FORCE_CLOSE_STARTED', {
    symbol,
    status: state.status,
    net_base_qty: state.net_base_qty,
    trailing_order_id: state.trailing_order_id,
  });

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
        source: 'force_close_trailing_filled',
        orderId: order.orderId,
      });
      await resetToIdle(env.DB);
      return { ok: true, message: `Trailing FILLED ile kapandı — PnL ${pnl} USDT` };
    }
  }

  try {
    const sell = await closePositionBestEffort(env, gateway, symbol, state.net_base_qty);
    if (!sell) {
      await resetToIdle(env.DB);
      return {
        ok: true,
        message: 'Satılabilir bakiye yok veya dust — state IDLE (Binance’i kontrol edin)',
      };
    }

    const order = await gateway.getOrder(symbol, sell.orderId);
    if (order.status === 'FILLED' || String(env.TRADING_ENABLED) !== 'true') {
      const proceeds = order.cummulativeQuoteQty ?? '0';
      const pnl = subtract(proceeds, state.total_usdt_spent);
      await logEvent(env.DB, 'POSITION_CLOSED', {
        symbol,
        proceeds,
        spent: state.total_usdt_spent,
        pnl,
        source: 'force_close_market_sell',
        orderId: order.orderId,
      });
      await resetToIdle(env.DB);
      return { ok: true, message: `Market satış — PnL ${pnl} USDT` };
    }

    return {
      ok: false,
      message: `Satış emri bekliyor: ${order.status} (reconcile tekrar dene)`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logEvent(env.DB, 'FORCE_CLOSE_FAILED', { symbol, message });
    if (isInsufficientBalanceError(err)) {
      await resetToIdle(env.DB);
      return { ok: true, message: `Yetersiz bakiye — state sıfırlandı: ${message}` };
    }
    await setStatus(env.DB, 'ERROR');
    return { ok: false, message };
  }
}
