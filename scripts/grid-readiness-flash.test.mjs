import assert from 'node:assert';
import {
  consecutiveLowerCloses,
  evaluateGridReadiness,
  finalizeCandidateReadiness,
  defaultGridReadinessConfig,
  pathRangeRatio,
} from '../src/strategy/grid-readiness.ts';
import { scoutFlashAllowsReady } from '../src/strategy/grid-flash-drop.ts';

const flashCfg = {
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

t('consecutiveLowerCloses: 3 kırmızı bar fail', () => {
  const down = [1.0, 0.99, 0.98, 0.97];
  assert.equal(consecutiveLowerCloses(down, 3), true);
  const mixed = [1.0, 0.99, 0.98, 1.0];
  assert.equal(consecutiveLowerCloses(mixed, 3), false);
});

t('pathRangeRatio: testere yüksek, düz salınım düşük', () => {
  const chop = [];
  let p = 0.26;
  for (let i = 0; i < 48; i++) {
    p += i % 2 === 0 ? 0.02 : -0.02;
    chop.push({ high: p + 0.005, low: p - 0.005, close: p });
  }
  const smooth = Array.from({ length: 48 }, (_, i) => {
    const c = 1.0 + Math.sin(i / 6) * 0.02;
    return { high: c + 0.003, low: c - 0.003, close: c };
  });
  const chopRatio = pathRangeRatio(chop);
  const smoothRatio = pathRangeRatio(smooth);
  assert.ok(chopRatio != null && smoothRatio != null);
  assert.ok(chopRatio > smoothRatio * 1.5, `chop ${chopRatio} vs smooth ${smoothRatio}`);
  const cfg = { ...defaultGridReadinessConfig(), maxPathRangeRatio: 8, stabilityBars: 48 };
  const chopReady = evaluateGridReadiness({
    klines: chop,
    lastPrice: chop[chop.length - 1].close,
    spreadPct: 0.01,
    config: cfg,
  });
  assert.equal(chopReady.gates.find((g) => g.id === 'path_stability')?.pass, false);
});

t('birleşik ready: 6 kapı pass + flash warn → ready false', () => {
  const base = evaluateGridReadiness({
    klines: Array.from({ length: 24 }, (_, i) => ({
      high: 1.02,
      low: 0.98,
      close: 1.0 + (i % 2 === 0 ? 0.01 : -0.01),
    })),
    lastPrice: 1.0,
    spreadPct: 0.01,
    config: defaultGridReadinessConfig(),
  });
  const passGate = (id, label) => ({ id, label, pass: true, actual: 1, threshold: 'ok' });
  const readyBase = {
    ...base,
    ready: true,
    range: { lower: 0.95, upper: 1.05 },
    primaryBlocker: null,
    gates: [
      passGate('ranging', 'Ranging'),
      passGate('range_width', 'Aralık'),
      passGate('atr', 'ATR'),
      passGate('spread', 'Spread'),
      passGate('price_in_range', 'Fiyat'),
      passGate('range_exists', 'Aralık var'),
    ],
  };
  const flashCloses = [0.284, 0.281, 0.278, 0.270];
  const merged = finalizeCandidateReadiness({
    base: readyBase,
    closes: flashCloses,
    lastPrice: 0.27,
    flashCfg,
    flashEnabled: true,
    downsideBars: 0,
    shortReturnBars: 3,
    momentumWarnPct: 2,
  });
  assert.equal(scoutFlashAllowsReady(merged.flashLevel), false);
  assert.equal(merged.readiness.ready, false);
  assert.equal(merged.readiness.primaryBlocker, 'flash_drop');
});

console.log(`\n${passed} test geçti.`);
