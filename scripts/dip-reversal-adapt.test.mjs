/**
 * Dip reversal adapt — birim testleri (classify + resolve + flat+breadth grind).
 */
import assert from 'node:assert/strict';
import {
  adaptBlocksEntry,
  adaptEntryBlockReason,
  classifyDipReversalMode,
  resolveAdaptiveThresholds,
  resolveTrendFromEma,
} from '../src/strategy/dip-reversal-adapt.ts';

const adaptThr = {
  emaMinSepPct: 0.1,
  calmAtrMax: 0.5,
  volatileAtrMin: 1.0,
  downtrendBreadthMax: 40,
  calmDropMult: 0.7,
  dtVolDropMult: 1.15,
  dtVolReversalMult: 1.25,
  dtVolRecoveryMult: 1.25,
  dtGrindDropMult: 1.4,
  dtGrindReversalMult: 1.6,
  dtGrindRecoveryMult: 1.6,
};

const base = {
  minCapitulationDropPct: 1.0,
  minWsDeclinePct: 0.4,
  minRecoveryFromLowPct: 0.15,
  minReversalScore: 1.0,
  maxSecSinceTrough: 90,
  requireMidSlope: true,
};

// EMA min-ayrışma: kıl payı fark -> flat
const flatTrend = resolveTrendFromEma(67060, 67070, 0.1);
assert.equal(flatTrend.trend, 'flat');

// Flat + zayıf breadth + düşük ATR -> grind (calm DEĞİL)
const grindCtx = {
  ema9: 67060,
  ema21: 67070,
  emaSepPct: 0.015,
  trend: 'flat',
  atrPct: 0.34,
  breadthPct: 25,
  riskOff: true,
};
assert.equal(classifyDipReversalMode(grindCtx, adaptThr), 'downtrend_grind');

const grindThr = resolveAdaptiveThresholds(base, 'downtrend_grind', adaptThr);
assert.equal(grindThr.minCapitulationDropPct, 1.4);
assert.equal(grindThr.minReversalScore, 1.6);

// ZEC örneği: 1.04 drop grind'de geçmez
assert.ok(1.04 < grindThr.minCapitulationDropPct);

// Volatil düşüş: ATR yüksek, risk-off, down
const volCtx = {
  ema9: 66000,
  ema21: 67000,
  emaSepPct: 1.5,
  trend: 'down',
  atrPct: 1.2,
  breadthPct: 30,
  riskOff: true,
};
assert.equal(classifyDipReversalMode(volCtx, adaptThr), 'downtrend_volatile');

// Sakin + sağlıklı breadth -> calm
const calmCtx = {
  ema9: 67200,
  ema21: 67000,
  emaSepPct: 0.3,
  trend: 'up',
  atrPct: 0.4,
  breadthPct: 55,
  riskOff: false,
};
assert.equal(classifyDipReversalMode(calmCtx, adaptThr), 'calm');
assert.equal(resolveAdaptiveThresholds(base, 'calm', adaptThr).minCapitulationDropPct, 0.7);

// Block grind + block modu
assert.equal(
  adaptEntryBlockReason('downtrend_grind', { downtrendMode: 'block' }),
  'downtrend_grind',
);
assert.equal(
  adaptEntryBlockReason('downtrend_volatile', {
    downtrendMode: 'block',
    volatileBlockEnabled: true,
    breadthPct: 25,
  }),
  null,
);

// Volatile risk-off breadth
assert.equal(
  adaptEntryBlockReason('downtrend_volatile', {
    downtrendMode: 'tighten',
    volatileBlockEnabled: true,
    volatileBlockBreadthMax: 10,
    breadthPct: 0,
  }),
  'volatile_riskoff_breadth',
);
assert.equal(
  adaptEntryBlockReason('downtrend_volatile', {
    downtrendMode: 'tighten',
    volatileBlockEnabled: true,
    volatileBlockBreadthMax: 10,
    breadthPct: 15,
  }),
  null,
);
assert.equal(
  adaptBlocksEntry('downtrend_volatile', {
    downtrendMode: 'tighten',
    volatileBlockEnabled: false,
    breadthPct: 0,
  }),
  false,
);

console.log('dip-reversal-adapt.test.mjs: OK');
