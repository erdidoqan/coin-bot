import assert from 'node:assert/strict';
import {
  computeExcessFree,
} from '../src/admin/grid-wallet-claims.ts';

// HBAR: 200 free, 66 locked, claimed 66 (recovery)
assert.equal(
  computeExcessFree(200, 66, { recoveryQty: 66, activeTrackedQty: 0, totalClaimed: 66 }),
  200,
);

// active 50 in free
assert.equal(
  computeExcessFree(200, 66, { recoveryQty: 66, activeTrackedQty: 50, totalClaimed: 116 }),
  150,
);

// no claims
assert.equal(computeExcessFree(100, 0, undefined), 100);

console.log('grid-wallet-claims: 3 test geçti.');
