import { getBotState } from '../db/bot-state';
import { countOpenPositions, hasOpenPositionForSymbol } from '../db/open-positions';
import {
  getTickScalpConfig,
  getTradingConfig,
  getScalpConfig,
  isTickEntryExecuteEnabled,
  isTickScalpEnabled,
} from '../db/bot-config';
import { listWatchlist } from '../db/watchlist';
import { logEvent } from '../db/trade-log';
import { TradingGateway } from '../exchange/gateway';
import type { TickScanRow } from '../durable-objects/market-data-do';
import { isSystemTradeBlockedSymbol } from '../config/system-trade-rules';
import { tryScalpEntry } from './scalp-entry';
import { recordTickShadowFromSignal } from './tick-shadow-record';

export interface TickFirePayload {
  symbol: string;
  signalId: string;
  row: TickScanRow;
  firedAtMs: number;
}

export async function handleTickFire(env: Env, payload: TickFirePayload): Promise<Response> {
  const symbol = payload.symbol?.toUpperCase();
  if (!symbol?.endsWith('USDT')) {
    return Response.json({ ok: false, reason: 'invalid_symbol' }, { status: 400 });
  }

  if (isSystemTradeBlockedSymbol(symbol)) {
    await logEvent(env.DB, 'TICK_FIRE_REJECTED', {
      symbol,
      signalId: payload.signalId,
      reason: 'system_symbol_blocked',
    });
    return Response.json({ ok: false, reason: 'system_symbol_blocked' });
  }

  if (!(await isTickScalpEnabled(env.DB, env))) {
    await logEvent(env.DB, 'TICK_FIRE_REJECTED', {
      symbol,
      signalId: payload.signalId,
      reason: 'tick_scalp_disabled',
    });
    return Response.json({ ok: false, reason: 'tick_scalp_disabled' });
  }

  const state = await getBotState(env.DB);
  if (state.status === 'MANUAL_INTERVENTION' || state.status === 'ERROR') {
    await logEvent(env.DB, 'TICK_FIRE_REJECTED', {
      symbol,
      signalId: payload.signalId,
      reason: 'bot_state_blocked',
      status: state.status,
    });
    return Response.json({ ok: false, reason: 'bot_state_blocked', status: state.status });
  }

  const row = payload.row;
  if (!row?.pass || !row.reversalOk || row.stale) {
    await logEvent(env.DB, 'TICK_FIRE_REJECTED', {
      symbol,
      signalId: payload.signalId,
      reason: 'signal_not_eligible',
      pass: row?.pass,
      reversalOk: row?.reversalOk,
      aggBurstOk: row?.aggBurstOk,
      stale: row?.stale,
      failReason: row?.failReason ?? row?.reversalFailReason ?? row?.aggBurstFailReason,
    });
    return Response.json({ ok: false, reason: 'signal_not_eligible' });
  }

  const watchlist = await listWatchlist(env.DB);
  const entry = watchlist.find((w) => w.symbol === symbol);
  if (!entry) {
    await logEvent(env.DB, 'TICK_FIRE_REJECTED', {
      symbol,
      signalId: payload.signalId,
      reason: 'not_in_watchlist',
    });
    return Response.json({ ok: false, reason: 'not_in_watchlist' });
  }

  const tick = await getTickScalpConfig(env.DB, env);
  const [openPositionCount, alreadyOpenSymbol] = await Promise.all([
    countOpenPositions(env.DB, { entryMode: 'tick_scalp' }),
    hasOpenPositionForSymbol(env.DB, symbol),
  ]);
  if (alreadyOpenSymbol) {
    await logEvent(env.DB, 'TICK_FIRE_REJECTED', {
      symbol,
      signalId: payload.signalId,
      reason: 'already_open_symbol',
      openPositionCount,
    });
    return Response.json({ ok: false, reason: 'already_open_symbol' });
  }
  if (openPositionCount >= tick.maxOpenPositions) {
    await logEvent(env.DB, 'TICK_FIRE_REJECTED', {
      symbol,
      signalId: payload.signalId,
      reason: 'max_open_positions_reached',
      openPositionCount,
      maxOpenPositions: tick.maxOpenPositions,
    });
    return Response.json({
      ok: false,
      reason: 'max_open_positions_reached',
      openPositionCount,
      maxOpenPositions: tick.maxOpenPositions,
    });
  }
  const trading = await getTradingConfig(env.DB, env);
  const scalp = await getScalpConfig(env.DB, env);
  const executeEntries = await isTickEntryExecuteEnabled(env.DB, env);
  const gateway = new TradingGateway(env);

  await logEvent(env.DB, 'TICK_WS_SIGNAL', {
    symbol,
    signalId: payload.signalId,
    firedAtMs: payload.firedAtMs,
    gainPct: row.gainPct,
    recoveryFromWsLowPct: row.recoveryFromWsLowPct,
    reversalScore: row.reversalScore,
    secSinceTrough: row.secSinceTrough,
    wsDeclinePct: row.wsDeclinePct,
    aggBurstOk: row.aggBurstOk,
    aggBuyCount: row.aggBuyCount,
    aggBuyQuoteUsdt: row.aggBuyQuoteUsdt,
    aggImbalance: row.aggImbalance,
    executeEntries,
  });

  const signalPayload = {
    symbol,
    scoutPrice: entry.price_at_addition,
    scoutAddedAt: entry.added_at,
    gainPct: row.gainPct,
    recoveryFromWsLowPct: row.recoveryFromWsLowPct,
    secSinceTrough: row.secSinceTrough,
    reversalScore: row.reversalScore,
    reversalOk: row.reversalOk,
    source: 'ws_do',
    signalId: payload.signalId,
    mid: row.mid,
    bidAskRatio: row.bidAskRatio,
    spreadPct: row.spreadPct,
    aggBurstOk: row.aggBurstOk,
    aggBuyCount: row.aggBuyCount,
    aggBuyQuoteUsdt: row.aggBuyQuoteUsdt,
    aggImbalance: row.aggImbalance,
    executeEntries,
  };

  await logEvent(env.DB, 'TICK_ENTRY_SIGNAL', signalPayload);
  await recordTickShadowFromSignal(env, tick, {
    symbol,
    mid: row.mid,
    scoutPrice: entry.price_at_addition,
    row,
  });

  if (!executeEntries) {
    await logEvent(env.DB, 'TICK_FIRE_REJECTED', {
      symbol,
      signalId: payload.signalId,
      reason: 'tick_signal_only',
    });
    return Response.json({ ok: true, entered: false, reason: 'tick_signal_only' });
  }

  const indexBySymbol = new Map(watchlist.map((e, i) => [e.symbol, i]));
  const entered = await tryScalpEntry(env, entry, {
    gateway,
    quoteUsdt: trading.buyQuoteUsdt,
    scalp,
    entryIndex: indexBySymbol.get(symbol) ?? 0,
    entryMode: 'tick_scalp',
    fixedTpPct: tick.takeProfitPct,
    fixedSlPct: tick.stopLossPct,
    skipDynamicTargets: true,
    tickDetail: {
      gainPct: row.gainPct,
      recoveryFromWsLowPct: row.recoveryFromWsLowPct,
      secSinceTrough: row.secSinceTrough,
      reversalScore: row.reversalScore,
      candleLow: row.candleLow,
      candleOpen: row.candleOpen,
      candleOpenTime: row.candleOpenTime,
      mid: row.mid,
      bidAskRatio: row.bidAskRatio,
      spreadPct: row.spreadPct,
      trend5mOk: row.trend5mOk,
      wsDeclinePct: row.wsDeclinePct,
      wsDeclineOk: row.wsDeclineOk,
      aggBurstOk: row.aggBurstOk,
      aggBuyCount: row.aggBuyCount,
      aggBuyQuoteUsdt: row.aggBuyQuoteUsdt,
      aggImbalance: row.aggImbalance,
      referenceWindowSec: tick.referenceWindowSec,
      scoutPrice: entry.price_at_addition,
      scoutAddedAt: entry.added_at,
      signalId: payload.signalId,
      source: 'ws_do',
    },
  });

  if (entered) {
    await logEvent(env.DB, 'TICK_FIRE_ACCEPTED', {
      symbol,
      signalId: payload.signalId,
      reversalScore: row.reversalScore,
    });
    return Response.json({ ok: true, entered: true });
  }

  await logEvent(env.DB, 'TICK_FIRE_REJECTED', {
    symbol,
    signalId: payload.signalId,
    reason: 'tick_entry_failed',
    reversalScore: row.reversalScore,
  });
  return Response.json({ ok: true, entered: false, reason: 'tick_entry_failed' });
}
