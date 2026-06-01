#!/usr/bin/env node
/**
 * Spot Grid backtester (Faz: grid validasyon)
 *
 * Tarihsel kline ile grid stratejisini simüle eder; maker fee dahil net realize
 * kâr, tamamlanan döngü, envanter (drawdown), kalan unrealized raporlar.
 *
 * Dürüstlük: WALK-FORWARD — aralık (range) ilk %50'de kalibre edilir, ikinci
 * %50'de test edilir (lookahead yok).
 *
 * Çalıştırma:
 *   node scripts/grid-backtest.mjs
 *   SYMBOLS=BTCUSDT,ETHUSDT DAYS=30 GRIDS=20,40,60 MAKER_FEE=0.075 node scripts/grid-backtest.mjs
 */

const BASE = process.env.BINANCE_BASE_URL ?? 'https://api.binance.com';
const SYMBOLS = (process.env.SYMBOLS ?? 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,DOGEUSDT').split(',');
const DAYS = Number(process.env.DAYS ?? '30');
const INTERVAL = process.env.INTERVAL ?? '5m';
const GRID_COUNTS = (process.env.GRIDS ?? '20,40,60').split(',').map(Number);
const MAKER_FEE_PCT = Number(process.env.MAKER_FEE ?? '0.075'); // BNB indirimli maker, tek bacak %
const INVESTMENT = Number(process.env.INVESTMENT ?? '1000');
const RANGE_PCTL = Number(process.env.RANGE_PCTL ?? '10'); // alt=p10, üst=p90 kalibrasyon

const INTERVAL_MS = { '1m': 60000, '5m': 300000, '15m': 900000 }[INTERVAL] ?? 300000;

async function fetchKlines(symbol, days) {
  const total = Math.ceil((days * 24 * 60 * 60000) / INTERVAL_MS);
  const out = [];
  let endTime = Date.now();
  while (out.length < total) {
    const limit = Math.min(1000, total - out.length);
    const url = `${BASE}/api/v3/klines?symbol=${symbol}&interval=${INTERVAL}&limit=${limit}&endTime=${endTime}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`klines ${symbol}: ${res.status}`);
    const rows = await res.json();
    if (!rows.length) break;
    const parsed = rows.map((r) => ({ t: r[0], high: Number(r[2]), low: Number(r[3]), close: Number(r[4]) }));
    out.unshift(...parsed);
    endTime = rows[0][0] - 1;
    if (rows.length < limit) break;
  }
  return out;
}

function percentile(sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx];
}

/**
 * Aritmetik grid simülasyonu.
 * - levels: lower..upper, gridCount aralık.
 * - Başlangıç: fiyatın altındaki her seviyeye resting BUY.
 * - Mum low bir buy seviyesini keserse: alım dolar, bir üst seviyeye SELL armla.
 * - Mum high armlı bir sell seviyesini keserse: satış dolar, döngü kârı realize,
 *   o seviyeye (bir alt) tekrar BUY armla.
 * - Fee her fill'de notional * makerFee.
 */
function simulateGrid(klines, lower, upper, gridCount, investment, makerFeePct) {
  const step = (upper - lower) / gridCount;
  const levels = Array.from({ length: gridCount + 1 }, (_, i) => lower + i * step);
  const quotePerGrid = investment / gridCount;
  const fee = makerFeePct / 100;

  // her seviye için durum: 'buy' (resting alım), 'sell' (armlı satım, envanterli), null
  const startPrice = klines[0].close;
  const state = levels.map((lvl) => (lvl < startPrice ? 'buy' : null));
  const buyCost = levels.map(() => 0); // o seviyeden alınan qty maliyeti
  const buyQty = levels.map(() => 0);

  let realized = 0;
  let feesPaid = 0;
  let cycles = 0;
  let inventoryQty = 0;
  let inventoryCost = 0;
  let maxInventoryCost = 0;

  for (const k of klines) {
    // Düşüş: low ile kesişen buy seviyeleri (yüksekten alçağa)
    for (let i = levels.length - 1; i >= 0; i--) {
      if (state[i] === 'buy' && k.low <= levels[i]) {
        const price = levels[i];
        const qty = quotePerGrid / price;
        const cost = qty * price;
        const f = cost * fee;
        feesPaid += f;
        buyQty[i] = qty;
        buyCost[i] = cost;
        inventoryQty += qty;
        inventoryCost += cost;
        maxInventoryCost = Math.max(maxInventoryCost, inventoryCost);
        // bir üst seviyeye sell armla
        if (i + 1 < state.length) state[i + 1] = 'sell';
        state[i] = null;
      }
    }
    // Yükseliş: high ile kesişen sell seviyeleri (alçaktan yükseğe)
    for (let i = 0; i < levels.length; i++) {
      if (state[i] === 'sell' && k.high >= levels[i]) {
        const price = levels[i];
        // bir alt seviyeden alınan envanteri sat
        const srcQty = buyQty[i - 1] || quotePerGrid / levels[i - 1];
        const proceeds = srcQty * price;
        const f = proceeds * fee;
        feesPaid += f;
        const cost = buyCost[i - 1] || (quotePerGrid / levels[i - 1]) * levels[i - 1];
        realized += proceeds - cost - f - (cost * fee); // satış fee + alış fee (yaklaşık)
        cycles++;
        inventoryQty -= srcQty;
        inventoryCost -= cost;
        buyQty[i - 1] = 0;
        buyCost[i - 1] = 0;
        // o alt seviyeye tekrar buy armla
        if (i - 1 >= 0) state[i - 1] = 'buy';
        state[i] = null;
      }
    }
  }

  const finalPrice = klines[klines.length - 1].close;
  const unrealized = inventoryQty * finalPrice - inventoryCost;
  const spacingPct = (step / ((lower + upper) / 2)) * 100;

  return {
    realized,
    unrealized,
    net: realized + unrealized,
    feesPaid,
    cycles,
    spacingPct,
    maxInventoryCost,
    finalInventoryUsdt: inventoryQty * finalPrice,
    netPctOnInvest: ((realized + unrealized) / investment) * 100,
    realizedPctOnInvest: (realized / investment) * 100,
  };
}

function fmt(n, d = 2) {
  return Number.isFinite(n) ? n.toFixed(d) : '—';
}

async function run() {
  console.log(
    `Grid backtest · interval=${INTERVAL} days=${DAYS} maker_fee=%${MAKER_FEE_PCT} invest=$${INVESTMENT}\n` +
      `Walk-forward: aralık ilk %50'de kalibre, ikinci %50'de test.\n`,
  );
  const summary = [];
  for (const symbol of SYMBOLS) {
    let klines;
    try {
      klines = await fetchKlines(symbol, DAYS);
    } catch (e) {
      console.log(`${symbol}: kline hatası ${e.message}`);
      continue;
    }
    if (klines.length < 200) {
      console.log(`${symbol}: yetersiz kline (${klines.length})`);
      continue;
    }
    const mid = Math.floor(klines.length / 2);
    const calib = klines.slice(0, mid);
    const test = klines.slice(mid);
    const closes = calib.map((k) => k.close).sort((a, b) => a - b);
    const lower = percentile(closes, RANGE_PCTL);
    const upper = percentile(closes, 100 - RANGE_PCTL);
    const testCloses = test.map((k) => k.close);
    const inRange = testCloses.filter((c) => c >= lower && c <= upper).length / testCloses.length;

    console.log(`\n=== ${symbol} === aralık [${fmt(lower, 4)}, ${fmt(upper, 4)}] · test fiyatı aralıkta %${fmt(inRange * 100, 0)}`);
    for (const g of GRID_COUNTS) {
      const r = simulateGrid(test, lower, upper, g, INVESTMENT, MAKER_FEE_PCT);
      const feeOk = r.spacingPct >= (MAKER_FEE_PCT / 100) * 2 * 100 * 2; // spacing >= ~4x tek-bacak fee
      console.log(
        `  grids=${g} spacing=%${fmt(r.spacingPct, 3)}${feeOk ? '' : ' (fee duvarı!)'} ` +
          `realized=%${fmt(r.realizedPctOnInvest)} unreal=%${fmt((r.unrealized / INVESTMENT) * 100)} ` +
          `net=%${fmt(r.netPctOnInvest)} cycles=${r.cycles} maxEnv=$${fmt(r.maxInventoryCost)}`,
      );
      summary.push({ symbol, g, ...r, inRange });
    }
  }

  // En iyi net konfigürasyonlar
  summary.sort((a, b) => b.netPctOnInvest - a.netPctOnInvest);
  console.log('\n=== ÖZET (net % kazanan, top 8) ===');
  for (const s of summary.slice(0, 8)) {
    console.log(
      `${s.symbol} grids=${s.g}: net=%${fmt(s.netPctOnInvest)} (realized %${fmt(s.realizedPctOnInvest)}, ` +
        `unreal %${fmt((s.unrealized / INVESTMENT) * 100)}) cycles=${s.cycles} inRange=%${fmt(s.inRange * 100, 0)}`,
    );
  }
  const positives = summary.filter((s) => s.netPctOnInvest > 0).length;
  const realizedPos = summary.filter((s) => s.realizedPctOnInvest > 0).length;
  console.log(
    `\nKonfig sayısı=${summary.length} · net pozitif=${positives} · realized pozitif=${realizedPos}`,
  );
  console.log(
    'Not: realized = grid döngü geliri (asıl edge); unrealized = aralık altına sarkan envanter (bag) riski.',
  );
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
