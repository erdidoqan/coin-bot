import assert from 'node:assert';
import {
  evaluateDefensiveMarketMode,
  isGridDefensiveExempt,
  shouldStopRecoveryAtTarget,
} from '../src/strategy/grid-defensive-mode.ts';

let passed = 0;
function t(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

const baseCfg = {
  defensiveModeEnabled: true,
  marketDownturnForceActive: false,
  defensiveExemptGridIds: [100, 200],
};

t('disabled → inactive', () => {
  const r = evaluateDefensiveMarketMode({
    cfg: { ...baseCfg, defensiveModeEnabled: false },
    regime: 'chop',
    breadthPct: '20',
    downturn: null,
  });
  assert.equal(r.active, false);
});

t('chop → active', () => {
  const r = evaluateDefensiveMarketMode({
    cfg: baseCfg,
    regime: 'chop',
    breadthPct: '20',
    downturn: null,
  });
  assert.equal(r.active, true);
  assert.ok(r.reasons.includes('chop'));
});

t('force_active without downturn', () => {
  const r = evaluateDefensiveMarketMode({
    cfg: { ...baseCfg, marketDownturnForceActive: true },
    regime: 'trend',
    breadthPct: '60',
    downturn: null,
  });
  assert.equal(r.active, true);
  assert.ok(r.reasons.includes('force_active'));
});

t('downturn active', () => {
  const r = evaluateDefensiveMarketMode({
    cfg: baseCfg,
    regime: 'trend',
    breadthPct: '30',
    downturn: { active: true, reasons: ['breadth_weak'], metrics: {}, regime: { regime: 'trend' } },
  });
  assert.equal(r.active, true);
  assert.ok(r.reasons.includes('market_downturn'));
});

t('exempt grid id', () => {
  assert.equal(isGridDefensiveExempt({ defensiveExemptGridIds: [42] }, 42), true);
  assert.equal(isGridDefensiveExempt({ defensiveExemptGridIds: [42] }, 99), false);
});

t('recovery stop at target -1%', () => {
  assert.equal(shouldStopRecoveryAtTarget(98.9, 100, 1), true);
  assert.equal(shouldStopRecoveryAtTarget(99.1, 100, 1), false);
});

console.log(`\n${passed} passed`);
process.exit(0);
