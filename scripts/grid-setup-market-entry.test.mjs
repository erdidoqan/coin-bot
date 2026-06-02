import assert from 'node:assert';
import {
  nearestLevelIndex,
  planInitialBuyOrders,
  nextOrderAfterFill,
  computeGridLevels,
} from '../src/strategy/grid.ts';

let passed = 0;
function t(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

t('nearestLevelIndex: fill fiyatına en yakın seviye', () => {
  const levels = [90, 95, 100, 105, 110];
  assert.equal(nearestLevelIndex(102, levels), 2);
  assert.equal(nearestLevelIndex(91, levels), 0);
});

t('planInitialBuyOrders: yalnızca fiyatın altı', () => {
  const levels = [90, 95, 100, 105, 110];
  const plan = planInitialBuyOrders(levels, 100, 200);
  assert.ok(plan.every((o) => o.price < 100));
  assert.ok(plan.length >= 2);
});

t('nextOrderAfterFill: BUY sonrası üst SELL', () => {
  const levels = [90, 95, 100, 105, 110];
  const next = nextOrderAfterFill(2, 'BUY', levels, 200);
  assert.ok(next);
  assert.equal(next.side, 'SELL');
  assert.equal(next.levelIndex, 3);
});

t('computeGridLevels + market fill orta bant', () => {
  const levels = computeGridLevels(90, 110, 4);
  const mid = 100;
  const idx = nearestLevelIndex(mid, levels);
  assert.ok(idx >= 0 && idx < levels.length);
});

console.log(`\n${passed} passed`);
process.exit(0);
