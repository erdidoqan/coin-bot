import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

async function main() {
  const {
    parseShadowHorizons,
    isHorizonDue,
    forwardPctFromRef,
    hitTakeProfitGross,
    wouldPassScoreOnly,
  } = await import(join(root, 'src/indicators/micro-shadow.ts'));

  assert.deepEqual(parseShadowHorizons('5,15,30'), [5, 15, 30]);
  assert.deepEqual(parseShadowHorizons(''), [5, 15, 30]);

  const t0 = 1_000_000;
  assert.equal(isHorizonDue(t0, 5, t0 + 5 * 60_000), true);
  assert.equal(isHorizonDue(t0, 5, t0 + 4 * 60_000), false);

  assert.equal(forwardPctFromRef('100', '100.69'), '0.69');
  assert.equal(hitTakeProfitGross('0.69', '0.7'), false);
  assert.equal(hitTakeProfitGross('0.70', '0.7'), true);

  assert.equal(wouldPassScoreOnly(0.57, 0.75, true), false);
  assert.equal(wouldPassScoreOnly(0.80, 0.75, true), true);
  assert.equal(wouldPassScoreOnly(0.80, 0.75, false), false);

  console.log('micro-shadow.test.mjs: all passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
