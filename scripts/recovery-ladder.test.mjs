import assert from 'node:assert';
import { parseRecoveryLadderDone } from '../src/db/grid.ts';
import {
  RECOVERY_LADDER_STEPS,
  movePctFromAnchor,
  isThresholdReached,
  quoteUsdtForLadderBuy,
  baseQtyForLadderSell,
  buildRecoveryLadderStepViews,
  getRecoveryLadderStep,
  pickAutoRecoveryLadderStep,
} from '../src/strategy/recovery-ladder.ts';

let passed = 0;
function t(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

t('10 adım tanımlı', () => {
  assert.equal(RECOVERY_LADDER_STEPS.length, 10);
  assert.equal(getRecoveryLadderStep('up_100')?.kind, 'sell_all');
});

t('movePctFromAnchor', () => {
  assert.equal(movePctFromAnchor(100, 115), 15);
  assert.equal(movePctFromAnchor(100, 85), -15);
  assert.equal(movePctFromAnchor(0, 100), null);
});

t('isThresholdReached dip/up', () => {
  assert.equal(isThresholdReached(-16, -15), true);
  assert.equal(isThresholdReached(-10, -15), false);
  assert.equal(isThresholdReached(26, 25), true);
  assert.equal(isThresholdReached(20, 25), false);
});

t('buy quote ve sell qty', () => {
  assert.equal(quoteUsdtForLadderBuy(2, 50, 10), 10);
  assert.equal(baseQtyForLadderSell(10, 20), 2);
});

t('buildRecoveryLadderStepViews done + suggested', () => {
  const views = buildRecoveryLadderStepViews(['dip_5'], 100, 84);
  const dip5 = views.find((v) => v.id === 'dip_5');
  const dip15 = views.find((v) => v.id === 'dip_15');
  assert.equal(dip5?.done, true);
  assert.equal(dip5?.suggested, true);
  assert.equal(dip15?.done, false);
  assert.equal(dip15?.suggested, true);
});

t('pickAutoRecoveryLadderStep sıra + eşik', () => {
  assert.equal(pickAutoRecoveryLadderStep([], 100, 94)?.id, 'dip_5');
  assert.equal(pickAutoRecoveryLadderStep(['dip_5'], 100, 84)?.id, 'dip_15');
  assert.equal(pickAutoRecoveryLadderStep([], 100, 110)?.id, 'up_5');
  assert.equal(
    pickAutoRecoveryLadderStep(['dip_5', 'dip_15', 'dip_25', 'up_5', 'up_15'], 100, 126)?.id,
    'up_25',
  );
});

t('parseRecoveryLadderDone', () => {
  assert.deepEqual(parseRecoveryLadderDone('["dip_5","up_25"]'), ['dip_5', 'up_25']);
  assert.deepEqual(parseRecoveryLadderDone(null), []);
  assert.deepEqual(parseRecoveryLadderDone('bad'), []);
});

console.log(`recovery-ladder: ${passed} test geçti.`);
