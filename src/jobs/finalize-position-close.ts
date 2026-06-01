import type { BotState, EntryMode } from '../db/bot-state';
import { resetToIdle } from '../db/bot-state';
import { logEvent } from '../db/trade-log';
import { insertTradeFeatures, getRegimeCache } from '../db/trade-features';
import type { TradingGateway } from '../exchange/gateway';
import type { OrderResponse } from '../exchange/binance';
import { subtract, bn } from '../math/decimal';
import { closePositionBestEffort } from './emergency-exit';
import {
  buildTradeOutcome,
  outcomeToFeatureRecord,
} from '../position/trade-analytics';
import { isScalpEntryMode } from '../db/bot-state';

export interface FinalizeCloseOptions {
  source: string;
  entryMode?: EntryMode | null;
  resetCursor?: number;
}

export async function finalizePositionCloseFromFilledOrder(
  env: Env,
  state: BotState,
  order: Pick<OrderResponse, 'orderId' | 'cummulativeQuoteQty'>,
  options: FinalizeCloseOptions,
): Promise<boolean> {
  const symbol = state.active_symbol;
  if (!symbol) return false;

  const proceeds = order.cummulativeQuoteQty ?? '0';
  const pnl = subtract(proceeds, state.total_usdt_spent);
  const entryMode = options.entryMode ?? state.entry_mode;

  const soldQty = bn(state.net_base_qty);
  const exitPrice =
    soldQty.gt(0) ? bn(proceeds).dividedBy(soldQty).toFixed(8) : proceeds;

  const tradeOutcome = isScalpEntryMode(entryMode ?? null)
    ? buildTradeOutcome(state, {
        source: options.source,
        pnl,
        proceeds,
        exitPrice,
      })
    : null;

  if (tradeOutcome) {
    await logEvent(env.DB, 'TRADE_OUTCOME', tradeOutcome);
  }

  await logEvent(env.DB, 'POSITION_CLOSED', {
    symbol,
    proceeds,
    spent: state.total_usdt_spent,
    pnl,
    source: options.source,
    orderId: order.orderId,
    entry_mode: entryMode,
    ...(tradeOutcome
      ? {
          exit_pct_from_cost: tradeOutcome.exit_pct_from_cost,
          max_favorable_pct: tradeOutcome.max_favorable_pct,
          max_adverse_pct: tradeOutcome.max_adverse_pct,
        }
      : {}),
  });

  if (isScalpEntryMode(entryMode ?? null)) {
    const { regime } = await getRegimeCache(env.DB);
    const outcomeLabel = options.source.includes('take_profit')
      ? 'tp'
      : options.source.includes('hard_stop')
        ? 'sl'
        : options.source.includes('signal_lost')
          ? 'signal_lost'
          : options.source.includes('max_hold')
            ? 'max_hold'
            : options.source;
    await insertTradeFeatures(env.DB, {
      symbol,
      phase: 'exit',
      entry_mode: entryMode,
      regime,
      outcome: outcomeLabel,
      pnl,
      features: tradeOutcome
        ? outcomeToFeatureRecord(tradeOutcome)
        : {
            source: options.source,
            proceeds,
            spent: state.total_usdt_spent,
            take_profit_price: state.take_profit_price,
            scalp_stop_loss_pct: state.scalp_stop_loss_pct,
          },
    });
  }
  await resetToIdle(
    env.DB,
    options.resetCursor !== undefined ? { watchlistCursor: options.resetCursor } : undefined,
  );
  return true;
}

/** Market satış + POSITION_CLOSED + IDLE (hard stop, scalp TP, vb.). */
export async function finalizePositionClose(
  env: Env,
  gateway: TradingGateway,
  state: BotState,
  options: FinalizeCloseOptions,
): Promise<boolean> {
  const symbol = state.active_symbol;
  if (!symbol) return false;

  const sold = await closePositionBestEffort(env, gateway, symbol, state.net_base_qty);
  if (!sold) return false;

  const order = await gateway.getOrder(symbol, sold.orderId);
  if (order.status !== 'FILLED' && String(env.TRADING_ENABLED) === 'true') {
    return false;
  }
  return finalizePositionCloseFromFilledOrder(env, state, order, options);
}
