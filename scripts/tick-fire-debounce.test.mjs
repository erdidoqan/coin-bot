import assert from 'node:assert/strict';
import {
  canFireTickSignal,
  shouldScheduleTickEval,
  TICK_EVAL_DEBOUNCE_MS,
  TICK_GLOBAL_FIRE_COOLDOWN_MS,
  TICK_SYMBOL_FIRE_COOLDOWN_MS,
} from '../src/indicators/tick-fire-gate.ts';

const t0 = 1_000_000;
assert.equal(shouldScheduleTickEval(t0, t0 - TICK_EVAL_DEBOUNCE_MS), true);
assert.equal(shouldScheduleTickEval(t0, t0 - 100), false);

assert.equal(
  canFireTickSignal({
    nowMs: t0 + TICK_GLOBAL_FIRE_COOLDOWN_MS + 1,
    lastGlobalFireMs: t0,
    lastSymbolFireMs: t0 - TICK_SYMBOL_FIRE_COOLDOWN_MS - 1,
  }),
  true,
);

assert.equal(
  canFireTickSignal({
    nowMs: t0 + 1000,
    lastGlobalFireMs: t0,
    lastSymbolFireMs: 0,
  }),
  false,
);

assert.equal(
  canFireTickSignal({
    nowMs: t0 + 5_000,
    lastGlobalFireMs: t0 - TICK_GLOBAL_FIRE_COOLDOWN_MS - 1,
    lastSymbolFireMs: t0,
  }),
  false,
  'symbol cooldown',
);

console.log('tick-fire-debounce.test.mjs OK');
