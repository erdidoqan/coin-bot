/**
 * Tek sembol readiness (prod config). Kullanım: npx tsx scripts/check-symbol-readiness.mjs ZAMAUSDT
 */
import {
  evaluateGridReadiness,
  finalizeCandidateReadiness,
} from '../src/strategy/grid-readiness.ts';

const symbol = (process.argv[2] || 'ZAMAUSDT').toUpperCase();
if (!symbol.endsWith('USDT')) throw new Error('USDT sembol ver');

const cfg = {
  maxEfficiencyRatio: 0.35,
  minRangeWidthPct: 2.5,
  maxRangeWidthPct: 15,
  minAtrPct: 0.15,
  maxSpreadPct: 0.08,
  rangePctl: 15,
  maxPathRangeRatio: 10,
  maxBarRangePathRatio: 14,
  maxStabilityRangePct: 26,
  stabilityBars: 288,
};

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

const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=5m&limit=288`);
if (!res.ok) throw new Error(await res.text());
const rows = await res.json();
const klines = rows.map((x) => ({ high: +x[2], low: +x[3], close: +x[4] }));
const last = klines.at(-1).close;
const closes = klines.map((k) => k.close);

const book = await fetch(`https://api.binance.com/api/v3/ticker/bookTicker?symbol=${symbol}`).then((r) => r.json());
const bid = +book.bidPrice;
const ask = +book.askPrice;
const mid = (bid + ask) / 2;
const spreadPct = mid > 0 ? ((ask - bid) / mid) * 100 : null;

const base = evaluateGridReadiness({ klines, lastPrice: last, spreadPct, config: cfg });
const m = finalizeCandidateReadiness({
  base,
  closes,
  lastPrice: last,
  flashCfg,
  flashEnabled: true,
  downsideBars: 3,
  shortReturnBars: 3,
  momentumWarnPct: 2,
});

const r = m.readiness;
console.log(`\n=== ${symbol} ===`);
console.log(`Fiyat: ${last} | Spread: ${spreadPct?.toFixed(4)}%`);
console.log(`Hazır: ${r.ready} | İlk engel: ${r.primaryBlocker}`);
console.log(`Skor: ${r.score.toFixed(1)} | Range band: ${r.range ? `${r.range.lower.toFixed(6)} .. ${r.range.upper.toFixed(6)}` : 'n/a'}`);
console.log('\nKapılar:');
for (const g of r.gates) {
  const mark = g.pass ? '✓' : '✗';
  console.log(` ${mark} ${g.id.padEnd(22)} actual=${g.actual?.toFixed?.(4) ?? g.actual}  (${g.threshold})`);
}
