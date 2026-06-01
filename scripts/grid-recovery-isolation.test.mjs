import assert from 'node:assert/strict';
import { capRecoverySellBaseQty } from '../src/strategy/grid-recovery-qty.ts';

function buildSetupExclude(activeSymbols, recoveringSymbols, allowNewWhileRecovering) {
  const exclude = new Set(activeSymbols);
  if (!allowNewWhileRecovering) {
    for (const s of recoveringSymbols) exclude.add(s);
  }
  return exclude;
}

assert.equal(capRecoverySellBaseQty(10, 100), 10);
assert.equal(capRecoverySellBaseQty(50, 20), 20);
assert.equal(capRecoverySellBaseQty(0, 100), 0);
assert.equal(capRecoverySellBaseQty(10, 0), 0);

const excludeOn = buildSetupExclude(['BTCUSDT'], ['ONDOUSDT'], true);
assert.equal(excludeOn.has('ONDOUSDT'), false);
assert.equal(excludeOn.has('BTCUSDT'), true);

const excludeOff = buildSetupExclude(['BTCUSDT'], ['ONDOUSDT'], false);
assert.equal(excludeOff.has('ONDOUSDT'), true);

console.log('grid-recovery-isolation: 7 test geçti.');
