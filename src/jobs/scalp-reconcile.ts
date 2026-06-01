import type { BotState } from '../db/bot-state';
import {
  getScalpConfig,
  getMicroScalpConfig,
  getTickScalpConfig,
  isMicroScalpEnabled,
} from '../db/bot-config';
import {
  getBotState,
  resolvePositionOpenedAt,
  ensurePositionOpenedAt,
  resolveEntryMode,
  isScalpEntryMode,
} from '../db/bot-state';
import { logEvent } from '../db/trade-log';
import type { TradingGateway } from '../exchange/gateway';
import { fetchSymbolLastPrice, checkAndExecuteHardStop } from '../risk/hard-stop';
import { logMockScalpTpHit } from '../exchange/mock-scalp';
import { bn } from '../math/decimal';
import { minutesSinceOpenedAt } from '../indicators/watchlist-sma';
import { checkAndExecuteMomentumSwitch } from '../risk/momentum-switch';
import {
  finalizePositionClose,
  finalizePositionCloseFromFilledOrder,
} from './finalize-position-close';
import { rescoreSymbolMicro } from './micro-scalp-rescore';
import {
  parsePositionEntryContext,
  patchPositionEntryContext,
  updatePositionExcursion,
  pctFromBase,
  type PositionEntryContext,
} from '../position/trade-analytics';
import { effectiveAvgCost } from '../position/floating-pnl';
import { cancelAllOpenOrdersForSymbol } from '../exchange/cancel-open-orders';
import { formatPrice, formatQuantity, parseSymbolFilters, meetsMinQty } from '../exchange/symbol-filters';

interface TickScalpOcoMeta {
  orderListId: number;
  takeProfitOrderId: number;
  stopLossOrderId: number;
}

const OCO_TERMINAL_STATUS = new Set(['CANCELED', 'EXPIRED', 'REJECTED', 'FILLED']);

async function closeScalpPosition(
  env: Env,
  gateway: TradingGateway,
  state: BotState,
  source: string,
): Promise<void> {
  await finalizePositionClose(env, gateway, state, {
    source,
    entryMode: state.entry_mode,
  });
}

function resolveTickScalpOcoMeta(state: BotState): TickScalpOcoMeta | null {
  if (resolveEntryMode(state) !== 'tick_scalp') return null;
  const entry = parsePositionEntryContext(state.position_entry_context);
  if (!entry || entry.protectiveExitType !== 'oco') return null;
  if (
    typeof entry.ocoOrderListId !== 'number' ||
    typeof entry.ocoTakeProfitOrderId !== 'number' ||
    typeof entry.ocoStopLossOrderId !== 'number'
  ) {
    return null;
  }
  return {
    orderListId: entry.ocoOrderListId,
    takeProfitOrderId: entry.ocoTakeProfitOrderId,
    stopLossOrderId: entry.ocoStopLossOrderId,
  };
}

function resolveProfileMaxHoldMinutes(
  entry: PositionEntryContext | null,
  fallbackMinutes: string,
): number {
  const profileHold = entry?.profileMaxHoldMinutes;
  if (profileHold != null && Number.isFinite(profileHold) && profileHold > 0) {
    return profileHold;
  }
  return Number(fallbackMinutes);
}

function favorablePctFromPeak(avgCost: string, peakPrice: string): string {
  const favorable = pctFromBase(avgCost, peakPrice);
  return bn(favorable).gte(0) ? favorable : '0';
}

function adversePctFromTrough(avgCost: string, troughPrice: string): string {
  const adverse = pctFromBase(avgCost, troughPrice);
  if (bn(adverse).gte(0)) return '0';
  return bn(adverse).abs().toFixed(4);
}

function pullbackPctFromPeak(peakPrice: string, lastPrice: string): string {
  const peak = bn(peakPrice);
  if (peak.lte(0) || bn(lastPrice).gte(peak)) return '0';
  return peak.minus(lastPrice).dividedBy(peak).times(100).toFixed(4);
}

function resolveStepLockTargetStage(
  entry: PositionEntryContext | null,
  favorablePct: string,
): 0 | 1 | 2 {
  const cfg = entry?.stepLockConfig;
  if (!cfg || !cfg.enabled) return 0;
  const currentStage = entry?.stepLockStage === 2 ? 2 : entry?.stepLockStage === 1 ? 1 : 0;
  if (currentStage < 2 && bn(favorablePct).gte(cfg.stage2TriggerPct)) return 2;
  if (currentStage < 1 && bn(favorablePct).gte(cfg.stage1TriggerPct)) return 1;
  return 0;
}

function resolveStepLockPct(
  stage: 1 | 2,
  entry: PositionEntryContext,
  feeRoundtripPct: string,
): string {
  const cfg = entry.stepLockConfig!;
  const bePlusFee = bn(feeRoundtripPct).dividedBy(2);
  const cfgStage1 = bn(cfg.stage1LockPct);
  const stage1 = bePlusFee.gte(cfgStage1) ? bePlusFee : cfgStage1;
  if (stage === 1) return stage1.toFixed(4);
  const cfgStage2 = bn(cfg.stage2LockPct);
  return stage1.gte(cfgStage2) ? stage1.toFixed(4) : cfgStage2.toFixed(4);
}

function shouldFailFastExit(
  entry: PositionEntryContext | null,
  nowMs: number,
  favorablePct: string,
  adversePct: string,
  markPct: string,
): boolean {
  if (!entry?.failFastUntilMs) return false;
  if (nowMs > entry.failFastUntilMs) return false;
  const minFavorable = entry.failFastMinFavorablePct ?? '0';
  const maxAdverse = entry.failFastMaxAdversePct ?? '999';
  if (bn(favorablePct).gte(minFavorable)) return false;
  return bn(adversePct).gte(maxAdverse) || bn(markPct).lte(0);
}

async function reconcileTickScalpOco(
  env: Env,
  gateway: TradingGateway,
  state: BotState,
  meta: TickScalpOcoMeta,
): Promise<'filled' | 'active' | 'broken'> {
  const symbol = state.active_symbol;
  if (!symbol) return 'broken';

  let tpOrder: Awaited<ReturnType<TradingGateway['getOrder']>>;
  let slOrder: Awaited<ReturnType<TradingGateway['getOrder']>>;
  try {
    [tpOrder, slOrder] = await Promise.all([
      gateway.getOrder(symbol, meta.takeProfitOrderId),
      gateway.getOrder(symbol, meta.stopLossOrderId),
    ]);
  } catch (err) {
    await logEvent(env.DB, 'SCALP_OCO_STATUS_ERROR', {
      symbol,
      orderListId: meta.orderListId,
      takeProfitOrderId: meta.takeProfitOrderId,
      stopLossOrderId: meta.stopLossOrderId,
      message: err instanceof Error ? err.message : String(err),
    });
    return 'broken';
  }

  const filled = tpOrder.status === 'FILLED' ? tpOrder : slOrder.status === 'FILLED' ? slOrder : null;
  if (filled) {
    const source =
      filled.orderId === meta.takeProfitOrderId
        ? 'scalp_take_profit_oco'
        : 'scalp_hard_stop_oco';
    await logEvent(env.DB, 'SCALP_OCO_FILLED', {
      symbol,
      source,
      orderListId: meta.orderListId,
      orderId: filled.orderId,
      takeProfitOrderId: meta.takeProfitOrderId,
      stopLossOrderId: meta.stopLossOrderId,
      takeProfitStatus: tpOrder.status,
      stopLossStatus: slOrder.status,
    });
    await finalizePositionCloseFromFilledOrder(env, state, filled, {
      source,
      entryMode: state.entry_mode,
    });
    return 'filled';
  }

  const tpTerminal = OCO_TERMINAL_STATUS.has(tpOrder.status);
  const slTerminal = OCO_TERMINAL_STATUS.has(slOrder.status);
  if (tpTerminal && slTerminal) {
    await logEvent(env.DB, 'SCALP_OCO_INACTIVE', {
      symbol,
      orderListId: meta.orderListId,
      takeProfitOrderId: meta.takeProfitOrderId,
      stopLossOrderId: meta.stopLossOrderId,
      takeProfitStatus: tpOrder.status,
      stopLossStatus: slOrder.status,
    });
    return 'broken';
  }

  return 'active';
}

export async function runScalpReconcile(env: Env, gateway: TradingGateway): Promise<void> {
  const state = await getBotState(env.DB);
  if (state.status !== 'TIER_1_BULL' || !state.active_symbol) return;
  if (!isScalpEntryMode(resolveEntryMode(state))) return;

  await ensurePositionOpenedAt(env.DB, state);
  const fresh = await getBotState(env.DB);
  const symbol = fresh.active_symbol!;
  const entryMode = resolveEntryMode(fresh);
  let entry = parsePositionEntryContext(fresh.position_entry_context);
  const tickCfg = entryMode === 'tick_scalp' ? await getTickScalpConfig(env.DB, env) : null;
  const tickOco = resolveTickScalpOcoMeta(fresh);
  let ocoMode: 'none' | 'active' | 'broken' = 'none';
  if (tickOco && String(env.TRADING_ENABLED) === 'true') {
    const ocoResult = await reconcileTickScalpOco(env, gateway, fresh, tickOco);
    if (ocoResult === 'filled') return;
    ocoMode = ocoResult;
  }

  const scalp = await getScalpConfig(env.DB, env);
  const stopPct = fresh.scalp_stop_loss_pct ?? scalp.hardStopLossPct;

  if (ocoMode !== 'active') {
    const hardStopFired = await checkAndExecuteHardStop(
      env,
      gateway,
      fresh,
      stopPct,
      'scalp_hard_stop',
    );
    if (hardStopFired) return;
  }

  if (resolveEntryMode(fresh) === 'momentum_scalp') {
    const switchFired = await checkAndExecuteMomentumSwitch(env, gateway, fresh);
    if (switchFired) return;
  }

  if (
    (await isMicroScalpEnabled(env.DB, env)) &&
    entryMode === 'micro_scalp'
  ) {
    const micro = await getMicroScalpConfig(env.DB, env);
    const rescore = await rescoreSymbolMicro(env, gateway, symbol);
    if (rescore && bn(rescore.score).lt(micro.exitScoreFloor)) {
      await logEvent(env.DB, 'SCALP_EXIT_SIGNAL_LOST', {
        symbol,
        score: rescore.score,
        floor: micro.exitScoreFloor,
        failReason: rescore.failReason,
      });
      await closeScalpPosition(env, gateway, fresh, 'micro_signal_lost');
      return;
    }
  }

  const lastPrice = await fetchSymbolLastPrice(gateway, symbol);
  if (!lastPrice) return;

  const avgCost = effectiveAvgCost(fresh.total_usdt_spent, fresh.net_base_qty);
  const excursion = await updatePositionExcursion(
    env.DB,
    avgCost,
    lastPrice,
    fresh.position_peak_price,
    fresh.position_trough_price,
  );
  if (excursion.newHigh || excursion.newLow) {
    await logEvent(env.DB, 'TRADE_EXCURSION', {
      symbol,
      lastPrice,
      avg_cost: avgCost,
      peak_price: excursion.peak,
      trough_price: excursion.trough,
      favorable_pct: pctFromBase(avgCost, excursion.peak),
      adverse_pct: pctFromBase(avgCost, excursion.trough),
      mark_pct: pctFromBase(avgCost, lastPrice),
      newHigh: excursion.newHigh,
      newLow: excursion.newLow,
      entry_mode: entryMode,
    });
  }

  const favorablePct = favorablePctFromPeak(avgCost, excursion.peak);
  const adversePct = adversePctFromTrough(avgCost, excursion.trough);
  const markPct = pctFromBase(avgCost, lastPrice);

  if (entryMode === 'tick_scalp' && tickCfg && entry?.stepLockConfig?.enabled) {
    const targetStage = resolveStepLockTargetStage(entry, favorablePct);
    if (targetStage > 0) {
      const stage = targetStage as 1 | 2;
      const lockPct = resolveStepLockPct(stage, entry, tickCfg.feeRoundtripPct);
      const info = await gateway.binance.getExchangeInfo(symbol);
      const symInfo = info.symbols[0];
      if (symInfo) {
        const filters = parseSymbolFilters(symInfo);
        const lockStopRaw = bn(avgCost)
          .times(bn(100).plus(lockPct))
          .dividedBy(100);
        let lockStopPrice = formatPrice(lockStopRaw.toFixed(), filters.tickSize);
        const maxAllowedStop = bn(lastPrice).minus(filters.tickSize);
        if (maxAllowedStop.gt(0) && bn(lockStopPrice).gte(maxAllowedStop)) {
          lockStopPrice = formatPrice(maxAllowedStop.toFixed(), filters.tickSize);
        }

        if (bn(lockStopPrice).gt(0)) {
          const stopLimitRaw = bn(lockStopPrice)
            .times(bn(100).minus(tickCfg.stopLimitBufferPct))
            .dividedBy(100);
          let stopLimitPrice = formatPrice(stopLimitRaw.toFixed(), filters.tickSize);
          if (bn(stopLimitPrice).gte(lockStopPrice)) {
            const adjusted = bn(lockStopPrice).minus(filters.tickSize);
            if (adjusted.gt(0)) {
              stopLimitPrice = formatPrice(adjusted.toFixed(), filters.tickSize);
            }
          }

          let replacedOco = false;
          let ocoOrderListId: number | null = null;
          let ocoTakeProfitOrderId: number | null = null;
          let ocoStopLossOrderId: number | null = null;
          if (
            ocoMode === 'active' &&
            String(env.TRADING_ENABLED) === 'true' &&
            fresh.take_profit_price &&
            bn(fresh.net_base_qty).gt(0)
          ) {
            const sellQty = formatQuantity(fresh.net_base_qty, filters.stepSize);
            if (meetsMinQty(sellQty, filters.minQty)) {
              try {
                await cancelAllOpenOrdersForSymbol(env.DB, gateway.binance, symbol);
                const protectiveOco = await gateway.placeScalpOcoExit(
                  symbol,
                  sellQty,
                  fresh.take_profit_price,
                  lockStopPrice,
                  stopLimitPrice,
                );
                if (protectiveOco) {
                  replacedOco = true;
                  ocoOrderListId = protectiveOco.orderListId;
                  ocoTakeProfitOrderId = protectiveOco.takeProfitOrderId;
                  ocoStopLossOrderId = protectiveOco.stopLossOrderId;
                  ocoMode = 'active';
                  await logEvent(env.DB, 'SCALP_STEP_LOCK_OCO_REPLACED', {
                    symbol,
                    stage,
                    lock_pct: lockPct,
                    lock_stop_price: lockStopPrice,
                    stop_limit_price: stopLimitPrice,
                    take_profit_price: fresh.take_profit_price,
                    orderListId: ocoOrderListId,
                    takeProfitOrderId: ocoTakeProfitOrderId,
                    stopLossOrderId: ocoStopLossOrderId,
                  });
                } else {
                  ocoMode = 'broken';
                }
              } catch (err) {
                ocoMode = 'broken';
                await logEvent(env.DB, 'SCALP_STEP_LOCK_OCO_REPLACE_FAILED', {
                  symbol,
                  stage,
                  lock_pct: lockPct,
                  lock_stop_price: lockStopPrice,
                  stop_limit_price: stopLimitPrice,
                  message: err instanceof Error ? err.message : String(err),
                });
              }
            }
          }

          const patched = await patchPositionEntryContext(env.DB, {
            stepLockStage: stage,
            lockedStopPrice: lockStopPrice,
            lockedStopPct: lockPct,
            ...(replacedOco
              ? {
                  protectiveExitType: 'oco',
                  ocoOrderListId,
                  ocoTakeProfitOrderId,
                  ocoStopLossOrderId,
                }
              : {}),
          });
          entry = patched ?? entry;
          await logEvent(env.DB, 'SCALP_STEP_LOCK_ADVANCED', {
            symbol,
            stage,
            favorable_pct: favorablePct,
            lock_pct: lockPct,
            lock_stop_price: lockStopPrice,
            stop_limit_price: stopLimitPrice,
            replaced_oco: replacedOco,
          });
        }
      }
    }
  }

  if (
    entryMode === 'tick_scalp' &&
    shouldFailFastExit(entry, Date.now(), favorablePct, adversePct, markPct)
  ) {
    await logEvent(env.DB, 'SCALP_FAIL_FAST_EXIT', {
      symbol,
      favorable_pct: favorablePct,
      adverse_pct: adversePct,
      mark_pct: markPct,
      fail_fast_until_ms: entry?.failFastUntilMs ?? null,
      min_favorable_pct: entry?.failFastMinFavorablePct ?? null,
      max_adverse_pct: entry?.failFastMaxAdversePct ?? null,
    });
    if (ocoMode === 'active' && String(env.TRADING_ENABLED) === 'true') {
      await cancelAllOpenOrdersForSymbol(env.DB, gateway.binance, symbol);
      const refreshedAfterCancel = await getBotState(env.DB);
      await closeScalpPosition(env, gateway, refreshedAfterCancel, 'scalp_fail_fast_oco');
      return;
    }
    await closeScalpPosition(env, gateway, fresh, 'scalp_fail_fast');
    return;
  }

  const lockedStop = entry?.lockedStopPrice ?? null;
  if (ocoMode !== 'active' && lockedStop && bn(lastPrice).lte(lockedStop)) {
    await logEvent(env.DB, 'SCALP_STEP_LOCK_HIT', {
      symbol,
      lastPrice,
      locked_stop_price: lockedStop,
      favorable_pct: favorablePct,
      adverse_pct: adversePct,
      mark_pct: markPct,
    });
    await closeScalpPosition(env, gateway, fresh, 'scalp_step_lock');
    return;
  }

  const tp = fresh.take_profit_price;
  if (ocoMode !== 'active' && tp && bn(lastPrice).gte(tp)) {
    await logMockScalpTpHit(env, symbol, lastPrice, tp);
    await logEvent(env.DB, 'SCALP_EXIT_TP', {
      symbol,
      lastPrice,
      take_profit_price: tp,
    });
    await closeScalpPosition(env, gateway, fresh, 'scalp_take_profit');
    return;
  }

  const openedAt = resolvePositionOpenedAt(fresh);
  const elapsed = minutesSinceOpenedAt(openedAt);
  const maxHold = resolveProfileMaxHoldMinutes(entry, scalp.maxHoldMinutes);
  const lossRecoveryActive =
    entryMode === 'tick_scalp' &&
    elapsed !== null &&
    tickCfg?.maxHoldOnlyIfProfitable &&
    bn(markPct).lt(0) &&
    elapsed >= tickCfg.lossRecovery.startMinutes;

  if (lossRecoveryActive && tickCfg) {
    const hadDeferredState = Boolean(entry?.maxHoldDeferredAtMs);
    const deferredAtMs = entry?.maxHoldDeferredAtMs ?? Date.now();
    const deferredAtPrice = entry?.maxHoldDeferredAtPrice ?? lastPrice;
    const deferredMarkPct = entry?.maxHoldDeferredMarkPct ?? markPct;
    const storedPeak = entry?.maxHoldDeferredPeakPrice ?? deferredAtPrice;
    const peakPrice = bn(lastPrice).gt(storedPeak) ? lastPrice : storedPeak;
    const peakRaised = bn(peakPrice).gt(storedPeak);
    const retracePct = pullbackPctFromPeak(peakPrice, lastPrice);

    if (
      !hadDeferredState ||
      !entry?.maxHoldDeferredAtPrice ||
      !entry?.maxHoldDeferredPeakPrice ||
      peakRaised
    ) {
      const patched = await patchPositionEntryContext(env.DB, {
        maxHoldDeferredAtMs: deferredAtMs,
        maxHoldDeferredAtPrice: deferredAtPrice,
        maxHoldDeferredMarkPct: deferredMarkPct,
        maxHoldDeferredPeakPrice: peakPrice,
      });
      entry = patched ?? entry;
    }

    if (!hadDeferredState) {
      await logEvent(env.DB, 'SCALP_MAX_HOLD_DEFERRED_LOSS', {
        symbol,
        elapsedMinutes: elapsed.toFixed(1),
        maxHoldMinutes: maxHold,
        mark_pct: markPct,
        lastPrice,
        recoveryStartMinutes: tickCfg.lossRecovery.startMinutes,
        recoveryRetracePct: tickCfg.lossRecovery.retracePct,
        mode: 'tick_loss_recovery_trailing',
      });
    } else if (peakRaised) {
      await logEvent(env.DB, 'SCALP_LOSS_RECOVERY_PEAK_UPDATED', {
        symbol,
        elapsedMinutes: elapsed.toFixed(1),
        deferredAtPrice,
        peakPrice,
        lastPrice,
      });
    }

    if (bn(retracePct).gte(tickCfg.lossRecovery.retracePct)) {
      await logEvent(env.DB, 'SCALP_LOSS_RECOVERY_RETRACE_EXIT', {
        symbol,
        elapsedMinutes: elapsed.toFixed(1),
        deferredAtPrice,
        peakPrice,
        lastPrice,
        retracePct,
        triggerRetracePct: tickCfg.lossRecovery.retracePct,
      });
      if (ocoMode === 'active' && String(env.TRADING_ENABLED) === 'true') {
        await cancelAllOpenOrdersForSymbol(env.DB, gateway.binance, symbol);
        const refreshedAfterCancel = await getBotState(env.DB);
        await closeScalpPosition(env, gateway, refreshedAfterCancel, 'scalp_loss_recovery_retrace_oco');
        return;
      }
      await closeScalpPosition(env, gateway, fresh, 'scalp_loss_recovery_retrace');
      return;
    }

    return;
  }

  if (elapsed !== null && maxHold > 0 && elapsed >= maxHold) {
    if (
      entryMode === 'tick_scalp' &&
      tickCfg?.maxHoldOnlyIfProfitable &&
      bn(markPct).lt(0)
    ) {
      if (!entry?.maxHoldDeferredAtMs) {
        const patched = await patchPositionEntryContext(env.DB, {
          maxHoldDeferredAtMs: Date.now(),
          maxHoldDeferredAtPrice: lastPrice,
          maxHoldDeferredMarkPct: markPct,
          maxHoldDeferredPeakPrice: lastPrice,
        });
        entry = patched ?? entry;
        await logEvent(env.DB, 'SCALP_MAX_HOLD_DEFERRED_LOSS', {
          symbol,
          elapsedMinutes: elapsed.toFixed(1),
          maxHoldMinutes: maxHold,
          mark_pct: markPct,
          lastPrice,
          mode: 'tick_max_hold_only_if_profitable',
        });
      }
      return;
    }

    if (ocoMode === 'active' && String(env.TRADING_ENABLED) === 'true') {
      await cancelAllOpenOrdersForSymbol(env.DB, gateway.binance, symbol);
      const refreshedAfterCancel = await getBotState(env.DB);
      await closeScalpPosition(env, gateway, refreshedAfterCancel, 'scalp_max_hold_oco');
      return;
    }
    await logEvent(env.DB, 'SCALP_EXIT_TIMEOUT', {
      symbol,
      elapsedMinutes: elapsed.toFixed(1),
      maxHoldMinutes: maxHold,
      lastPrice,
      take_profit_price: tp,
    });
    await closeScalpPosition(env, gateway, fresh, 'scalp_max_hold');
  }
}
