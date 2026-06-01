import assert from 'node:assert';
import {
  evaluateFlashDrop,
  evaluateFlashDropForScout,
  scoutFlashAllowsReady,
  windowDropPctFromCloses,
  anchorDrawdownPct,
  flashDropBlocksBuys,
} from '../src/strategy/grid-flash-drop.ts';

const cfg = {
  enabled: true,
  warnPct: 2,
  pausePct: 3,
  recoveryPct: 5,
  windowMin: 15,
  maxFills: 3,
  fillWindowMin: 10,
  investmentOverfillMult: 1.5,
};

let passed = 0;
function t(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

t('anchorDrawdownPct', () => {
  assert.ok(Math.abs(anchorDrawdownPct(0.288, 0.259) - 10.07) < 0.2);
  assert.equal(anchorDrawdownPct(0.28, 0.29), 0);
});

t('windowDropPctFromCloses: tepe→son düşüş', () => {
  const closes = [0.285, 0.284, 0.283, 0.276];
  const drop = windowDropPctFromCloses(closes, 0.276, 15);
  assert.ok(drop >= 2.5 && drop <= 3.5, `drop ${drop}`);
});

t('evaluateFlashDrop: warn on 2% anchor', () => {
  const r = evaluateFlashDrop({
    anchorPrice: 0.288,
    lastPrice: 0.282,
    klineCloses: [0.288, 0.285, 0.282],
    recentFilledBuys: [],
    filledBuyCostUsdt: 0,
    investmentUsdt: 24,
    nowMs: Date.now(),
    cfg,
  });
  assert.equal(r.level, 'warn');
});

t('evaluateFlashDrop: pause on 3% window (ALLO 14:46)', () => {
  const closes = [0.284, 0.281, 0.278, 0.276];
  const r = evaluateFlashDrop({
    anchorPrice: 0.288,
    lastPrice: 0.276,
    klineCloses: closes,
    recentFilledBuys: [],
    filledBuyCostUsdt: 20,
    investmentUsdt: 24,
    nowMs: Date.now(),
    cfg,
  });
  assert.ok(r.level === 'pause' || r.level === 'recovery');
});

t('evaluateFlashDrop: recovery on 5% anchor (ALLO 14:50)', () => {
  const r = evaluateFlashDrop({
    anchorPrice: 0.288,
    lastPrice: 0.272,
    klineCloses: [0.288, 0.28, 0.272],
    recentFilledBuys: [],
    filledBuyCostUsdt: 40,
    investmentUsdt: 24,
    nowMs: Date.now(),
    cfg,
  });
  assert.equal(r.level, 'recovery');
  assert.ok(r.reasons.some((x) => x.includes('anchor_recovery') || x.includes('overfill')));
});

t('evaluateFlashDrop: fill storm pause', () => {
  const now = Date.now();
  const buys = [
    { qty: 24, price: 0.28, atMs: now - 8 * 60_000 },
    { qty: 24, price: 0.278, atMs: now - 6 * 60_000 },
    { qty: 24, price: 0.276, atMs: now - 4 * 60_000 },
  ];
  const r = evaluateFlashDrop({
    anchorPrice: 0.285,
    lastPrice: 0.27,
    klineCloses: [0.285, 0.278, 0.27],
    recentFilledBuys: buys,
    filledBuyCostUsdt: 20,
    investmentUsdt: 24,
    nowMs: now,
    cfg,
  });
  assert.ok(r.level === 'pause' || r.level === 'recovery');
  assert.ok(r.reasons.some((x) => x.startsWith('fill_storm')));
});

t('evaluateFlashDrop: overfill recovery', () => {
  const r = evaluateFlashDrop({
    anchorPrice: 0.285,
    lastPrice: 0.28,
    klineCloses: [0.285, 0.282, 0.28],
    recentFilledBuys: [],
    filledBuyCostUsdt: 80,
    investmentUsdt: 24,
    nowMs: Date.now(),
    cfg,
  });
  assert.equal(r.level, 'recovery');
  assert.ok(r.reasons.some((x) => x.startsWith('overfill')));
});

t('flashDropBlocksBuys', () => {
  assert.equal(flashDropBlocksBuys('none'), false);
  assert.equal(flashDropBlocksBuys('warn'), true);
  assert.equal(flashDropBlocksBuys('pause'), true);
});

t('scoutFlashAllowsReady: strict none', () => {
  assert.equal(scoutFlashAllowsReady('none'), true);
  assert.equal(scoutFlashAllowsReady('warn'), false);
  assert.equal(scoutFlashAllowsReady('pause'), false);
  assert.equal(scoutFlashAllowsReady('recovery'), false);
});

t('evaluateFlashDropForScout: window drop → not ready', () => {
  const closes = [0.284, 0.281, 0.278, 0.270];
  const last = 0.27;
  const r = evaluateFlashDropForScout({ lastPrice: last, klineCloses: closes, cfg });
  assert.notEqual(r.level, 'none');
  assert.equal(scoutFlashAllowsReady(r.level), false);
});

console.log(`\n${passed} test geçti.`);
