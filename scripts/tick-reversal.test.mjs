import assert from 'node:assert/strict';
import {
  evaluateTickReversal,
  passesScoutPriceBand,
  recoveryFromLowPct,
  countRisingMidSamples,
  defaultTickReversalConfig,
  effectiveRecoveryMinPct,
} from '../src/indicators/tick-reversal.ts';

const cfg = defaultTickReversalConfig();
const now = 1_700_000_000_000;
const troughMs = now - 20_000;

const samples = [];
for (let i = 0; i < 12; i++) {
  const t = now - (12 - i) * 10_000;
  let mid = 100.2;
  if (t <= troughMs) mid = 100.2 - (troughMs - t) / 200_000;
  else mid = 100.01 + (t - troughMs) / 40_000;
  samples.push({ t, mid });
}

const ok = evaluateTickReversal({
  samples,
  currentMid: '100.08',
  windowLow: '100',
  troughTimeMs: troughMs,
  config: cfg,
  ob: {
    spreadPct: 0.05,
    spreadPctPrev: 0.08,
    spreadHistory: [0.09, 0.08, 0.07, 0.06, 0.05],
    bidAskRatio: 1.2,
    bidAskRatioAtTrough: 1.05,
  },
  nowMs: now,
});
assert.equal(ok.ok, true, ok.failReason ?? 'expected pass');
assert.ok(Number(ok.recoveryFromWsLowPct) >= 0.05);

const early = evaluateTickReversal({
  samples,
  currentMid: '100.06',
  windowLow: '100',
  troughTimeMs: now - 2_000,
  config: cfg,
  nowMs: now,
});
assert.equal(early.ok, false);
assert.equal(early.failReason, 'too_early_after_trough');

const shallow = evaluateTickReversal({
  samples,
  currentMid: '100.02',
  windowLow: '100',
  troughTimeMs: troughMs,
  config: cfg,
  nowMs: now,
});
assert.equal(shallow.ok, false);
assert.equal(shallow.failReason, 'recovery_too_shallow');
assert.ok(shallow.reversalScore > 0, 'partial score when recovery present');

const feeCfg = {
  ...cfg,
  feeRoundtripPct: '0.15',
  recoveryFeeMarginPct: '0.05',
};
assert.equal(effectiveRecoveryMinPct(feeCfg), '0.2000');

assert.equal(recoveryFromLowPct('100', '100.36'), '0.3600');
assert.ok(countRisingMidSamples(samples, 5).rising >= 3);

const scoutBelow = passesScoutPriceBand('1.045', '1.005', '1.0', '1.5');
assert.equal(scoutBelow.ok, false);
assert.equal(scoutBelow.failReason, 'scout_price_too_far_below');

const scoutOk = passesScoutPriceBand('2.479', '2.462', '1.0', '1.5');
assert.equal(scoutOk.ok, true);

console.log('tick-reversal.test.mjs OK');
