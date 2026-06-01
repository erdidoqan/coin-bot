import type { BotState } from '../db/bot-state';
import { getConfig } from '../db/bot-config';
import { logEvent } from '../db/trade-log';
import type { TradingGateway } from '../exchange/gateway';
import { finalizePositionClose } from '../jobs/finalize-position-close';
import { effectiveAvgCost } from '../position/floating-pnl';
import { bn } from '../math/decimal';

export async function fetchSymbolLastPrice(
  gateway: TradingGateway,
  symbol: string,
): Promise<string | null> {
  const tickers = await gateway.binance.getTicker24hr();
  const t = tickers.find((x) => x.symbol === symbol);
  return t?.lastPrice ?? null;
}

export function computeLossPct(avgCost: string, lastPrice: string): string {
  if (bn(avgCost).lte(0)) return '0';
  const cost = bn(avgCost);
  const price = bn(lastPrice);
  if (price.gte(cost)) return '0';
  return cost.minus(price).dividedBy(cost).times(100).toFixed(4);
}

export async function checkAndExecuteHardStop(
  env: Env,
  gateway: TradingGateway,
  state: BotState,
  thresholdPctOverride?: string,
  logSource = 'hard_stop',
): Promise<boolean> {
  if (!state.active_symbol || state.status !== 'TIER_1_BULL') return false;
  if (bn(state.net_base_qty).lte(0)) return false;

  const symbol = state.active_symbol;
  const lastPrice = await fetchSymbolLastPrice(gateway, symbol);
  if (!lastPrice) return false;

  const threshold =
    thresholdPctOverride ?? (await getConfig(env.DB, 'hard_stop_loss_pct', env));
  const avgCost = effectiveAvgCost(state.total_usdt_spent, state.net_base_qty);
  const lossPct = computeLossPct(avgCost, lastPrice);

  if (bn(lossPct).lt(threshold)) return false;

  await logEvent(env.DB, 'HARD_STOP_TRIGGERED', {
    symbol,
    lastPrice,
    avg_cost: avgCost,
    lossPct,
    thresholdPct: threshold,
    trailing_order_id: state.trailing_order_id,
    source: logSource,
    entry_mode: state.entry_mode,
  });

  if (state.trailing_order_id) {
    await gateway.cancelTrailingOrder(symbol, state.trailing_order_id);
  }

  return finalizePositionClose(env, gateway, state, {
    source: logSource,
    entryMode: state.entry_mode,
  });
}
