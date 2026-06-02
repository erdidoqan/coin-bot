/**
 * Kurtarma kademeli manuel al/sat — panelden adım adım.
 */
import {
  getGridConfig,
  getGridById,
  appendRecoveryLadderDone,
  getRecoveryLadderDone,
  setGridRecovering,
  closeRecoveredGrid,
  type GridStateRow,
} from '../db/grid';
import { logEvent } from '../db/trade-log';
import { TradingGateway } from '../exchange/gateway';
import { baseAssetFromSymbol } from '../exchange/fill-utils';
import {
  getFreeBaseQty,
  resolveSellQtyFromWallet,
} from '../exchange/position-sell';
import {
  formatPrice,
  formatQuantity,
  meetsMinNotional,
  meetsMinQty,
  parseSymbolFilters,
} from '../exchange/symbol-filters';
import { bn } from '../math/decimal';
import { capRecoverySellBaseQty } from '../strategy/grid-recovery-qty';
import {
  buildRecoveryLadderStepViews,
  getRecoveryLadderStep,
  movePctFromAnchor,
  pickAutoRecoveryLadderStep,
  quoteUsdtForLadderBuy,
  baseQtyForLadderSell,
  type RecoveryLadderStepView,
} from '../strategy/recovery-ladder';
import type { GridConfig } from '../db/grid';
import { convertRecoveryToUsdt } from './recovery-convert';
import type { OrderResponse } from '../exchange/binance';

function tradingEnabled(env: Env): boolean {
  return String(env.TRADING_ENABLED) === 'true';
}

function makerSellPrice(target: number, lastPrice: number, tickSize: string): string {
  const tick = Number(tickSize) || 0;
  const desired = Math.max(target, lastPrice + tick);
  let s = formatPrice(String(desired), tickSize);
  let guard = 0;
  while (Number(s) <= lastPrice && guard < 20) {
    s = formatPrice(String(Number(s) + (tick || Number(s) * 0.0001)), tickSize);
    guard++;
  }
  return s;
}

function buyFillFromOrder(order: OrderResponse, fallbackPrice: number): {
  baseQty: number;
  avgPrice: number;
} {
  const exec = Number(order.executedQty);
  const quote = Number(order.cummulativeQuoteQty);
  if (exec > 0 && quote > 0) return { baseQty: exec, avgPrice: quote / exec };
  if (exec > 0 && fallbackPrice > 0) return { baseQty: exec, avgPrice: fallbackPrice };
  return { baseQty: 0, avgPrice: fallbackPrice };
}

async function cancelRecoveryLimitOrder(
  gateway: TradingGateway,
  grid: GridStateRow,
  realMode: boolean,
): Promise<void> {
  if (!realMode || !grid.recovery_order_id || grid.recovery_order_id.startsWith('mock-')) return;
  try {
    await gateway.binance.cancelOrder(grid.symbol, grid.recovery_order_id);
  } catch {
    /* dolmuş/iptal */
  }
}

async function refreshRecoverySellOrder(
  env: Env,
  gateway: TradingGateway,
  cfg: Awaited<ReturnType<typeof getGridConfig>>,
  grid: GridStateRow,
  qty: number,
  avgCost: number,
  lastPrice: number,
): Promise<{ ok: boolean; message: string }> {
  const realMode = tradingEnabled(env) && cfg.liveGate;
  const symbol = grid.symbol;
  const info = await gateway.binance.getExchangeInfo(symbol);
  const symInfo = info.symbols[0];
  if (!symInfo) return { ok: false, message: 'no_symbol_info' };

  const filters = parseSymbolFilters(symInfo);
  const marginPct = (cfg.feeRoundtripPct + cfg.recoveryMarginPct) / 100;
  const targetPrice = makerSellPrice(avgCost * (1 + marginPct), lastPrice, filters.tickSize);

  let sellQty: string;
  if (realMode) {
    const free = Number(await getFreeBaseQty(gateway, baseAssetFromSymbol(symbol)));
    const capped = capRecoverySellBaseQty(qty, free);
    const resolved = await resolveSellQtyFromWallet(gateway, symbol, String(capped));
    if (!resolved || bn(resolved.sellQty).lte(0)) {
      return { ok: false, message: 'no_wallet_qty' };
    }
    sellQty = resolved.sellQty;
  } else {
    sellQty = formatQuantity(String(qty), filters.stepSize);
    if (!meetsMinQty(sellQty, filters.minQty) || bn(sellQty).lte(0)) {
      return { ok: false, message: 'no_qty' };
    }
  }

  const notional = bn(sellQty).times(targetPrice).toFixed(8);
  if (!meetsMinNotional(notional, filters.minNotional)) {
    return { ok: false, message: 'min_notional' };
  }

  let recoveryOrderId: string;
  if (realMode) {
    try {
      const order = await gateway.placeGridLimit(symbol, 'SELL', sellQty, targetPrice);
      recoveryOrderId = String(order.orderId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, message };
    }
  } else {
    recoveryOrderId = `mock-recovery-ladder-${grid.id}-${Date.now()}`;
  }

  await setGridRecovering(env.DB, grid.id, {
    recoveryOrderId,
    recoveryTargetPrice: targetPrice,
    recoveryQty: sellQty,
    recoveryAvgCost: String(avgCost),
    stopReason: grid.stop_reason ?? 'recovery_ladder',
  });

  return { ok: true, message: 'recovery_refreshed' };
}

export interface RecoveryLadderState {
  gridId: number;
  symbol: string;
  anchor: number;
  lastPrice: number | null;
  movePct: number | null;
  positionValueUsdt: number | null;
  recoveryQty: string;
  steps: RecoveryLadderStepView[];
  doneCount: number;
}

export async function getRecoveryLadderState(
  env: Env,
  gridId: number,
): Promise<RecoveryLadderState | null> {
  const grid = await getGridById(env.DB, gridId);
  if (!grid || grid.status !== 'RECOVERING') return null;

  const anchor = Number(grid.recovery_avg_cost ?? 0);
  const gateway = new TradingGateway(env);
  let lastPrice: number | null = null;
  try {
    lastPrice = Number(await gateway.binance.getSymbolPrice(grid.symbol));
    if (!Number.isFinite(lastPrice) || lastPrice <= 0) lastPrice = null;
  } catch {
    lastPrice = null;
  }

  const qty = Number(grid.recovery_qty ?? 0);
  const done = await getRecoveryLadderDone(env.DB, gridId);
  const steps = buildRecoveryLadderStepViews(done, anchor, lastPrice);
  const movePct = lastPrice != null ? movePctFromAnchor(anchor, lastPrice) : null;

  return {
    gridId,
    symbol: grid.symbol,
    anchor,
    lastPrice,
    movePct: movePct != null ? Number(movePct.toFixed(3)) : null,
    positionValueUsdt:
      qty > 0 && lastPrice != null ? Number((qty * lastPrice).toFixed(2)) : null,
    recoveryQty: grid.recovery_qty ?? '0',
    steps,
    doneCount: done.length,
  };
}

export interface RecoveryLadderExecuteResult {
  ok: boolean;
  message: string;
  state?: RecoveryLadderState;
  detail?: Record<string, unknown>;
}

export async function executeRecoveryLadderStep(
  env: Env,
  gridId: number,
  stepId: string,
): Promise<RecoveryLadderExecuteResult> {
  const step = getRecoveryLadderStep(stepId);
  if (!step) return { ok: false, message: 'unknown_step' };

  const grid = await getGridById(env.DB, gridId);
  if (!grid) return { ok: false, message: 'not_found' };
  if (grid.status !== 'RECOVERING') return { ok: false, message: 'not_recovering' };

  const done = await getRecoveryLadderDone(env.DB, gridId);
  if (done.includes(stepId)) return { ok: false, message: 'already_done' };

  const cfg = await getGridConfig(env.DB, env);
  const gateway = new TradingGateway(env);
  const realMode = tradingEnabled(env) && cfg.liveGate;
  const symbol = grid.symbol;

  let lastPrice: number;
  try {
    lastPrice = Number(await gateway.binance.getSymbolPrice(symbol));
    if (!(lastPrice > 0)) return { ok: false, message: 'no_price' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message };
  }

  const anchor = Number(grid.recovery_avg_cost ?? 0);
  const movePct = movePctFromAnchor(anchor, lastPrice);
  const recQty = Number(grid.recovery_qty ?? 0);

  if (step.kind === 'sell_all') {
    const conv = await convertRecoveryToUsdt(env, gridId, { source: 'recovery_ladder' });
    if (!conv.ok) return { ok: false, message: conv.message };
    await appendRecoveryLadderDone(env.DB, gridId, stepId);
    await logEvent(env.DB, 'GRID_RECOVERY_LADDER', {
      gridId,
      symbol,
      stepId,
      kind: step.kind,
      movePct,
      anchor,
      lastPrice,
      pnl: conv.pnl,
    });
    const state = await getRecoveryLadderState(env, gridId);
    return { ok: true, message: 'sell_all', state: state ?? undefined, detail: { pnl: conv.pnl } };
  }

  if (step.kind === 'hold') {
    await appendRecoveryLadderDone(env.DB, gridId, stepId);
    await logEvent(env.DB, 'GRID_RECOVERY_LADDER', {
      gridId,
      symbol,
      stepId,
      kind: 'hold',
      movePct,
      anchor,
      lastPrice,
    });
    const state = await getRecoveryLadderState(env, gridId);
    return { ok: true, message: 'hold', state: state ?? undefined };
  }

  if (step.kind === 'buy') {
    const pct = step.actionPct ?? 0;
    const quoteUsdt = quoteUsdtForLadderBuy(recQty, lastPrice, pct);
    if (quoteUsdt == null || quoteUsdt < 1) {
      return { ok: false, message: 'buy_quote_too_small' };
    }
    const quoteStr = quoteUsdt.toFixed(2);

    await cancelRecoveryLimitOrder(gateway, grid, realMode);

    let boughtBase = 0;
    let buyPrice = lastPrice;
    try {
      if (realMode) {
        const order = await gateway.marketBuy(symbol, quoteStr);
        const fill = buyFillFromOrder(order, lastPrice);
        boughtBase = fill.baseQty;
        buyPrice = fill.avgPrice;
      } else {
        boughtBase = quoteUsdt / lastPrice;
        buyPrice = lastPrice;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await logEvent(env.DB, 'GRID_RECOVERY_LADDER_FAILED', {
        gridId,
        symbol,
        stepId,
        message,
        quoteStr,
      });
      return { ok: false, message };
    }

    const oldQty = recQty;
    const oldAvg = anchor;
    const newQty = oldQty + boughtBase;
    const newAvg =
      newQty > 0 ? (oldQty * oldAvg + boughtBase * buyPrice) / newQty : buyPrice;

    const refresh = await refreshRecoverySellOrder(
      env,
      gateway,
      cfg,
      grid,
      newQty,
      newAvg,
      lastPrice,
    );
    if (!refresh.ok) {
      return { ok: false, message: refresh.message };
    }

    await appendRecoveryLadderDone(env.DB, gridId, stepId);
    await logEvent(env.DB, 'GRID_RECOVERY_LADDER', {
      gridId,
      symbol,
      stepId,
      kind: 'buy',
      movePct,
      quoteUsdt: quoteStr,
      boughtBase,
      newQty,
      newAvg,
      buyPrice,
    });
    const state = await getRecoveryLadderState(env, gridId);
    return {
      ok: true,
      message: 'buy',
      state: state ?? undefined,
      detail: { quoteUsdt: quoteStr, boughtBase, newAvg },
    };
  }

  if (step.kind === 'sell') {
    const pct = step.actionPct ?? 0;
    const rawSell = baseQtyForLadderSell(recQty, pct);
    if (rawSell == null || rawSell <= 0) return { ok: false, message: 'sell_qty_zero' };

    await cancelRecoveryLimitOrder(gateway, grid, realMode);

    const resolved = await resolveSellQtyFromWallet(gateway, symbol, String(rawSell));
    if (!resolved) return { ok: false, message: 'min_qty' };

    const sellQty = resolved.sellQty;
    const notional = bn(sellQty).times(lastPrice).toFixed(8);
    if (!meetsMinNotional(notional, resolved.filters.minNotional)) {
      return { ok: false, message: 'min_notional' };
    }

    let proceeds = 0;
    try {
      if (realMode) {
        const order = await gateway.marketSell(symbol, sellQty);
        proceeds =
          Number(order.cummulativeQuoteQty ?? 0) || Number(sellQty) * lastPrice;
      } else {
        proceeds = Number(sellQty) * lastPrice;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await logEvent(env.DB, 'GRID_RECOVERY_LADDER_FAILED', {
        gridId,
        symbol,
        stepId,
        message,
        sellQty,
      });
      return { ok: false, message };
    }

    const sold = Number(sellQty);
    const remaining = Math.max(0, recQty - sold);
    const avgCost = anchor;

    if (remaining <= 0 || !meetsMinQty(formatQuantity(String(remaining), resolved.filters.stepSize), resolved.filters.minQty)) {
      const cost = avgCost * sold;
      const feePct = cfg.feeRoundtripPct / 100;
      const pnl = (proceeds - cost - proceeds * feePct).toFixed(6);
      await closeRecoveredGrid(env.DB, gridId, pnl);
      await appendRecoveryLadderDone(env.DB, gridId, stepId);
      await logEvent(env.DB, 'GRID_RECOVERY_LADDER', {
        gridId,
        symbol,
        stepId,
        kind: 'sell',
        movePct,
        sellQty,
        proceeds,
        pnl,
        closed: true,
      });
      const state = await getRecoveryLadderState(env, gridId);
      return { ok: true, message: 'sell_closed', state: state ?? undefined, detail: { pnl } };
    }

    const refresh = await refreshRecoverySellOrder(
      env,
      gateway,
      cfg,
      grid,
      remaining,
      avgCost,
      lastPrice,
    );
    if (!refresh.ok) return { ok: false, message: refresh.message };

    await appendRecoveryLadderDone(env.DB, gridId, stepId);
    await logEvent(env.DB, 'GRID_RECOVERY_LADDER', {
      gridId,
      symbol,
      stepId,
      kind: 'sell',
      movePct,
      sellQty,
      proceeds,
      remaining,
    });
    const state = await getRecoveryLadderState(env, gridId);
    return {
      ok: true,
      message: 'sell',
      state: state ?? undefined,
      detail: { sellQty, proceeds, remaining },
    };
  }

  return { ok: false, message: 'invalid_step' };
}

/**
 * Kurtarma bakımında: eşik geçilen ilk tamamlanmamış adımı otomatik uygula (dakikada en fazla 1 adım).
 */
export async function maybeAutoExecuteRecoveryLadder(
  env: Env,
  cfg: GridConfig,
  grid: GridStateRow,
  lastPrice: number,
): Promise<boolean> {
  if (!cfg.recoveryLadderAutoEnabled) return false;
  if (grid.status !== 'RECOVERING') return false;

  const anchor = Number(grid.recovery_avg_cost ?? 0);
  if (!(anchor > 0) || !(lastPrice > 0)) return false;

  const done = await getRecoveryLadderDone(env.DB, grid.id);
  const step = pickAutoRecoveryLadderStep(done, anchor, lastPrice);
  if (!step) return false;

  const result = await executeRecoveryLadderStep(env, grid.id, step.id);
  if (result.ok) {
    await logEvent(env.DB, 'GRID_RECOVERY_LADDER_AUTO', {
      gridId: grid.id,
      symbol: grid.symbol,
      stepId: step.id,
      label: step.label,
      kind: step.kind,
      movePct: movePctFromAnchor(anchor, lastPrice),
      message: result.message,
    });
    return true;
  }

  await logEvent(env.DB, 'GRID_RECOVERY_LADDER_AUTO_SKIP', {
    gridId: grid.id,
    symbol: grid.symbol,
    stepId: step.id,
    reason: result.message,
  });
  return false;
}
