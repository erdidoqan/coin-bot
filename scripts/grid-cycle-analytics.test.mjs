import assert from 'node:assert';
import {
  computeGridCycleExcursionUpdate,
  gridCycleEntryFromBuyCost,
  buildGridCycleAnalytics,
  resolveGridCycleExcursionPrices,
} from '../src/strategy/grid-cycle-analytics.ts';

let passed = 0;
function t(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

t('gridCycleEntryFromBuyCost', () => {
  assert.equal(gridCycleEntryFromBuyCost('50', '100'), '0.50000000');
});

t('computeGridCycleExcursionUpdate: yeni dip', () => {
  const u = computeGridCycleExcursionUpdate('0.49', '0.50', '0.50', '0.50');
  assert.equal(u.trough, '0.49');
  assert.equal(u.changed, true);
});

t('computeGridCycleExcursionUpdate: değişim yok', () => {
  const u = computeGridCycleExcursionUpdate('0.505', '0.50', '0.51', '0.49');
  assert.equal(u.changed, false);
});

t('buildGridCycleAnalytics: max adverse negatif', () => {
  const a = buildGridCycleAnalytics({
    entryPrice: '0.50',
    exitPrice: '0.502',
    troughPrice: '0.495',
    peakPrice: '0.503',
    holdMinutes: 12.5,
    floorExit: false,
  });
  assert.equal(a.max_adverse_pct, '-1.0000'); // (0.495-0.5)/0.5*100
  assert.ok(Number(a.max_favorable_pct) > 0);
  assert.equal(a.hold_minutes, 12.5);
});

t('resolveGridCycleExcursionPrices: DB alanları öncelikli', () => {
  const r = resolveGridCycleExcursionPrices(
    {
      price: '0.51',
      cycle_entry_price: '0.50',
      cycle_trough_price: '0.498',
      cycle_peak_price: '0.505',
    },
    '25',
    '50',
  );
  assert.equal(r.entry, '0.50');
  assert.equal(r.trough, '0.498');
  assert.equal(r.peak, '0.505');
});

console.log(`\n${passed} passed`);
