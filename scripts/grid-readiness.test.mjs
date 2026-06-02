import assert from 'node:assert';
import {
  efficiencyRatio,
  rangeWidthPct,
  meanAtrPct,
  evaluateGridReadiness,
  defaultGridReadinessConfig,
  downsideMomentumBlocked,
  downsideMomentumBlockedRelaxed,
  finalizeCandidateReadiness,
  applyPriceChangePct3mPenalty,
  rangePositionPct,
  entryBandTooHigh,
  mediumDownsideBlocked,
  isPostExitCooldownActive,
  hourContinuousDeclineBlocked,
} from '../src/strategy/grid-readiness.ts';

let passed = 0;
function t(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

t('efficiencyRatio: ranging düşük, trend yüksek', () => {
  const ranging = [100, 101, 100, 101, 100, 101, 100]; // salınım, net~0
  const trending = [100, 101, 102, 103, 104, 105, 106]; // düz trend
  const erR = efficiencyRatio(ranging);
  const erT = efficiencyRatio(trending);
  assert.ok(erR < 0.2, `ranging ER düşük olmalı: ${erR}`);
  assert.ok(erT > 0.9, `trend ER yüksek olmalı: ${erT}`);
});

t('rangeWidthPct', () => {
  const w = rangeWidthPct([110, 108, 109], [100, 101, 99]); // max110 min99 mid104.5
  assert.ok(Math.abs(w - 10.526) < 0.1, `${w}`);
});

t('meanAtrPct', () => {
  const a = meanAtrPct([{ high: 101, low: 99, close: 100 }]); // 2/100=2%
  assert.ok(Math.abs(a - 2) < 1e-9);
});

function cfgNoStability() {
  return {
    ...defaultGridReadinessConfig(),
    maxPathRangeRatio: 0,
    maxBarRangePathRatio: 0,
    maxStabilityRangePct: 0,
  };
}

function osc(n, lo, hi) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const c = i % 2 === 0 ? lo : hi;
    out.push({ high: hi, low: lo, close: c });
  }
  return out;
}

t('evaluateGridReadiness: ranging+volatil+aralıkta -> ready', () => {
  const klines = osc(40, 97, 103); // ~6% genişlik, salınım
  const r = evaluateGridReadiness({
    klines,
    lastPrice: 100,
    spreadPct: 0.02,
    config: cfgNoStability(),
  });
  assert.equal(r.ready, true, `gates: ${JSON.stringify(r.gates.filter((g) => !g.pass))}`);
  assert.ok(r.range && r.range.lower < 100 && r.range.upper > 100);
});

t('evaluateGridReadiness: trend -> ready=false (ranging gate fail)', () => {
  const klines = Array.from({ length: 40 }, (_, i) => ({
    high: 100 + i + 0.5,
    low: 100 + i - 0.5,
    close: 100 + i,
  }));
  const r = evaluateGridReadiness({
    klines,
    lastPrice: 139,
    spreadPct: 0.02,
    config: cfgNoStability(),
  });
  assert.equal(r.ready, false);
  assert.ok(['ranging', 'range_width_max', 'price_in_range'].includes(r.primaryBlocker));
});

t('downsideMomentumBlockedRelaxed: üst üste kırmızı sayılmaz', () => {
  const closes = [100, 99, 98, 97, 96, 95];
  assert.equal(downsideMomentumBlocked(closes, 3, 3, 3), true);
  assert.equal(downsideMomentumBlockedRelaxed(closes, 3, 7), false);
});

t('finalizeCandidateReadiness: 3 kırmızı 5m her modda engel', () => {
  const closes = [100, 99, 98, 97, 96, 95, 94, 93, 92, 91];
  const klines = closes.map((c) => ({ high: c + 0.5, low: c - 0.5, close: c }));
  const base = evaluateGridReadiness({
    klines,
    lastPrice: 91,
    spreadPct: 0.02,
    config: cfgNoStability(),
  });
  const flashCfg = {
    warnPct: 2,
    pausePct: 3,
    recoveryPct: 5,
    windowBars: 3,
    maxFills: 3,
    fillWindowBars: 2,
    overfillMult: 1.5,
  };
  const strict = finalizeCandidateReadiness({
    base,
    closes,
    lastPrice: 91,
    flashCfg,
    flashEnabled: false,
    downsideBars: 3,
    shortReturnBars: 3,
    momentumWarnPct: 3,
  });
  const relaxed = finalizeCandidateReadiness({
    base,
    closes,
    lastPrice: 91,
    flashCfg,
    flashEnabled: false,
    downsideBars: 3,
    shortReturnBars: 3,
    momentumWarnPct: 3,
    postExitRelax: true,
    postExitMomentumWarnPct: 7,
  });
  assert.equal(strict.readiness.gates.find((g) => g.id === 'downside_momentum')?.pass, false);
  assert.equal(relaxed.readiness.gates.find((g) => g.id === 'downside_momentum')?.pass, false);
});

t('finalizeCandidateReadiness: postExitRelax yalnızca kısa getiri eşiğini gevşetir', () => {
  // Üst üste 3 kırmızı yok; kısa getiri ~-4% (strict 3% engeller, relax 7% geçer)
  const closes = [100, 100, 100, 100, 100, 100, 100, 100, 100, 96];
  const klines = closes.map((c) => ({ high: c + 0.5, low: c - 0.5, close: c }));
  const base = evaluateGridReadiness({
    klines,
    lastPrice: 96,
    spreadPct: 0.02,
    config: cfgNoStability(),
  });
  const flashCfg = {
    warnPct: 2,
    pausePct: 3,
    recoveryPct: 5,
    windowBars: 3,
    maxFills: 3,
    fillWindowBars: 2,
    overfillMult: 1.5,
  };
  const strict = finalizeCandidateReadiness({
    base,
    closes,
    lastPrice: 96,
    flashCfg,
    flashEnabled: false,
    downsideBars: 3,
    shortReturnBars: 3,
    momentumWarnPct: 3,
  });
  const relaxed = finalizeCandidateReadiness({
    base,
    closes,
    lastPrice: 96,
    flashCfg,
    flashEnabled: false,
    downsideBars: 3,
    shortReturnBars: 3,
    momentumWarnPct: 3,
    postExitRelax: true,
    postExitMomentumWarnPct: 7,
  });
  assert.equal(strict.readiness.gates.find((g) => g.id === 'downside_momentum')?.pass, false);
  assert.equal(relaxed.readiness.gates.find((g) => g.id === 'downside_momentum')?.pass, true);
});

t('entryBandTooHigh: üst banda giriş engeli', () => {
  const range = { lower: 100, upper: 110 };
  assert.equal(rangePositionPct(105, range), 50);
  assert.equal(entryBandTooHigh(108, range, 65), true);
  assert.equal(entryBandTooHigh(103, range, 65), false);
});

t('mediumDownsideBlocked: 3s düşüş', () => {
  const closes = Array.from({ length: 40 }, (_, i) => 100 - i * 0.2);
  assert.equal(mediumDownsideBlocked(closes, 36, 2.5), true);
});

t('finalizeCandidateReadiness: entry_band + medium + cooldown', () => {
  const closes = Array.from({ length: 40 }, (_, i) => 100 + i * 0.05);
  const klines = closes.map((c) => ({ high: c + 0.5, low: c - 0.5, close: c }));
  const base = evaluateGridReadiness({
    klines,
    lastPrice: 102,
    spreadPct: 0.02,
    config: cfgNoStability(),
  });
  const flashCfg = {
    warnPct: 2,
    pausePct: 3,
    recoveryPct: 5,
    windowBars: 3,
    maxFills: 3,
    fillWindowBars: 2,
    overfillMult: 1.5,
  };
  const merged = finalizeCandidateReadiness({
    base,
    closes,
    lastPrice: 102,
    flashCfg,
    flashEnabled: false,
    downsideBars: 0,
    shortReturnBars: 3,
    momentumWarnPct: 3,
    maxEntryBandPct: 65,
    mediumReturnBars: 0,
    mediumReturnWarnPct: 0,
    postExitCooldown: false,
  });
  const bandGate = merged.readiness.gates.find((g) => g.id === 'entry_band_position');
  assert.equal(bandGate?.pass, false);
  assert.equal(merged.readiness.primaryBlocker, 'entry_band_position');
});

t('hourContinuousDeclineBlocked: 12 bar üst üste kırmızı', () => {
  const declining = Array.from({ length: 15 }, (_, i) => 100 - i);
  assert.equal(hourContinuousDeclineBlocked(declining, 12), true);
  const mixed = [100, 99, 100, 98, 97, 96, 95, 94, 93, 92, 91, 90, 89];
  assert.equal(hourContinuousDeclineBlocked(mixed, 12), false);
});

t('finalizeCandidateReadiness: hour_decline engeli', () => {
  const closes = Array.from({ length: 15 }, (_, i) => 100 - i * 0.5);
  const klines = closes.map((c) => ({ high: c + 0.5, low: c - 0.5, close: c }));
  const base = evaluateGridReadiness({
    klines,
    lastPrice: closes[closes.length - 1],
    spreadPct: 0.02,
    config: cfgNoStability(),
  });
  const flashCfg = {
    warnPct: 2,
    pausePct: 3,
    recoveryPct: 5,
    windowBars: 3,
    maxFills: 3,
    fillWindowBars: 2,
    overfillMult: 1.5,
  };
  const last = closes[closes.length - 1];
  const merged = finalizeCandidateReadiness({
    base,
    closes,
    lastPrice: last,
    flashCfg,
    flashEnabled: false,
    downsideBars: 0,
    shortReturnBars: 3,
    momentumWarnPct: 3,
    hourDeclineBars: 12,
  });
  assert.equal(merged.readiness.primaryBlocker, 'hour_decline');
  assert.equal(merged.readiness.ready, false);
});

t('applyPriceChangePct3mPenalty: negatif 3dk hazır değil skor -1', () => {
  const closes = [];
  for (let i = 0; i < 30; i++) {
    const c = 100 + Math.sin(i / 3) * 2;
    closes.push(c);
  }
  const klines = closes.map((c) => ({ high: c + 0.8, low: c - 0.8, close: c }));
  const base = evaluateGridReadiness({
    klines,
    lastPrice: closes[closes.length - 1],
    spreadPct: 0.02,
    config: cfgNoStability(),
  });
  assert.equal(base.ready, true);
  const penalized = applyPriceChangePct3mPenalty(base, -0.04);
  assert.equal(penalized.ready, false);
  assert.equal(penalized.score, Number((base.score - 1).toFixed(2)));
  assert.equal(penalized.primaryBlocker, 'pct_3m_decline');
  assert.ok(penalized.gates.some((g) => g.id === 'pct_3m_decline' && !g.pass));
  assert.equal(applyPriceChangePct3mPenalty(base, 0.1), base);
});

t('isPostExitCooldownActive: floor sonrası bekleme', () => {
  const now = Date.parse('2026-06-01T03:15:00Z');
  const floor = { cycledAt: '2026-06-01 03:09:00' };
  assert.equal(isPostExitCooldownActive(true, 45, undefined, floor, now), true);
  assert.equal(isPostExitCooldownActive(true, 45, undefined, floor, Date.parse('2026-06-01T04:00:00Z')), false);
});

console.log(`\n${passed} test geçti.`);
