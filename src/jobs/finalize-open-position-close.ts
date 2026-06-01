import type { OpenPosition } from '../db/open-positions';
import { removeOpenPosition } from '../db/open-positions';
import { logEvent } from '../db/trade-log';
import { insertTradeFeatures, getRegimeCache } from '../db/trade-features';
import type { TradingGateway } from '../exchange/gateway';
import type { OrderResponse } from '../exchange/binance';
import { subtract, bn } from '../math/decimal';
import { closePositionBestEffort } from './emergency-exit';
import { baseAssetFromSymbol } from '../exchange/fill-utils';
import { getFreeBaseQty } from '../exchange/position-sell';
import {
  formatQuantity,
  meetsMinQty,
  parseSymbolFilters,
} from '../exchange/symbol-filters';
import {
  parsePositionEntryContext,
  pctFromBase,
  outcomeToFeatureRecord,
  type TradeOutcomePayload,
} from '../position/trade-analytics';
import { isScalpEntryMode } from '../db/bot-state';

export interface FinalizeOpenCloseOptions {
  source: string;
}

async function hasRecentNotionalBlock(
  db: D1Database,
  symbol: string,
  withinSeconds = 180,
): Promise<boolean> {
  const row = await db
    .prepare(
      `
      SELECT 1 as hit
      FROM trade_log
      WHERE event_type IN ('SELL_NOTIONAL_TOO_SMALL', 'FREE_BALANCE_SELL_NOTIONAL_TOO_SMALL')
        AND payload LIKE ?
        AND created_at >= datetime('now', ?)
      ORDER BY id DESC
      LIMIT 1
      `,
    )
    .bind(`%"symbol":"${symbol}"%`, `-${withinSeconds} seconds`)
    .first<{ hit: number }>();
  return row?.hit === 1;
}

async function resolveLastPrice(gateway: TradingGateway, symbol: string): Promise<string | null> {
  try {
    const p = await gateway.binance.getSymbolPrice(symbol);
    return bn(p).gt(0) ? p : null;
  } catch {
    const tickers = await gateway.binance.getTicker24hr();
    const t = tickers.find((x) => x.symbol === symbol);
    return t?.lastPrice && bn(t.lastPrice).gt(0) ? t.lastPrice : null;
  }
}

async function detachUnsellableResidualIfNeeded(
  env: Env,
  gateway: TradingGateway,
  position: OpenPosition,
  source: string,
): Promise<boolean> {
  try {
    if (await hasRecentNotionalBlock(env.DB, position.symbol)) {
      await logEvent(env.DB, 'POSITION_DETACHED_UNSELLABLE', {
        symbol: position.symbol,
        position_id: position.id,
        source,
        reason: 'recent_notional_failure',
      });
      await removeOpenPosition(env.DB, position.id);
      return true;
    }

    const info = await gateway.binance.getExchangeInfo(position.symbol);
    const sym = info.symbols[0];
    if (!sym) return false;
    const filters = parseSymbolFilters(sym);

    const free = await getFreeBaseQty(gateway, baseAssetFromSymbol(position.symbol));
    const sellQty = formatQuantity(free, filters.stepSize);
    if (!meetsMinQty(sellQty, filters.minQty)) {
      await logEvent(env.DB, 'POSITION_DETACHED_UNSELLABLE', {
        symbol: position.symbol,
        position_id: position.id,
        source,
        reason: 'min_qty',
        freeBalance: free,
        sellQty,
        minQty: filters.minQty,
      });
      await removeOpenPosition(env.DB, position.id);
      return true;
    }

    const lastPrice = await resolveLastPrice(gateway, position.symbol);
    if (!lastPrice) return false;
    const approxNotional = bn(sellQty).times(lastPrice);
    if (approxNotional.lt(filters.minNotional)) {
      await logEvent(env.DB, 'POSITION_DETACHED_UNSELLABLE', {
        symbol: position.symbol,
        position_id: position.id,
        source,
        reason: 'min_notional',
        freeBalance: free,
        sellQty,
        lastPrice,
        approxNotional: approxNotional.toFixed(8),
        minNotional: filters.minNotional,
      });
      await removeOpenPosition(env.DB, position.id);
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

function buildTradeOutcomeFromOpenPosition(
  position: OpenPosition,
  opts: {
    source: string;
    pnl: string;
    proceeds: string;
    exitPrice: string;
  },
): TradeOutcomePayload {
  const avgCost = position.avg_cost;
  const peak = position.position_peak_price ?? opts.exitPrice;
  const trough = position.position_trough_price ?? opts.exitPrice;
  const entry = parsePositionEntryContext(position.position_entry_context ?? null);

  return {
    symbol: position.symbol,
    entry_mode: position.entry_mode,
    source: opts.source,
    pnl: opts.pnl,
    spent: position.total_usdt_spent,
    proceeds: opts.proceeds,
    avg_cost: avgCost,
    exit_price: opts.exitPrice,
    exit_pct_from_cost: pctFromBase(avgCost, opts.exitPrice),
    max_favorable_pct: pctFromBase(avgCost, peak),
    max_adverse_pct: pctFromBase(avgCost, trough),
    peak_price: peak,
    trough_price: trough,
    entry,
  };
}

export async function finalizeOpenPositionCloseFromFilledOrder(
  env: Env,
  position: OpenPosition,
  order: Pick<OrderResponse, 'orderId' | 'cummulativeQuoteQty'>,
  options: FinalizeOpenCloseOptions,
): Promise<boolean> {
  const proceeds = order.cummulativeQuoteQty ?? '0';
  const pnl = subtract(proceeds, position.total_usdt_spent);

  const soldQty = bn(position.net_base_qty);
  const exitPrice = soldQty.gt(0) ? bn(proceeds).dividedBy(soldQty).toFixed(8) : proceeds;

  const tradeOutcome = isScalpEntryMode(position.entry_mode)
    ? buildTradeOutcomeFromOpenPosition(position, {
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
    symbol: position.symbol,
    proceeds,
    spent: position.total_usdt_spent,
    pnl,
    source: options.source,
    orderId: order.orderId,
    entry_mode: position.entry_mode,
    position_id: position.id,
    ...(tradeOutcome
      ? {
          exit_pct_from_cost: tradeOutcome.exit_pct_from_cost,
          max_favorable_pct: tradeOutcome.max_favorable_pct,
          max_adverse_pct: tradeOutcome.max_adverse_pct,
        }
      : {}),
  });

  if (isScalpEntryMode(position.entry_mode)) {
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
      symbol: position.symbol,
      phase: 'exit',
      entry_mode: position.entry_mode,
      regime,
      outcome: outcomeLabel,
      pnl,
      features: tradeOutcome
        ? outcomeToFeatureRecord(tradeOutcome)
        : {
            source: options.source,
            proceeds,
            spent: position.total_usdt_spent,
            take_profit_price: position.take_profit_price,
            scalp_stop_loss_pct: position.scalp_stop_loss_pct,
          },
    });
  }

  await removeOpenPosition(env.DB, position.id);
  return true;
}

export async function finalizeOpenPositionClose(
  env: Env,
  gateway: TradingGateway,
  position: OpenPosition,
  options: FinalizeOpenCloseOptions,
): Promise<boolean> {
  const sold = await closePositionBestEffort(
    env,
    gateway,
    position.symbol,
    position.net_base_qty,
  );
  if (!sold) {
    const detached = await detachUnsellableResidualIfNeeded(
      env,
      gateway,
      position,
      options.source,
    );
    return detached;
  }

  const order = await gateway.getOrder(position.symbol, sold.orderId);
  if (order.status !== 'FILLED' && String(env.TRADING_ENABLED) === 'true') {
    return false;
  }
  return finalizeOpenPositionCloseFromFilledOrder(env, position, order, options);
}
