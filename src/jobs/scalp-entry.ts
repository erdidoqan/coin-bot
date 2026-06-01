import type { ScalpConfig, TickScalpConfig } from '../db/bot-config';
import {
  getMicroScalpConfig,
  getTickScalpConfig,
  isTickEntryExecuteEnabled,
} from '../db/bot-config';
import {
  openPosition,
  computeAvgCost,
  isScalpEntryMode,
  type EntryMode,
} from '../db/bot-state';
import {
  createOpenPosition,
  countOpenPositions,
  hasOpenPositionForSymbol,
} from '../db/open-positions';
import { logEvent } from '../db/trade-log';
import { insertTradeFeatures } from '../db/trade-features';
import {
  TradingGateway,
  netQtyFromBuy,
  type ScalpOcoOrderResult,
} from '../exchange/gateway';
import {
  formatQuantity,
  formatPrice,
  meetsMinNotional,
  meetsMinQty,
  parseSymbolFilters,
} from '../exchange/symbol-filters';
import { bn } from '../math/decimal';
import type { WatchlistEntry } from '../db/watchlist';
import {
  computeDynamicScalpTargets,
  passesMinNetTpGate,
} from '../indicators/dynamic-scalp-targets';
import { atrPctFromKlines, closedCandlesOnly } from '../indicators/technical';
import { fetchKlinesFromDo, fetchTickRef } from '../exchange/market-data-client';
import { passesTickGainBand } from '../indicators/tick-entry';
import {
  buildPositionEntryContext,
  entryContextToLogPayload,
  initPositionAnalytics,
  initOpenPositionAnalytics,
} from '../position/trade-analytics';
import { passesScoutPriceBand } from '../indicators/tick-reversal';
import type { OrderResponse } from '../exchange/binance';
import type { TickRefSnapshot } from '../durable-objects/market-data-do';
import { isSystemTradeBlockedSymbol } from '../config/system-trade-rules';

const LIMIT_FILL_POLL_MS = 400;
type TickEntryProfile = 'A' | 'B' | 'C';

export interface ScalpEntryContext {
  gateway: TradingGateway;
  quoteUsdt: string;
  scalp: ScalpConfig;
  entryIndex: number;
  regime?: string | null;
  entryMode?: EntryMode;
  fixedTpPct?: string;
  fixedSlPct?: string;
  skipDynamicTargets?: boolean;
  tickDetail?: Record<string, unknown>;
}

export async function tryScalpEntry(
  env: Env,
  entry: WatchlistEntry,
  ctx: ScalpEntryContext,
): Promise<boolean> {
  const symbol = entry.symbol;
  const entryMode = ctx.entryMode ?? 'micro_scalp';

  if (isSystemTradeBlockedSymbol(symbol)) {
    const payload = {
      symbol,
      reason: 'system_symbol_blocked',
      entry_mode: entryMode,
    };
    if (entryMode === 'tick_scalp') {
      await logEvent(env.DB, 'TICK_ENTRY_GATE_FAIL', payload);
    } else {
      await logEvent(env.DB, 'SNIPER_SKIP', payload);
    }
    return false;
  }

  if (entryMode === 'tick_scalp' && !(await isTickEntryExecuteEnabled(env.DB, env))) {
    await logEvent(env.DB, 'SNIPER_SKIP', {
      reason: 'tick_entry_execute_disabled',
      symbol,
      entry_mode: entryMode,
    });
    return false;
  }

  let tpGrossPct = ctx.fixedTpPct ?? ctx.scalp.takeProfitGrossPct;
  let slGrossPct = ctx.fixedSlPct ?? ctx.scalp.hardStopLossPct;
  let atrPct: string | null = null;
  let dynamicBand: string | null = null;

  if (!ctx.skipDynamicTargets && entryMode === 'micro_scalp') {
    try {
      let klines1m = await fetchKlinesFromDo(env, symbol, '1m', 20);
      if (!klines1m?.length) {
        klines1m = await ctx.gateway.binance.getKlines(symbol, '1m', 20);
      }
      const closed = closedCandlesOnly(klines1m);
      atrPct = atrPctFromKlines(closed, 14);
      if (atrPct) {
        const dyn = computeDynamicScalpTargets(atrPct);
        dynamicBand = dyn.band;
        tpGrossPct = dyn.tpGrossPct;
        slGrossPct = dyn.slGrossPct;
      }
    } catch {
      /* fallback config TP/SL */
    }
  }

  const micro = await getMicroScalpConfig(env.DB, env);
  const tickCfg = entryMode === 'tick_scalp' ? await getTickScalpConfig(env.DB, env) : null;
  let tickRef: Awaited<ReturnType<typeof fetchTickRef>> | null = null;
  let tickSizePctAtEntry: string | null = null;
  let scoutVsFillAtGate: string | null = null;
  let tickEntryProfile: TickEntryProfile | null = null;
  let profileTpPct: string | null = null;
  let profileMaxHoldMinutes: number | null = null;
  const feeRoundtrip = tickCfg?.feeRoundtripPct ?? micro.feeRoundtripPct;
  const minNetTp = tickCfg?.minNetTpPct ?? micro.minNetTpPct;

  if (!passesMinNetTpGate(tpGrossPct, feeRoundtrip, minNetTp)) {
    await logEvent(env.DB, 'MIN_NET_TP_SKIP', {
      symbol,
      tpGrossPct,
      feeRoundtripPct: feeRoundtrip,
      minNetTpPct: minNetTp,
    });
    return false;
  }

  const info = await ctx.gateway.binance.getExchangeInfo(symbol);
  const symInfo = info.symbols[0];
  if (!symInfo) return false;

  const filters = parseSymbolFilters(symInfo);
  if (!meetsMinNotional(ctx.quoteUsdt, filters.minNotional)) {
    await logEvent(env.DB, 'MIN_NOTIONAL_SKIP', {
      symbol,
      quoteUsdt: ctx.quoteUsdt,
      minNotional: filters.minNotional,
      entry_mode: entryMode,
    });
    return false;
  }

  if (entryMode === 'tick_scalp' && tickCfg) {
    const [openPositionCount, symbolAlreadyOpen] = await Promise.all([
      countOpenPositions(env.DB, { entryMode: 'tick_scalp' }),
      hasOpenPositionForSymbol(env.DB, symbol),
    ]);
    if (symbolAlreadyOpen) {
      await logEvent(env.DB, 'TICK_ENTRY_GATE_FAIL', {
        symbol,
        failReason: 'already_open_symbol',
        openPositionCount,
      });
      return false;
    }
    if (openPositionCount >= tickCfg.maxOpenPositions) {
      await logEvent(env.DB, 'TICK_ENTRY_GATE_FAIL', {
        symbol,
        failReason: 'max_open_positions_reached',
        openPositionCount,
        maxOpenPositions: tickCfg.maxOpenPositions,
      });
      return false;
    }

    const signalRef = buildTickRefFromSignalDetail(symbol, ctx.tickDetail);
    tickRef = signalRef ?? (await fetchTickRef(env, symbol, tickCfg));
    const bandOk = passesTickGainBand(
      tickRef?.gainPct ?? null,
      tickCfg.entryGainPct,
      tickCfg.entryGainMaxPct,
    );
    if (!tickRef?.pass || !bandOk) {
      await logEvent(env.DB, 'TICK_ENTRY_GATE_FAIL', {
        symbol,
        failReason: tickRef?.failReason ?? 'no_tick_ref',
        gateRefSource: signalRef ? 'tick_signal_snapshot' : 'do_refetch',
        gainPct: tickRef?.gainPct ?? null,
        minGainPct: tickCfg.entryGainPct,
        maxGainPct: tickCfg.entryGainMaxPct,
        wsDeclineOk: tickRef?.wsDeclineOk ?? null,
        recoveryPct: tickRef?.recoveryFromWsLowPct ?? null,
        reversalOk: tickRef?.reversalOk ?? null,
        bandOk,
      });
      return false;
    }

    const scoutCheck = passesScoutPriceBand(
      entry.price_at_addition,
      tickRef.mid,
      tickCfg.scoutMaxBelowPct,
      tickCfg.scoutMaxAbovePct,
    );
    scoutVsFillAtGate = scoutCheck.scoutVsFillPct;
    if (!scoutCheck.ok) {
      await logEvent(env.DB, 'TICK_ENTRY_GATE_FAIL', {
        symbol,
        failReason: scoutCheck.failReason,
        scoutPrice: entry.price_at_addition,
        mid: tickRef.mid,
        scoutVsFillPct: scoutCheck.scoutVsFillPct,
      });
      return false;
    }

    const tickPriceRef = tickRef.mid;
    const tickSizePct = bn(filters.tickSize)
      .dividedBy(tickPriceRef)
      .times(100)
      .toFixed(6);
    tickSizePctAtEntry = tickSizePct;
    if (bn(tickSizePct).gt(tickCfg.maxTickSizePct)) {
      await logEvent(env.DB, 'TICK_ENTRY_GATE_FAIL', {
        symbol,
        failReason: 'tick_size_too_coarse',
        tickSize: filters.tickSize,
        tickSizePct,
        maxTickSizePct: tickCfg.maxTickSizePct,
        mid: tickPriceRef,
      });
      return false;
    }

    tickEntryProfile = classifyTickEntryProfile(
      {
        spreadPct: tickRef.spreadPct,
        scoutVsFillPct: scoutVsFillAtGate,
        gainPct: tickRef.gainPct,
        secSinceTrough: tickRef.secSinceTrough,
      },
      tickCfg,
    );
    profileTpPct = resolveProfileTakeProfitPct(tickEntryProfile, tickCfg);
    profileMaxHoldMinutes = resolveProfileMaxHoldMinutes(tickEntryProfile, tickCfg);
    tpGrossPct = profileTpPct;
    await logEvent(env.DB, 'TICK_PROFILE_ASSIGNED', {
      symbol,
      profile: tickEntryProfile,
      spreadPct: tickRef.spreadPct,
      scoutVsFillPct: scoutVsFillAtGate,
      gainPct: tickRef.gainPct,
      secSinceTrough: tickRef.secSinceTrough,
      profile_take_profit_pct: profileTpPct,
      profile_max_hold_minutes: profileMaxHoldMinutes,
    });
  }

  const buyOrder =
    entryMode === 'tick_scalp' && tickCfg && tickCfg.useLimitMaker && String(env.TRADING_ENABLED) === 'true'
      ? await placeTickLimitMakerBuy(env, entry, ctx, tickCfg, symbol, filters)
      : await ctx.gateway.marketBuy(symbol, ctx.quoteUsdt);
  if (!buyOrder) {
    await logEvent(env.DB, 'ENTRY_ORDER_NOT_FILLED', {
      symbol,
      entry_mode: entryMode,
      mode: 'limit_maker',
      quoteUsdt: ctx.quoteUsdt,
    });
    return false;
  }
  const net = netQtyFromBuy(buyOrder, symbol);

  if (net.commission_in_base) {
    await logEvent(env.DB, 'COMMISSION_IN_BASE_ASSET', {
      symbol,
      commission: net.commission_base_total,
      hint: 'Hesapta 5-10 USDT değerinde BNB bulundurun',
    });
  }

  await logEvent(env.DB, 'BUY_FILLED', { symbol, order: buyOrder, entry_mode: entryMode });
  await logEvent(env.DB, 'NET_QTY_COMPUTED', { symbol, ...net });

  const sellQty = formatQuantity(net.net_base_qty, filters.stepSize);
  if (!meetsMinQty(sellQty, filters.minQty)) {
    await logEvent(env.DB, 'LOT_SIZE_TOO_SMALL', {
      symbol,
      sellQty,
      minQty: filters.minQty,
      entry_mode: entryMode,
    });
    return false;
  }

  const usdtSpent = buyOrder.cummulativeQuoteQty ?? ctx.quoteUsdt;
  const avgCost = computeAvgCost(usdtSpent, net.net_base_qty);
  const takeProfitRaw = bn(avgCost)
    .times(bn(100).plus(tpGrossPct))
    .dividedBy(100);
  const takeProfitPrice = formatPrice(takeProfitRaw.toFixed(), filters.tickSize);
  const stopLossRaw = bn(avgCost)
    .times(bn(100).minus(slGrossPct))
    .dividedBy(100);
  const stopLossPrice = formatPrice(stopLossRaw.toFixed(), filters.tickSize);
  const stopLimitBufferPct = tickCfg?.stopLimitBufferPct ?? '0.05';
  const stopLossLimitRaw = bn(stopLossPrice)
    .times(bn(100).minus(stopLimitBufferPct))
    .dividedBy(100);
  const stopLossLimitPrice = formatPrice(stopLossLimitRaw.toFixed(), filters.tickSize);
  let protectiveOco: ScalpOcoOrderResult | null = null;

  let featureDetail: Record<string, unknown> = ctx.tickDetail ?? {};
  if (!ctx.tickDetail) {
    try {
      featureDetail = entry.micro_detail ? JSON.parse(entry.micro_detail) : {};
    } catch {
      featureDetail = {};
    }
  }

  let openedPositionId: number | null = null;
  if (entryMode === 'tick_scalp') {
    const created = await createOpenPosition(env.DB, {
      symbol,
      entry_mode: entryMode,
      net_base_qty: net.net_base_qty,
      total_usdt_spent: usdtSpent,
      total_base_qty: net.gross_base_qty,
      avg_cost: avgCost,
      trailing_order_id: null,
      active_order_id: null,
      take_profit_price: takeProfitPrice,
      scalp_stop_loss_pct: slGrossPct,
      watchlist_cursor: ctx.entryIndex,
    });
    openedPositionId = created.id;
  } else {
    await openPosition(env.DB, {
      status: 'TIER_1_BULL',
      active_symbol: symbol,
      net_base_qty: net.net_base_qty,
      total_usdt_spent: usdtSpent,
      total_base_qty: net.gross_base_qty,
      avg_cost: avgCost,
      trailing_order_id: null,
      entry_mode: entryMode,
      take_profit_price: takeProfitPrice,
      scalp_stop_loss_pct: slGrossPct,
      watchlist_cursor: ctx.entryIndex,
    });
  }

  if (entryMode === 'tick_scalp' && String(env.TRADING_ENABLED) === 'true') {
    if (bn(takeProfitPrice).lte(stopLossPrice) || bn(stopLossLimitPrice).gte(stopLossPrice)) {
      await logEvent(env.DB, 'SCALP_OCO_PLACE_FAILED', {
        symbol,
        quantity: sellQty,
        take_profit_limit_price: takeProfitPrice,
        stop_loss_stop_price: stopLossPrice,
        stop_loss_limit_price: stopLossLimitPrice,
        message: 'invalid_protection_band',
      });
    } else {
      try {
        protectiveOco = await ctx.gateway.placeScalpOcoExit(
          symbol,
          sellQty,
          takeProfitPrice,
          stopLossPrice,
          stopLossLimitPrice,
        );
        if (protectiveOco) {
          await logEvent(env.DB, 'SCALP_OCO_PLACED', {
            symbol,
            quantity: sellQty,
            take_profit_limit_price: takeProfitPrice,
            stop_loss_stop_price: stopLossPrice,
            stop_loss_limit_price: stopLossLimitPrice,
            orderListId: protectiveOco.orderListId,
            takeProfitOrderId: protectiveOco.takeProfitOrderId,
            stopLossOrderId: protectiveOco.stopLossOrderId,
            entry_mode: entryMode,
          });
        }
      } catch (err) {
        await logEvent(env.DB, 'SCALP_OCO_PLACE_FAILED', {
          symbol,
          quantity: sellQty,
          take_profit_limit_price: takeProfitPrice,
          stop_loss_stop_price: stopLossPrice,
          stop_loss_limit_price: stopLossLimitPrice,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  if (isScalpEntryMode(entryMode)) {
    const entryContext = buildPositionEntryContext(entry, entryMode, avgCost, {
      tickDetail: ctx.tickDetail,
      takeProfitPrice,
      takeProfitGrossPct: tpGrossPct,
      stopLossGrossPct: slGrossPct,
      protectiveOco,
      tickEntryProfile,
      profileMaxHoldMinutes,
      failFastUntilMs:
        entryMode === 'tick_scalp' && tickCfg && tickCfg.failFast.enabled
          ? Date.now() + tickCfg.failFast.windowSec * 1000
          : null,
      failFastMinFavorablePct:
        entryMode === 'tick_scalp' && tickCfg && tickCfg.failFast.enabled
          ? tickCfg.failFast.minFavorablePct
          : null,
      failFastMaxAdversePct:
        entryMode === 'tick_scalp' && tickCfg && tickCfg.failFast.enabled
          ? tickCfg.failFast.maxAdversePct
          : null,
      stepLockStage: 0,
      lockedStopPrice: stopLossPrice,
      lockedStopPct: null,
      stepLockConfig:
        entryMode === 'tick_scalp' && tickCfg
          ? {
              enabled: tickCfg.stepLock.enabled,
              stage1TriggerPct: tickCfg.stepLock.stage1TriggerPct,
              stage1LockPct: tickCfg.stepLock.stage1LockPct,
              stage2TriggerPct: tickCfg.stepLock.stage2TriggerPct,
              stage2LockPct: tickCfg.stepLock.stage2LockPct,
            }
          : null,
    });
    if (entryMode === 'tick_scalp' && openedPositionId != null) {
      await initOpenPositionAnalytics(env.DB, openedPositionId, entryContext, avgCost);
    } else {
      await initPositionAnalytics(env.DB, entryContext, avgCost);
    }
    await logEvent(env.DB, 'TRADE_ENTER', entryContextToLogPayload(entryContext));
  }

  await logEvent(env.DB, 'SCALP_ENTER', {
    symbol,
    avg_cost: avgCost,
    take_profit_price: takeProfitPrice,
    take_profit_gross_pct: tpGrossPct,
    stop_loss_gross_pct: slGrossPct,
    stop_loss_price: stopLossPrice,
    tick_size_pct: tickSizePctAtEntry,
    scout_vs_fill_pct: scoutVsFillAtGate,
    entry_profile: tickEntryProfile,
    profile_take_profit_pct: profileTpPct,
    profile_max_hold_minutes: profileMaxHoldMinutes,
    stop_loss_limit_price: stopLossLimitPrice,
    atrPct,
    dynamicBand,
    sellQty,
    entry_mode: entryMode,
    protective_exit: protectiveOco ? 'oco' : 'internal_reconcile',
  });
  await logEvent(env.DB, 'SCALP_TARGET_SET', {
    symbol,
    take_profit_price: takeProfitPrice,
    gross_pct: tpGrossPct,
    stop_pct: slGrossPct,
    stop_loss_price: stopLossPrice,
    tick_size_pct: tickSizePctAtEntry,
    scout_vs_fill_pct: scoutVsFillAtGate,
    entry_profile: tickEntryProfile,
    profile_take_profit_pct: profileTpPct,
    profile_max_hold_minutes: profileMaxHoldMinutes,
    stop_loss_limit_price: stopLossLimitPrice,
    fee_roundtrip_pct: ctx.scalp.feeRoundtripPct,
    protective_exit: protectiveOco ? 'oco' : 'internal_reconcile',
    oco_order_list_id: protectiveOco?.orderListId ?? null,
  });

  await insertTradeFeatures(env.DB, {
    symbol,
    phase: 'entry',
    entry_mode: entryMode,
    regime: ctx.regime ?? null,
    features: {
      ...featureDetail,
      atrPct,
      dynamicBand,
      tpGrossPct,
      slGrossPct,
      avgCost,
      takeProfitPrice,
      sector: entry.sector_tag,
    },
  });

  return true;
}

async function placeTickLimitMakerBuy(
  env: Env,
  entry: WatchlistEntry,
  ctx: ScalpEntryContext,
  tickCfg: TickScalpConfig,
  symbol: string,
  filters: ReturnType<typeof parseSymbolFilters>,
): Promise<OrderResponse | null> {
  const refPrice = resolveTickEntryRefPrice(entry, ctx);
  if (!refPrice || bn(refPrice).lte(0)) {
    await logEvent(env.DB, 'TICK_LIMIT_BUY_SKIP', {
      symbol,
      reason: 'no_reference_price',
      entry_mode: 'tick_scalp',
    });
    return null;
  }

  const limitPriceRaw = bn(refPrice)
    .times(bn(100).minus(tickCfg.limitBuyOffsetPct))
    .dividedBy(100);
  const limitPrice = formatPrice(limitPriceRaw.toFixed(), filters.tickSize);
  if (bn(limitPrice).lte(0)) return null;

  const qtyRaw = bn(ctx.quoteUsdt).dividedBy(limitPrice);
  const qty = formatQuantity(qtyRaw.toFixed(), filters.stepSize);
  const notional = bn(qty).times(limitPrice).toFixed(8);
  if (!meetsMinQty(qty, filters.minQty) || !meetsMinNotional(notional, filters.minNotional)) {
    await logEvent(env.DB, 'TICK_LIMIT_BUY_SKIP', {
      symbol,
      reason: 'limit_qty_or_notional_invalid',
      qty,
      minQty: filters.minQty,
      notional,
      minNotional: filters.minNotional,
      limit_price: limitPrice,
      ref_price: refPrice,
    });
    return null;
  }

  const order = await ctx.gateway.placeLimitMakerBuy(symbol, qty, limitPrice);
  await logEvent(env.DB, 'TICK_LIMIT_BUY_PLACED', {
    symbol,
    orderId: order.orderId,
    qty,
    limit_price: limitPrice,
    ref_price: refPrice,
    offset_pct: tickCfg.limitBuyOffsetPct,
    ttl_sec: tickCfg.entryOrderTtlSec,
  });

  const finalState = await waitForOrderFinalState(
    ctx.gateway,
    symbol,
    order.orderId,
    tickCfg.entryOrderTtlSec * 1000,
  );
  if (!finalState) {
    try {
      await ctx.gateway.cancelOrder(symbol, order.orderId);
    } catch {
      /* zaten kapanmış olabilir */
    }
    const latest = await ctx.gateway.getOrder(symbol, order.orderId);
    if (latest.status === 'FILLED') {
      return latest;
    }
    const executedQty = bn(latest.executedQty ?? '0');
    if (executedQty.gt(0) && meetsMinQty(executedQty.toFixed(), filters.minQty)) {
      await logEvent(env.DB, 'TICK_LIMIT_BUY_PARTIAL_ACCEPTED', {
        symbol,
        orderId: order.orderId,
        status: latest.status,
        executedQty: latest.executedQty,
        cummulativeQuoteQty: latest.cummulativeQuoteQty,
      });
      return latest;
    }
    await logEvent(env.DB, 'TICK_LIMIT_BUY_TIMEOUT', {
      symbol,
      orderId: order.orderId,
      status: latest.status,
      executedQty: latest.executedQty,
      cummulativeQuoteQty: latest.cummulativeQuoteQty,
      ttl_sec: tickCfg.entryOrderTtlSec,
    });
    return null;
  }
  return finalState;
}

async function waitForOrderFinalState(
  gateway: TradingGateway,
  symbol: string,
  orderId: string | number,
  timeoutMs: number,
): Promise<OrderResponse | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const order = await gateway.getOrder(symbol, orderId);
    if (order.status === 'FILLED') return order;
    if (order.status === 'CANCELED' || order.status === 'EXPIRED' || order.status === 'REJECTED') {
      return null;
    }
    await sleep(LIMIT_FILL_POLL_MS);
  }
  return null;
}

function resolveTickEntryRefPrice(
  entry: WatchlistEntry,
  ctx: ScalpEntryContext,
): string | null {
  const mid = ctx.tickDetail?.mid;
  if (mid != null && bn(String(mid)).gt(0)) {
    return String(mid);
  }
  if (entry.price_at_addition && bn(entry.price_at_addition).gt(0)) {
    return entry.price_at_addition;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildTickRefFromSignalDetail(
  symbol: string,
  detail?: Record<string, unknown>,
): TickRefSnapshot | null {
  if (!detail) return null;
  const mid = asString(detail.mid);
  if (!mid || bn(mid).lte(0)) return null;

  const candleOpen = asString(detail.candleOpen) ?? mid;
  const candleLow = asString(detail.candleLow) ?? mid;
  const secSinceTrough = asNumber(detail.secSinceTrough);
  const reversalScore = asNumber(detail.reversalScore);

  return {
    symbol,
    mid,
    candleLow,
    candleOpen,
    candleOpenTime: asNumber(detail.candleOpenTime) ?? Date.now(),
    candleIsClosed: false,
    gainPct: nullableString(detail.gainPct),
    bidAskRatio: asNumber(detail.bidAskRatio) ?? 0,
    spreadPct: asNumber(detail.spreadPct) ?? 0,
    pass: true,
    failReason: null,
    trend5mOk: asBool(detail.trend5mOk) ?? true,
    trend5mFailReason: null,
    wsDeclinePct: nullableString(detail.wsDeclinePct),
    wsDeclineOk: asBool(detail.wsDeclineOk) ?? true,
    wsDeclineFailReason: null,
    recoveryFromWsLowPct: nullableString(detail.recoveryFromWsLowPct),
    midSlopeOk: true,
    secSinceTrough,
    reversalScore: reversalScore ?? 0,
    reversalOk: true,
    reversalFailReason: null,
    aggBurstOk: asBool(detail.aggBurstOk) ?? true,
    aggBurstFailReason: null,
    aggBuyCount: asNumber(detail.aggBuyCount) ?? 0,
    aggBuyQuoteUsdt: nullableString(detail.aggBuyQuoteUsdt),
    aggSellQuoteUsdt: null,
    aggImbalance: nullableString(detail.aggImbalance),
    updatedAt: Date.now(),
    stale: false,
  };
}

function classifyTickEntryProfile(
  metrics: {
    spreadPct: number | null;
    scoutVsFillPct: string | null;
    gainPct: string | null;
    secSinceTrough: number | null;
  },
  cfg: TickScalpConfig,
): TickEntryProfile {
  const a = cfg.profileGate.a;
  const b = cfg.profileGate.b;
  const spread = metrics.spreadPct;
  const scoutVsFill = metrics.scoutVsFillPct;
  const gainPct = metrics.gainPct;
  const secSinceTrough = metrics.secSinceTrough;

  const isA =
    spread != null &&
    spread < Number(a.maxSpreadPct) &&
    scoutVsFill != null &&
    bn(scoutVsFill).lte(a.maxScoutVsFillPct) &&
    gainPct != null &&
    bn(gainPct).gte(a.minGainPct) &&
    bn(gainPct).lte(a.maxGainPct) &&
    secSinceTrough != null &&
    secSinceTrough >= a.minSecSinceTrough &&
    secSinceTrough <= a.maxSecSinceTrough;
  if (isA) return 'A';

  const isB =
    (spread != null && spread <= Number(b.maxSpreadPct)) ||
    (scoutVsFill != null && bn(scoutVsFill).lte(b.maxScoutVsFillPct));
  return isB ? 'B' : 'C';
}

function resolveProfileTakeProfitPct(profile: TickEntryProfile, cfg: TickScalpConfig): string {
  if (profile === 'A') return cfg.profileExit.a.takeProfitPct;
  if (profile === 'B') return cfg.profileExit.b.takeProfitPct;
  return cfg.profileExit.c.takeProfitPct;
}

function resolveProfileMaxHoldMinutes(profile: TickEntryProfile, cfg: TickScalpConfig): number {
  if (profile === 'A') return cfg.profileExit.a.maxHoldMinutes;
  if (profile === 'B') return cfg.profileExit.b.maxHoldMinutes;
  return cfg.profileExit.c.maxHoldMinutes;
}

function asString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function nullableString(value: unknown): string | null {
  const str = asString(value);
  return str == null || str === 'null' ? null : str;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asBool(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    if (value === 'true' || value === '1') return true;
    if (value === 'false' || value === '0') return false;
  }
  return null;
}
