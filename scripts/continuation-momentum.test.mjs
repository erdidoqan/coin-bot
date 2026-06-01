import assert from 'node:assert/strict';
import {
  analyzeTripleContinuation,
  analyzeLastPairContinuation,
  aggregateContinuation,
} from '../src/indicators/continuation-momentum.ts';

const cfg = {
  minRecoveryPct: '0.1',
  maxPullbackPct: '0.15',
  minGreenWindows: 4,
  requireShortTf: true,
};

function k(o, h, l, c) {
  return { open: o, high: h, low: l, close: c, volume: '1', time: 0 };
}

// Esneme + toparlanma: [0] up, [1] red dip, [2] green recovery
const goodTriple = [
  k('100', '101', '99', '100.5'),
  k('100.5', '100.6', '99.5', '100.2'),
  k('100.2', '101.5', '100.1', '101'),
];
const good = analyzeTripleContinuation(goodTriple, '15m', '15m', cfg);
assert.equal(good?.passed, true, 'triple pullback+recovery should pass');

// Sürekli yeşil pump — no pullback
const pumpTriple = [
  k('100', '101', '99', '101'),
  k('101', '102', '100', '102'),
  k('102', '104', '101', '104'),
];
const pump = analyzeTripleContinuation(pumpTriple, '15m', '15m', cfg);
assert.equal(pump?.passed, false, 'continuous pump should fail');
assert.ok(
  pump?.failReason === 'no_pullback' || pump?.failReason === 'pullback_too_large',
  `expected pump fail, got ${pump?.failReason}`,
);

// 5m last pair: prev red, last green
const good5m = analyzeLastPairContinuation(
  [k('10', '10.1', '9.9', '9.95'), k('9.95', '10.2', '9.9', '10.1')],
  '5m',
  '5m',
  cfg,
);
assert.equal(good5m?.passed, true);

const agg = aggregateContinuation(
  [
    good,
    good,
    good,
    good,
    good5m,
    analyzeLastPairContinuation(
      [k('10', '10.05', '9.98', '9.99'), k('9.99', '10.1', '9.98', '10.05')],
      '1m',
      '1m',
      cfg,
    ),
  ].filter(Boolean),
  cfg,
);
assert.equal(agg.entryEligible, true);

console.log('continuation-momentum tests OK');
