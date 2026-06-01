import assert from 'node:assert/strict';
import {
  pctFromBase,
  buildPositionEntryContext,
  buildTradeOutcome,
} from '../src/position/trade-analytics.ts';

assert.equal(pctFromBase('100', '100.5'), '0.5000');
assert.equal(pctFromBase('100', '99'), '-1.0000');

const ctx = buildPositionEntryContext(
  {
    symbol: 'BTCUSDT',
    added_at: '2026-01-01T00:00:00Z',
    price_at_addition: '100',
    target_sma: null,
    momentum_ok: 0,
    momentum_checked_at: null,
    momentum_detail: null,
    micro_score: null,
    micro_ok: 0,
    micro_checked_at: null,
    micro_detail: null,
    sector_tag: null,
  },
  'tick_scalp',
  '100.2',
  {
    tickDetail: { gainPct: '0.03', wsDeclinePct: '0.15', wsDeclineOk: true },
    takeProfitGrossPct: '0.65',
    stopLossGrossPct: '0.1',
  },
);

assert.equal(ctx.scoutVsFillPct, '0.2000');
assert.equal(ctx.gainPct, '0.03');

const outcome = buildTradeOutcome(
  {
    id: 1,
    status: 'TIER_1_BULL',
    active_symbol: 'BTCUSDT',
    avg_cost: '100.2',
    position_peak_price: '100.8',
    position_trough_price: '99.9',
    position_entry_context: JSON.stringify(ctx),
    net_base_qty: '1',
    total_usdt_spent: '100.2',
    total_base_qty: '1',
    active_order_id: null,
    trailing_order_id: null,
    position_opened_at: null,
    watchlist_cursor: 0,
    entry_mode: 'tick_scalp',
    take_profit_price: '101',
    scalp_stop_loss_pct: '0.1',
    updated_at: '',
  },
  { source: 'scalp_hard_stop', pnl: '-0.5', proceeds: '99.7', exitPrice: '99.7' },
);

assert.equal(outcome.max_favorable_pct, '0.5988');
assert.equal(outcome.max_adverse_pct, '-0.2994');
console.log('trade-analytics.test.mjs OK');
