/**
 * Watchlist + readiness denetimi. npx tsx scripts/audit-watchlist-readiness.mjs
 */
import {
  evaluateGridReadiness,
  finalizeCandidateReadiness,
} from '../src/strategy/grid-readiness.ts';
import { flashDropConfigFromGrid } from '../src/strategy/grid-flash-drop.ts';

const SYMBOLS = process.argv.slice(2);
if (SYMBOLS.length === 0) {
  console.error('Sembol listesi ver: npx tsx scripts/audit-watchlist-readiness.mjs SOLUSDT ...');
  process.exit(1);
}

const cfg = {
  maxEfficiencyRatio: 0.35,
  minRangeWidthPct: 2.5,
  maxRangeWidthPct: 15,
  minAtrPct: 0.15,
  maxSpreadPct: 0.08,
  rangePctl: 10,
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

const blockerCounts = {};
let ready = 0;

for (const symbol of SYMBOLS) {
  const res = await fetch(
    `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=5m&limit=288`,
  );
  if (!res.ok) {
    console.log(`${symbol}: kline hata`);
    continue;
  }
  const rows = await res.json();
  const klines = rows.map((x) => ({ high: +x[2], low: +x[3], close: +x[4] }));
  const last = klines.at(-1).close;
  const closes = klines.map((k) => k.close);
  const book = await fetch(`https://api.binance.com/api/v3/ticker/bookTicker?symbol=${symbol}`).then(
    (r) => r.json(),
  );
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
  const b = r.primaryBlocker ?? 'READY';
  blockerCounts[b] = (blockerCounts[b] ?? 0) + 1;
  if (r.ready) {
    ready++;
    console.log(`✓ ${symbol} score=${r.score.toFixed(0)} rw=${r.rangeWidthPct?.toFixed(1)}% spread=${spreadPct?.toFixed(3)}`);
  } else {
    const fail = r.gates.filter((g) => !g.pass).map((g) => g.id).join(',');
    console.log(`✗ ${symbol} → ${b} | fails: ${fail}`);
  }
  await new Promise((r) => setTimeout(r, 80));
}

console.log(`\nÖzet: ${ready}/${SYMBOLS.length} hazır`);
console.log('Engel dağılımı:', blockerCounts);
