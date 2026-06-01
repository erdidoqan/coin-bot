import type { BotState } from '../db/bot-state';
import { getMomentumSwitchConfig } from '../db/bot-config';
import { resolvePositionOpenedAt, resetToIdle, clearTrailingOrderId } from '../db/bot-state';
import { listWatchlist } from '../db/watchlist';
import { logEvent } from '../db/trade-log';
import type { TradingGateway } from '../exchange/gateway';
import { ensureTrailingCanceled } from '../exchange/ensure-trailing-canceled';
import { rankMomentumResults } from '../indicators/multi-tf-momentum';
import { watchlistToBatchItems } from '../jobs/momentum-watchlist';
import { isInsufficientBalanceError } from '../exchange/position-sell';
import { closePositionBestEffort } from '../jobs/emergency-exit';
import { minutesSinceOpenedAt } from '../indicators/watchlist-sma';
import { bn, subtract } from '../math/decimal';

/**
 * Scalp modunda daha yüksek momentum skorlu coine geçiş (cache sıralamasına göre).
 */
export async function checkAndExecuteMomentumSwitch(
  env: Env,
  gateway: TradingGateway,
  state: BotState,
): Promise<boolean> {
  if (state.status !== 'TIER_1_BULL' || state.entry_mode !== 'momentum_scalp') return false;
  if (!state.active_symbol) return false;

  const switchCfg = await getMomentumSwitchConfig(env.DB, env);
  if (!switchCfg.enabled) return false;

  const elapsed = minutesSinceOpenedAt(resolvePositionOpenedAt(state));
  const minMin = Number(switchCfg.minMinutes);
  if (elapsed !== null && minMin > 0 && elapsed < minMin) return false;

  const watchlist = await listWatchlist(env.DB);
  if (watchlist.length === 0) return false;

  const ranked = rankMomentumResults(watchlistToBatchItems(watchlist));
  const best = ranked[0];
  if (!best) return false;

  const activeSymbol = state.active_symbol;
  if (best.symbol === activeSymbol) return false;

  const activeItem = ranked.find((r) => r.symbol === activeSymbol);
  const activeScore = activeItem?.score.scorePct ?? '0';
  const improvement = bn(best.score.scorePct).minus(activeScore);
  if (improvement.lt(switchCfg.minScoreImprovementPct)) {
    await logEvent(env.DB, 'MOMENTUM_SWITCH_SKIP', {
      activeSymbol,
      activeScore,
      bestSymbol: best.symbol,
      bestScore: best.score.scorePct,
      minImprovementPct: switchCfg.minScoreImprovementPct,
      improvementPct: improvement.toFixed(4),
    });
    return false;
  }

  const bestIndex = watchlist.findIndex((w) => w.symbol === best.symbol);

  await logEvent(env.DB, 'MOMENTUM_SWITCH_TRIGGERED', {
    fromSymbol: activeSymbol,
    toSymbol: best.symbol,
    activeScore,
    bestScore: best.score.scorePct,
    improvementPct: improvement.toFixed(4),
    elapsedMinutes: elapsed?.toFixed(1) ?? null,
    watchlistCursor: bestIndex >= 0 ? bestIndex : 0,
  });

  const symbol = activeSymbol;

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
        source: 'momentum_switch_trailing_filled',
        toSymbol: best.symbol,
      });
      await resetToIdle(env.DB, { watchlistCursor: bestIndex >= 0 ? bestIndex : 0 });
      return true;
    }
  }

  try {
    const sell = await closePositionBestEffort(env, gateway, symbol, state.net_base_qty);
    if (!sell) {
      await logEvent(env.DB, 'MOMENTUM_SWITCH_SKIP', {
        activeSymbol,
        bestSymbol: best.symbol,
        reason: 'sell_failed_insufficient_or_dust',
      });
      return false;
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
        source: 'momentum_switch_market_sell',
        toSymbol: best.symbol,
        orderId: order.orderId,
      });
      await resetToIdle(env.DB, { watchlistCursor: bestIndex >= 0 ? bestIndex : 0 });
      return true;
    }
  } catch (err) {
    if (isInsufficientBalanceError(err)) {
      await logEvent(env.DB, 'MOMENTUM_SWITCH_SKIP', {
        activeSymbol,
        bestSymbol: best.symbol,
        reason: 'insufficient_balance',
        message: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
    throw err;
  }

  return false;
}
