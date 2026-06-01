import assert from 'node:assert';
import {
  shouldCancelOpenGridBuys,
  shouldBlockNewGridBuy,
  shouldTeardownForReadiness,
  shouldSkipRecenterForReadiness,
  parseTeardownReadinessBlockers,
  buildGridBuyGuardAssessment,
} from '../src/strategy/grid-buy-guard.ts';

let passed = 0;
function t(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

const baseReadiness = {
  ready: true,
  score: 80,
  primaryBlocker: null,
  gates: [{ id: 'ranging', pass: true }],
};

const guardCfg = {
  enabled: true,
  cancelOpenOnNotReady: true,
  blockNewOnNotReady: true,
  cancelAnchorDrawdownPct: 1.0,
  teardownOnReadinessBlockers: true,
  teardownReadinessBlockers: parseTeardownReadinessBlockers(
    'downside_momentum,hour_decline,flash_drop',
  ),
  recenterRequiresReady: true,
  useWatchlist: true,
};

function snap(overrides = {}) {
  return buildGridBuyGuardAssessment({
    readiness: { ...baseReadiness, ...overrides.readiness },
    lastPrice: overrides.lastPrice ?? 100,
    inWatchlist: overrides.inWatchlist ?? true,
    anchorPrice: overrides.anchorPrice ?? 101,
    flashLevel: overrides.flashLevel ?? 'none',
  });
}

t('anchor drawdown triggers cancel', () => {
  const a = snap({ lastPrice: 99, anchorPrice: 101 });
  assert.equal(shouldCancelOpenGridBuys(a, guardCfg).reason, 'anchor_drawdown');
});

t('downside_momentum triggers cancel', () => {
  const a = snap({
    readiness: { ready: false, primaryBlocker: 'downside_momentum', gates: [], score: 50 },
  });
  assert.equal(shouldCancelOpenGridBuys(a, guardCfg).block, true);
});

t('not in watchlist triggers block new buy', () => {
  const a = snap({ inWatchlist: false });
  assert.equal(shouldBlockNewGridBuy(a, guardCfg).reason, 'not_in_watchlist');
});

t('teardown only configured blockers', () => {
  const a = snap({
    readiness: { ready: false, primaryBlocker: 'medium_downside', gates: [], score: 50 },
  });
  assert.equal(shouldTeardownForReadiness(a, guardCfg).block, false);
});

t('recenter skip when not ready', () => {
  const a = snap({
    readiness: { ready: false, primaryBlocker: 'hour_decline', gates: [], score: 40 },
  });
  assert.equal(shouldSkipRecenterForReadiness(a, guardCfg).block, true);
});

t('disabled guard never blocks', () => {
  const a = snap({ inWatchlist: false });
  const off = { ...guardCfg, enabled: false };
  assert.equal(shouldCancelOpenGridBuys(a, off).block, false);
});

console.log(`\n${passed} passed`);
