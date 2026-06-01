import { evaluateGridReadiness, defaultGridReadinessConfig } from '../src/strategy/grid-readiness.ts';

const res = await fetch(
  'https://api.binance.com/api/v3/klines?symbol=ALLOUSDT&interval=5m&limit=288',
);
const rows = await res.json();
const klines = rows.map((x) => ({ high: +x[2], low: +x[3], close: +x[4] }));
const last = klines[klines.length - 1].close;
const r = evaluateGridReadiness({
  klines,
  lastPrice: last,
  spreadPct: 0.05,
  config: defaultGridReadinessConfig(),
});
import { evaluateFlashDropForScout } from '../src/strategy/grid-flash-drop.ts';
import { finalizeCandidateReadiness } from '../src/strategy/grid-readiness.ts';

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

for (const [label, subset] of [
  ['288 bar (REST)', klines],
  ['120 bar (DO gibi)', klines.slice(-120)],
]) {
  const closes = subset.map((k) => k.close);
  const last = closes.at(-1);
  const flash = evaluateFlashDropForScout({ lastPrice: last, klineCloses: closes, cfg: flashCfg });
  const base2 = evaluateGridReadiness({
    klines: subset,
    lastPrice: last,
    spreadPct: 0.02,
    config: defaultGridReadinessConfig(),
  });
  const m = finalizeCandidateReadiness({
    base: base2,
    closes,
    lastPrice: last,
    flashCfg,
    flashEnabled: true,
    downsideBars: 3,
    shortReturnBars: 3,
    momentumWarnPct: 2,
  });
  console.log(
    `\n${label}: flash=${flash.level} winDrop=${flash.metrics.windowDropPct.toFixed(2)}% ready=${m.readiness.ready} blocker=${m.readiness.primaryBlocker}`,
  );
}

console.log('\n--- full 288 ---');
console.log('ready:', r.ready, 'blocker:', r.primaryBlocker);
for (const g of r.gates) {
  if (!g.pass) console.log(' FAIL', g.id, g.actual, g.threshold);
}
const flashGate = r.gates.find((g) => g.id === 'no_flash_drop');
if (flashGate) console.log(' flash gate:', flashGate.pass, flashGate.actual);
