/**
 * Panel grid-candidates vs Binance REST + aynı readiness kodu.
 * npx tsx scripts/verify-readiness-vs-binance.mjs
 */
import {
  evaluateGridReadiness,
  finalizeCandidateReadiness,
  efficiencyRatio,
  rangeWidthPct,
  meanAtrPct,
  pathRangeRatio,
  shortNetReturnPct,
  hourContinuousDeclineBlocked,
  consecutiveLowerCloses,
  rangePositionPct,
} from '../src/strategy/grid-readiness.ts';
import { autoRangeFromCloses } from '../src/strategy/grid.ts';
import { flashDropConfigFromGrid } from '../src/strategy/grid-flash-drop.ts';

const TRIGGER = process.env.TRIGGER_SECRET || 'coin-bot-trigger-2026';
const API = process.env.API_BASE || 'https://coin.digitexa.com';

const PROD_CFG = {
  maxEfficiencyRatio: 0.25,
  minRangeWidthPct: 3.0,
  maxRangeWidthPct: 18,
  minAtrPct: 0.25,
  maxSpreadPct: 0.1,
  rangePctl: 8,
  maxPathRangeRatio: 12,
  maxBarRangePathRatio: 18,
  maxStabilityRangePct: 28,
  stabilityBars: 288,
  readinessLookback: 96,
  downsideBars: 3,
  shortReturnBars: 3,
  momentumWarnPct: 3.0,
  maxEntryBandPct: 65,
  mediumReturnBars: 36,
  mediumReturnWarnPct: 2.5,
  hourDeclineBars: 12,
  hourDeclineEnabled: true,
  flashDropEnabled: true,
  flashDropWarnPct: 2,
  flashDropPausePct: 3,
  flashDropRecoveryPct: 5,
  flashDropWindowMin: 15,
  flashDropMaxFills: 3,
  flashDropFillWindowMin: 10,
  flashDropOverfillMult: 1.5,
};

const readinessCfg = {
  maxEfficiencyRatio: PROD_CFG.maxEfficiencyRatio,
  minRangeWidthPct: PROD_CFG.minRangeWidthPct,
  maxRangeWidthPct: PROD_CFG.maxRangeWidthPct,
  minAtrPct: PROD_CFG.minAtrPct,
  maxSpreadPct: PROD_CFG.maxSpreadPct,
  rangePctl: PROD_CFG.rangePctl,
  maxPathRangeRatio: PROD_CFG.maxPathRangeRatio,
  maxBarRangePathRatio: PROD_CFG.maxBarRangePathRatio,
  maxStabilityRangePct: PROD_CFG.maxStabilityRangePct,
  stabilityBars: PROD_CFG.stabilityBars,
};

const flashCfg = flashDropConfigFromGrid({
  flashDropWarnPct: PROD_CFG.flashDropWarnPct,
  flashDropPausePct: PROD_CFG.flashDropPausePct,
  flashDropRecoveryPct: PROD_CFG.flashDropRecoveryPct,
  flashDropWindowMin: PROD_CFG.flashDropWindowMin,
  flashDropMaxFills: PROD_CFG.flashDropMaxFills,
  flashDropFillWindowMin: PROD_CFG.flashDropFillWindowMin,
  flashDropOverfillMult: PROD_CFG.flashDropOverfillMult,
});

function numClose(a, b, tol = 0.02) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  const da = Math.abs(a - b);
  const rel = b !== 0 ? da / Math.abs(b) : da;
  return da < tol || rel < 0.02;
}

async function fetchKlines(symbol, limit) {
  const res = await fetch(
    `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=5m&limit=${limit}`,
  );
  if (!res.ok) throw new Error(`klines ${symbol} ${res.status}`);
  const rows = await res.json();
  return rows.map((x) => ({ high: +x[2], low: +x[3], close: +x[4] }));
}

async function fetchBook(symbol) {
  const res = await fetch(`https://api.binance.com/api/v3/ticker/bookTicker?symbol=${symbol}`);
  if (!res.ok) return null;
  const book = await res.json();
  const bid = +book.bidPrice;
  const ask = +book.askPrice;
  const mid = (bid + ask) / 2;
  return mid > 0 ? ((ask - bid) / mid) * 100 : null;
}

function recompute(symbol, klines288, spreadPct, lastPrice) {
  // Panel: fetchReadinessKlines → genelde 288 bar (stabilityBars), ER/rw tüm pencerede
  const lookback = klines288.length >= 20 ? klines288 : [];
  const stab = lookback;
  const closes = lookback.map((k) => k.close).filter((c) => c > 0);
  const highs = lookback.map((k) => k.high);
  const lows = lookback.map((k) => k.low);

  const base = evaluateGridReadiness({
    klines: lookback,
    lastPrice,
    spreadPct,
    config: readinessCfg,
  });
  const merged = finalizeCandidateReadiness({
    base,
    closes,
    lastPrice,
    flashCfg,
    flashEnabled: PROD_CFG.flashDropEnabled,
    downsideBars: PROD_CFG.downsideBars,
    shortReturnBars: PROD_CFG.shortReturnBars,
    momentumWarnPct: PROD_CFG.momentumWarnPct,
    maxEntryBandPct: PROD_CFG.maxEntryBandPct,
    mediumReturnBars: PROD_CFG.mediumReturnBars,
    mediumReturnWarnPct: PROD_CFG.mediumReturnWarnPct,
    hourDeclineBars: PROD_CFG.hourDeclineEnabled ? PROD_CFG.hourDeclineBars : 0,
  });
  const r = merged.readiness;
  const stabK = stab.slice(-PROD_CFG.stabilityBars);
  const prr = pathRangeRatio(stabK);

  const range = base.range;
  const bandPos = range ? rangePositionPct(lastPrice, range) : null;

  return {
    ready: r.ready,
    primaryBlocker: r.primaryBlocker,
    score: Number(r.score.toFixed(2)),
    er: efficiencyRatio(closes),
    rw: rangeWidthPct(highs, lows),
    atr: meanAtrPct(lookback),
    prr,
    ret3: shortNetReturnPct(closes, 3),
    ret36: shortNetReturnPct(closes, 36),
    hourDecline: hourContinuousDeclineBlocked(closes, PROD_CFG.hourDeclineBars),
    cons3: consecutiveLowerCloses(closes, 3),
    bandPos,
    gates: Object.fromEntries(r.gates.map((g) => [g.id, g.pass])),
  };
}

const panelRes = await fetch(`${API}/admin/api/grid-candidates`, {
  headers: { 'X-Trigger-Secret': TRIGGER },
});
if (!panelRes.ok) {
  console.error('Panel API hata', panelRes.status);
  process.exit(1);
}
const { candidates, marketGate } = await panelRes.json();

const wlRes = await fetch(`${API}/admin/api/dashboard`, {
  headers: { 'X-Trigger-Secret': TRIGGER },
}).catch(() => null);

console.log('=== Panel özeti ===');
console.log(`Aday tabloda: ${candidates.length}`);
console.log(`Market gate: active=${marketGate?.active} reasons=${marketGate?.reasons?.join(',')}`);
console.log('');

const mismatches = [];
const rows = [];

for (const c of candidates) {
  await new Promise((r) => setTimeout(r, 120));
  let k288, spread;
  try {
    [k288, spread] = await Promise.all([fetchKlines(c.symbol, 288), fetchBook(c.symbol)]);
  } catch (e) {
    rows.push({ symbol: c.symbol, err: e.message });
    continue;
  }
  const last = c.lastPrice > 0 ? c.lastPrice : k288.at(-1).close;
  const calc = recompute(c.symbol, k288, spread, last);

  const issues = [];
  if (c.ready !== calc.ready) issues.push(`ready panel=${c.ready} calc=${calc.ready}`);
  const blockerMatch =
    c.primaryBlocker === calc.primaryBlocker ||
    c.primaryBlocker === 'force_active' ||
    (c.primaryBlocker === 'spread' && calc.primaryBlocker === 'downside_momentum');
  if (!blockerMatch) {
    issues.push(`blocker panel=${c.primaryBlocker} calc=${calc.primaryBlocker}`);
  }
  if (!numClose(c.efficiencyRatio, calc.er, 0.001)) issues.push(`ER panel=${c.efficiencyRatio?.toFixed(4)} calc=${calc.er?.toFixed(4)}`);
  if (!numClose(c.rangeWidthPct, calc.rw, 0.15)) issues.push(`rw% panel=${c.rangeWidthPct?.toFixed(2)} calc=${calc.rw?.toFixed(2)}`);
  if (!numClose(c.atrPct, calc.atr, 0.08)) issues.push(`atr% panel=${c.atrPct?.toFixed(3)} calc=${calc.atr?.toFixed(3)}`);
  if (c.pathRangeRatio != null && calc.prr != null && !numClose(c.pathRangeRatio, calc.prr, 0.2)) {
    issues.push(`path× panel=${c.pathRangeRatio} calc=${calc.prr?.toFixed(2)}`);
  }

  const panelHiddenHour = false;
  if (calc.hourDecline && c.symbol) {
    issues.push(`BINANCE: 12×5m sürekli düşüş (listeden çıkarılmalıydı?)`);
  }

  rows.push({
    symbol: c.symbol,
    panelReady: c.ready,
    calcReady: calc.ready,
    panelBlocker: c.primaryBlocker,
    calcBlocker: calc.primaryBlocker,
    ret3h: calc.ret36?.toFixed(2),
    ret15m: calc.ret3?.toFixed(2),
    bandPct: calc.bandPos?.toFixed(0),
    hourDecl: calc.hourDecline,
    issues,
  });
  if (issues.length) mismatches.push({ symbol: c.symbol, issues });
}

console.log('Sembol          | Panel hazır | Binance hazır | Panel engel          | Binance engel        | 3s%   | 15m% | Band% | 1s↓');
console.log('-'.repeat(115));
for (const r of rows.sort((a, b) => a.symbol.localeCompare(b.symbol))) {
  if (r.err) {
    console.log(`${r.symbol.padEnd(15)} | ERR ${r.err}`);
    continue;
  }
  console.log(
    `${r.symbol.padEnd(15)} | ${String(r.panelReady).padEnd(11)} | ${String(r.calcReady).padEnd(13)} | ${(r.panelBlocker ?? '—').padEnd(20)} | ${(r.calcBlocker ?? '—').padEnd(20)} | ${String(r.ret3h ?? '—').padStart(5)} | ${String(r.ret15m ?? '—').padStart(4)} | ${String(r.bandPct ?? '—').padStart(5)} | ${r.hourDecl ? 'EVET' : 'hayır'}`,
  );
}

console.log('\n=== Uyumsuzluklar (force_active hariç) ===');
if (mismatches.length === 0) {
  console.log('Tüm görünen adaylar Binance REST ile uyumlu (metrik toleransı içinde).');
} else {
  for (const m of mismatches) {
    console.log(`\n${m.symbol}:`);
    for (const i of m.issues) console.log(`  - ${i}`);
  }
}

const watchlist = [
  'CHZUSDT', 'DOTUSDT', 'FETUSDT', 'GIGGLEUSDT', 'HBARUSDT', 'ICPUSDT', 'INJUSDT', 'JSTUSDT',
  'JTOUSDT', 'KITEUSDT', 'LUNCUSDT', 'MEMEUSDT', 'NEARUSDT', 'NIGHTUSDT', 'SEIUSDT', 'SOLUSDT',
  'TONUSDT', 'WLFIUSDT', 'ZECUSDT', 'ZENUSDT',
];
const inPanel = new Set(candidates.map((c) => c.symbol));
const missing = watchlist.filter((s) => !inPanel.has(s));
console.log('\n=== Watchlist’te olup panelde görünmeyen (hour_decline filtresi?) ===');
console.log(missing.length ? missing.join(', ') : '(hepsi tabloda veya watchlist=panel)');

if (missing.length) {
  for (const sym of missing) {
    await new Promise((r) => setTimeout(r, 120));
    const k96 = await fetchKlines(sym, 96);
    const closes = k96.map((k) => k.close);
    const hd = hourContinuousDeclineBlocked(closes, 12);
    const ret12 = shortNetReturnPct(closes, 12);
    console.log(`  ${sym}: hour_decline=${hd} ret12=${ret12?.toFixed(2)}% cons12=${consecutiveLowerCloses(closes, 12)}`);
  }
}
