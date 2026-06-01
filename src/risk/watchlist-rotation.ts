import type { BotState } from '../db/bot-state';
import { getRotationConfig, getTradingConfig } from '../db/bot-config';
import { resetToIdle, clearTrailingOrderId, resolvePositionOpenedAt } from '../db/bot-state';
import { listWatchlist } from '../db/watchlist';
import { logEvent } from '../db/trade-log';
import type { TradingGateway } from '../exchange/gateway';
import { ensureTrailingCanceled } from '../exchange/ensure-trailing-canceled';
import {
  formatQuantity,
  meetsMinQty,
  parseSymbolFilters,
} from '../exchange/symbol-filters';
import { emergencyMarketSell } from '../jobs/emergency-exit';
import {
  minutesSinceOpenedAt,
  pickBetterSmaCandidate,
  scanWatchlistSmaRankings,
  explainRotationSkip,
} from '../indicators/watchlist-sma';
import { computeFloatingPnl } from '../position/floating-pnl';
import { subtract } from '../math/decimal';
import { resolveRotationThresholds } from './rotation-thresholds';

export async function checkAndExecuteWatchlistRotation(
  env: Env,
  gateway: TradingGateway,
  state: BotState,
): Promise<boolean> {
  if (state.status !== 'TIER_1_BULL' || !state.active_symbol) return false;

  const openedAt = resolvePositionOpenedAt(state);
  const elapsed = minutesSinceOpenedAt(openedAt);
  if (elapsed === null) return false;

  const { rotationWindowMinutes, rotationMinImprovementPct } = await getRotationConfig(env.DB, env);

  let floatingPnlPct: string | null = null;
  try {
    const lastPrice = await gateway.binance.getSymbolPrice(state.active_symbol);
    const fp = computeFloatingPnl(
      state.active_symbol,
      lastPrice,
      state.net_base_qty,
      state.total_usdt_spent,
    );
    floatingPnlPct = fp?.pnlPct ?? null;
  } catch {
    /* fiyat alınamazsa yalnızca config eşikleri */
  }

  const thresholds = resolveRotationThresholds(
    rotationWindowMinutes,
    rotationMinImprovementPct,
    elapsed,
    floatingPnlPct,
  );

  // İlk N dk: rotasyon yok (trailing). Zarar eşiği aşılırsa veya N dk sonra sürekli kontrol.
  if (thresholds.inGracePeriod) {
    return false;
  }

  const watchlist = await listWatchlist(env.DB);
  if (watchlist.length === 0) return false;

  const symbols = [
    ...new Set([...watchlist.map((w) => w.symbol), state.active_symbol]),
  ];
  const { pullbackTolerancePct } = await getTradingConfig(env.DB, env);

  const rankings = await scanWatchlistSmaRankings(gateway, symbols, pullbackTolerancePct, true);
  const effectiveMin = thresholds.effectiveMinImprovementPct;
  const candidate = pickBetterSmaCandidate(
    state.active_symbol,
    rankings,
    symbols,
    rotationMinImprovementPct,
    effectiveMin,
  );

  if (!candidate) {
    const skip = explainRotationSkip(
      state.active_symbol,
      rankings,
      rotationMinImprovementPct,
      effectiveMin,
    );
    if (skip) {
      await logEvent(env.DB, 'ROTATION_SKIP', {
        ...skip.detail,
        reason: skip.reason,
        elapsedMinutes: elapsed.toFixed(1),
        rotationGraceMinutes: rotationWindowMinutes,
        rotationMinImprovementPct,
        effectiveMinImprovementPct: effectiveMin,
        floatingPnlPct,
        lossGraceBypass: thresholds.bypassGraceForLoss ? 'true' : 'false',
        lossRelaxedMin: thresholds.lossRelaxedMin ? 'true' : 'false',
      });
    }
    return false;
  }

  const activeRanking = rankings.find((r) => r.symbol === state.active_symbol);
  const activeDeviation = activeRanking?.smaDeviationPct ?? '—';

  await logEvent(env.DB, 'WATCHLIST_ROTATION_TRIGGERED', {
    fromSymbol: state.active_symbol,
    toSymbol: candidate.symbol,
    currentDeviation: activeDeviation,
    bestDeviation: candidate.smaDeviationPct,
    elapsedMinutes: elapsed.toFixed(1),
    rotationGraceMinutes: rotationWindowMinutes,
    rotationMinImprovementPct,
    effectiveMinImprovementPct: effectiveMin,
    floatingPnlPct,
    lossGraceBypass: thresholds.bypassGraceForLoss,
    watchlistCursor: candidate.index,
  });

  const symbol = state.active_symbol;

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
        source: 'rotation_trailing_filled',
        orderId: order.orderId,
      });
      await resetToIdle(env.DB, { watchlistCursor: candidate.index });
      return true;
    }
  }

  const info = await gateway.binance.getExchangeInfo(symbol);
  const sym = info.symbols[0];
  if (!sym) return false;

  const filters = parseSymbolFilters(sym);
  const sellQty = formatQuantity(state.net_base_qty, filters.stepSize);
  if (!meetsMinQty(sellQty, filters.minQty)) {
    await logEvent(env.DB, 'WATCHLIST_ROTATION_LOT_TOO_SMALL', { symbol, sellQty, minQty: filters.minQty });
    return false;
  }

  const sell = await gateway.marketSell(symbol, sellQty);
  if (sell.status === 'FILLED' || String(env.TRADING_ENABLED) !== 'true') {
    const proceeds = sell.cummulativeQuoteQty ?? '0';
    const pnl = subtract(proceeds, state.total_usdt_spent);
    await logEvent(env.DB, 'POSITION_CLOSED', {
      symbol,
      proceeds,
      spent: state.total_usdt_spent,
      pnl,
      source: 'better_sma_rotation',
      toSymbol: candidate.symbol,
      orderId: sell.orderId,
    });
    await resetToIdle(env.DB, { watchlistCursor: candidate.index });
    return true;
  }

  await emergencyMarketSell(env, gateway, symbol, state.net_base_qty);
  return true;
}
