import { getConfig } from '../db/bot-config';
import { getBotState } from '../db/bot-state';
import {
  ensureMockTrailingPlacedAt,
  getMockTrailingActivationStop,
  getMockTrailingPlacedAt,
  updateMockTrailingPeak,
} from '../db/mock-sim';
import { logEvent } from '../db/trade-log';
import { bn } from '../math/decimal';
import type { OrderResponse } from './binance';

const DEFAULT_MAX_HOLD_MINUTES = 240;

function parsePlacedAtMs(iso: string): number {
  const ms = Date.parse(iso.replace(' ', 'T') + 'Z');
  return Number.isNaN(ms) ? Date.now() : ms;
}

function maxHoldMinutes(env: Env): number {
  const raw = env.MOCK_MAX_HOLD_MINUTES;
  if (raw === undefined || raw === '') return DEFAULT_MAX_HOLD_MINUTES;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_HOLD_MINUTES;
}

/**
 * Dry-run: TAKE_PROFIT iki kademeli trailing.
 * 1) lastPrice < activationStop → NEW, zirve yok
 * 2) lastPrice >= activationStop → zirve takibi
 * 3) lastPrice <= peak * (1 - tightPct/100) → FILLED
 */
export async function simulateMockTrailingOrder(
  env: Env,
  symbol: string,
  orderId: number,
  lastPrice: string,
): Promise<OrderResponse | null> {
  const state = await getBotState(env.DB);
  if (state.trailing_order_id !== String(orderId)) return null;

  const activationStop = await getMockTrailingActivationStop(env.DB);
  if (!activationStop) return null;

  await ensureMockTrailingPlacedAt(env.DB, state.updated_at);

  const sleeping = bn(lastPrice).lt(activationStop);
  if (sleeping) {
    return {
      symbol,
      orderId,
      status: 'NEW',
      executedQty: '0',
      cummulativeQuoteQty: '0',
      side: 'SELL',
      type: 'TAKE_PROFIT',
    };
  }

  const peak = await updateMockTrailingPeak(env.DB, lastPrice);
  const tightPct = await getConfig(env.DB, 'trailing_tight_callback_pct', env);
  const triggerPrice = bn(peak).times(bn(100).minus(tightPct)).dividedBy(100);
  const priceTriggered = bn(lastPrice).lte(triggerPrice);

  const placedAt = await getMockTrailingPlacedAt(env.DB);
  const holdMs = maxHoldMinutes(env) * 60 * 1000;
  const timeExpired =
    placedAt !== null && Date.now() - parsePlacedAtMs(placedAt) >= holdMs;

  if (!priceTriggered && !timeExpired) {
    return {
      symbol,
      orderId,
      status: 'NEW',
      executedQty: '0',
      cummulativeQuoteQty: '0',
      side: 'SELL',
      type: 'TAKE_PROFIT',
    };
  }

  const qty = state.net_base_qty;
  const proceeds = bn(qty).times(lastPrice).toFixed(8);
  const activationPct = await getConfig(env.DB, 'trailing_activation_pct', env);

  await logEvent(env.DB, 'MOCK_TRAILING_FILLED', {
    symbol,
    orderId,
    lastPrice,
    peak,
    activationStop,
    tightCallbackPct: tightPct,
    trailingActivated: true,
    reason: priceTriggered ? 'tight_callback' : 'max_hold_expired',
    proceeds,
    maxHoldMinutes: maxHoldMinutes(env),
    trailingActivationPct: activationPct,
  });

  return {
    symbol,
    orderId,
    status: 'FILLED',
    executedQty: qty,
    cummulativeQuoteQty: proceeds,
    side: 'SELL',
    type: 'TAKE_PROFIT',
  };
}

/** Dry-run acil satış emri — reconcile getOrder için anında FILLED. */
export async function simulateMockActiveOrder(
  env: Env,
  symbol: string,
  orderId: number,
  lastPrice: string,
): Promise<OrderResponse | null> {
  const state = await getBotState(env.DB);
  if (state.active_order_id !== String(orderId)) return null;

  const qty = state.net_base_qty;
  const proceeds = bn(qty).times(lastPrice).toFixed(8);

  return {
    symbol,
    orderId,
    status: 'FILLED',
    executedQty: qty,
    cummulativeQuoteQty: proceeds,
    side: 'SELL',
    type: 'MARKET',
  };
}
