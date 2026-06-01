/**
 * Spot işlem komisyon analizi (BNB ile ödeme dahil).
 * .dev.vars → BINANCE_API_KEY / BINANCE_API_SECRET
 *
 * Tek sembol:  node scripts/analyze-spot-fees.mjs ONDOUSDT 20
 * Genel:       node scripts/analyze-spot-fees.mjs --all [GLOBAL_LIMIT]
 */
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.join(ROOT, '..');
const varsPath = path.join(REPO, '.dev.vars');
const vars = Object.fromEntries(
  fs
    .readFileSync(varsPath, 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const API_KEY = vars.BINANCE_API_KEY;
const API_SECRET = vars.BINANCE_API_SECRET;
const BASE = vars.BINANCE_BASE_URL || 'https://api.binance.com';

const ALL_MODE = process.argv[2] === '--all';
const SYMBOL = ALL_MODE ? null : (process.argv[2] || 'ONDOUSDT').toUpperCase();
const PER_SYMBOL_LIMIT = ALL_MODE ? 12 : Math.min(1000, Math.max(5, Number(process.argv[3]) || 20));
const GLOBAL_LIMIT = ALL_MODE ? Math.min(80, Math.max(20, Number(process.argv[3]) || 40)) : PER_SYMBOL_LIMIT;

const STABLE = new Set(['USDT', 'USDC', 'FDUSD', 'BUSD', 'TUSD', 'DAI', 'USDP']);

function sign(query) {
  return crypto.createHmac('sha256', API_SECRET).update(query).digest('hex');
}

async function api(method, pathname, params = {}, signed = false) {
  const body = signed
    ? { ...params, timestamp: String(Date.now()), recvWindow: '5000' }
    : { ...params };
  const q = new URLSearchParams(
    Object.fromEntries(Object.entries(body).map(([k, v]) => [k, String(v)])),
  );
  let url = `${BASE}${pathname}?${q}`;
  if (signed) {
    url += `&signature=${sign(q.toString())}`;
  }
  const headers = signed ? { 'X-MBX-APIKEY': API_KEY } : {};
  const res = await fetch(url, { method, headers });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(text.slice(0, 300));
  }
  if (!res.ok || (data.code != null && data.code < 0)) {
    throw new Error(data.msg ?? text);
  }
  return data;
}

function commissionToUsdt(trade, bnbUsdt) {
  const comm = Number(trade.commission);
  const asset = trade.commissionAsset;
  const price = Number(trade.price);
  const base = trade.symbol.replace(/USDT$|USDC$|FDUSD$/, '');
  if (comm <= 0) return 0;
  if (asset === 'USDT' || asset === 'USDC' || asset === 'FDUSD') return comm;
  if (asset === 'BNB') return comm * bnbUsdt;
  if (asset === base) return comm * price;
  return comm * price;
}

function fmt(n, d = 4) {
  return Number(n).toFixed(d);
}

function baseAsset(symbol) {
  return symbol.replace(/USDT$|USDC$|FDUSD$/, '');
}

function fetchBotSymbols() {
  try {
    const raw = execSync(
      'wrangler d1 execute coin-bot-db --remote --command "SELECT DISTINCT symbol FROM grid_state UNION SELECT DISTINCT symbol FROM open_positions" --json',
      { cwd: REPO, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
    );
    const parsed = JSON.parse(raw);
    const rows = parsed?.[0]?.results ?? [];
    return rows.map((r) => r.symbol).filter(Boolean);
  } catch {
    return [];
  }
}

async function discoverSymbols(priceMap) {
  const symbols = new Set(fetchBotSymbols());

  const openOrders = await api('GET', '/api/v3/openOrders', {}, true);
  for (const o of openOrders) symbols.add(o.symbol);

  const account = await api('GET', '/api/v3/account', {}, true);
  for (const b of account.balances) {
    const free = Number(b.free);
    const locked = Number(b.locked);
    const total = free + locked;
    if (total <= 0 || STABLE.has(b.asset)) continue;
    const sym = `${b.asset}USDT`;
    const px = Number(priceMap.get(sym) ?? 0);
    if (px > 0 && total * px >= 0.5) symbols.add(sym);
  }

  return [...symbols].filter((s) => priceMap.has(s)).sort();
}

function summarizeTrades(trades, bnbUsdt) {
  let sumFee = 0;
  let sumQuote = 0;
  const makers = [];
  const takers = [];
  const bnbComm = [];
  const quoteComm = [];
  const baseComm = [];

  for (const t of trades) {
    const quote = Number(t.quoteQty);
    const fee = commissionToUsdt(t, bnbUsdt);
    const pct = quote > 0 ? (fee / quote) * 100 : 0;
    sumFee += fee;
    sumQuote += quote;
    if (t.isMaker) makers.push({ fee, quote, pct });
    else takers.push({ fee, quote, pct });
    if (t.commissionAsset === 'BNB') bnbComm.push(pct);
    else if (['USDT', 'USDC', 'FDUSD'].includes(t.commissionAsset)) quoteComm.push(pct);
    else baseComm.push(pct);
  }

  const w = (arr) => {
    const q = arr.reduce((s, x) => s + x.quote, 0);
    const f = arr.reduce((s, x) => s + x.fee, 0);
    return q > 0 ? (f / q) * 100 : 0;
  };

  return {
    count: trades.length,
    sumFee,
    sumQuote,
    weightedPct: sumQuote > 0 ? (sumFee / sumQuote) * 100 : 0,
    makerPct: w(makers),
    takerPct: w(takers),
    makerN: makers.length,
    takerN: takers.length,
    bnbN: bnbComm.length,
    bnbAvg: bnbComm.length ? bnbComm.reduce((a, b) => a + b, 0) / bnbComm.length : 0,
    bnbMakerAvg:
      bnbComm.length && makers.length
        ? makers
            .filter((_, i) => trades.filter((t) => t.isMaker)[i])
            .map(() => 0)
        : 0,
  };
}

function printSingleSymbol(trades, symbol, bnbUsdt) {
  const base = baseAsset(symbol);
  console.log(`\n=== ${symbol} — son ${trades.length} fill (BNB/USDT ≈ ${fmt(bnbUsdt, 2)}) ===\n`);
  console.log(
    'time (UTC)           | side  | maker | quote USDT | comm      | asset | fee %   | fee USDT',
  );
  console.log('-'.repeat(95));

  for (const t of trades) {
    const quote = Number(t.quoteQty);
    const feeUsdt = commissionToUsdt(t, bnbUsdt);
    const feePct = quote > 0 ? (feeUsdt / quote) * 100 : 0;
    const side = t.isBuyer ? 'BUY ' : 'SELL';
    const maker = t.isMaker ? 'Y' : 'N';
    const dt = new Date(t.time).toISOString().replace('T', ' ').slice(0, 19);
    console.log(
      `${dt} | ${side} | ${maker}     | ${fmt(quote, 4).padStart(10)} | ${fmt(t.commission, 8).padStart(9)} | ${t.commissionAsset.padEnd(4)} | ${fmt(feePct, 4)}% | ${fmt(feeUsdt, 5)}`,
    );
  }

  const s = summarizeTrades(trades, bnbUsdt);
  console.log('\n--- Özet ---');
  console.log(`Toplam hacim: ${fmt(s.sumQuote, 4)} USDT | komisyon: ${fmt(s.sumFee, 5)} USDT`);
  console.log(`Ağırlıklı ort.: ${fmt(s.weightedPct, 4)}% | maker (${s.makerN}): ${fmt(s.makerPct, 4)}% | taker (${s.takerN}): ${fmt(s.takerPct, 4)}%`);
  console.log(`BNB komisyonlu fill: ${s.bnbN} | maker×2 roundtrip tahmini: ${fmt(s.makerPct * 2, 4)}%`);
}

async function runAll() {
  const prices = await api('GET', '/api/v3/ticker/price');
  const priceMap = new Map(prices.map((p) => [p.symbol, p.price]));
  const bnbUsdt = Number(priceMap.get('BNBUSDT'));

  const symbols = await discoverSymbols(priceMap);
  console.log(`\n🔍 ${symbols.length} sembol taranıyor (bot grid + açık emir + bakiye ≥0.5 USDT)…\n`);

  const all = [];
  let errors = 0;
  for (const sym of symbols) {
    try {
      const raw = await api(
        'GET',
        '/api/v3/myTrades',
        { symbol: sym, limit: PER_SYMBOL_LIMIT },
        true,
      );
      for (const t of raw) {
        all.push({ ...t, symbol: sym });
      }
    } catch {
      errors += 1;
    }
    await new Promise((r) => setTimeout(r, 80));
  }

  all.sort((a, b) => a.time - b.time);
  const recent = all.slice(-GLOBAL_LIMIT);

  const makersBnb = recent.filter((t) => t.isMaker && t.commissionAsset === 'BNB');
  const makers = recent.filter((t) => t.isMaker);
  const takers = recent.filter((t) => !t.isMaker);

  const global = summarizeTrades(recent, bnbUsdt);
  const makerBnbStats = summarizeTrades(makersBnb, bnbUsdt);
  const makerStats = summarizeTrades(makers, bnbUsdt);
  const takerStats = summarizeTrades(takers, bnbUsdt);

  console.log('═'.repeat(72));
  console.log(`GENEL ÖZET — son ${recent.length} fill (tüm semboller, ${all.length} fill tarandı)`);
  console.log('═'.repeat(72));
  console.log(`Taranan sembol: ${symbols.length} | API hata: ${errors}`);
  console.log(`Toplam hacim: ${fmt(global.sumQuote, 2)} USDT`);
  console.log(`Toplam komisyon (≈USDT): ${fmt(global.sumFee, 4)} USDT`);
  console.log(`Ağırlıklı ort. (tek bacak): ${fmt(global.weightedPct, 4)}%`);
  console.log(`  └ maker (${global.makerN} fill): ${fmt(global.makerPct, 4)}%`);
  console.log(`  └ taker (${global.takerN} fill): ${fmt(global.takerPct, 4)}%`);
  console.log(`  └ BNB ile ödenen (${global.bnbN} fill): basit ort. ${fmt(global.bnbAvg, 4)}%`);
  console.log(`Maker + BNB (${makersBnb.length} fill): ${fmt(makerBnbStats.weightedPct, 4)}% / bacak`);
  console.log(`→ Grid roundtrip tahmini (2× maker+BNB): ${fmt(makerBnbStats.weightedPct * 2, 4)}%`);
  console.log(`Bot config grid_fee_roundtrip_pct: 0.15%\n`);

  const bySym = new Map();
  for (const t of recent) {
    if (!bySym.has(t.symbol)) bySym.set(t.symbol, []);
    bySym.get(t.symbol).push(t);
  }
  const symRows = [...bySym.entries()]
    .map(([sym, ts]) => {
      const s = summarizeTrades(ts, bnbUsdt);
      return { sym, n: ts.length, ...s };
    })
    .sort((a, b) => b.sumQuote - a.sumQuote);

  console.log('Sembol bazlı (son global pencerede):');
  console.log('symbol       | fills | hacim USDT | fee USDT | w.avg % | maker % | BNB fills');
  console.log('-'.repeat(72));
  for (const r of symRows.slice(0, 20)) {
    const bnbFills = recent.filter((t) => t.symbol === r.sym && t.commissionAsset === 'BNB').length;
    console.log(
      `${r.sym.padEnd(12)} | ${String(r.n).padStart(5)} | ${fmt(r.sumQuote, 2).padStart(10)} | ${fmt(r.sumFee, 4).padStart(8)} | ${fmt(r.weightedPct, 3).padStart(7)}% | ${fmt(r.makerPct, 3).padStart(7)}% | ${bnbFills}`,
    );
  }
  if (symRows.length > 20) console.log(`… +${symRows.length - 20} sembol daha`);

  console.log('\n─ Son işlemler (global, en yeni altta) ─');
  console.log('time (UTC)           | symbol       | side | mk | quote   | comm asset | fee%');
  console.log('-'.repeat(78));
  for (const t of recent.slice(-25)) {
    const quote = Number(t.quoteQty);
    const feeUsdt = commissionToUsdt(t, bnbUsdt);
    const feePct = quote > 0 ? (feeUsdt / quote) * 100 : 0;
    const dt = new Date(t.time).toISOString().replace('T', ' ').slice(0, 19);
    const side = t.isBuyer ? 'BUY' : 'SEL';
    const mk = t.isMaker ? 'Y' : 'N';
    console.log(
      `${dt} | ${t.symbol.padEnd(12)} | ${side}  | ${mk}  | ${fmt(quote, 2).padStart(7)} | ${fmt(t.commission, 6)} ${t.commissionAsset.padEnd(4)} | ${fmt(feePct, 3)}%`,
    );
  }
  console.log('');
}

async function main() {
  if (!API_KEY || !API_SECRET) {
    console.error('BINANCE_API_KEY/SECRET .dev.vars içinde yok.');
    process.exit(1);
  }

  const bnbUsdt = Number((await api('GET', '/api/v3/ticker/price', { symbol: 'BNBUSDT' })).price);

  if (ALL_MODE) {
    await runAll();
    return;
  }

  const raw = await api('GET', '/api/v3/myTrades', { symbol: SYMBOL, limit: PER_SYMBOL_LIMIT }, true);
  const trades = raw.sort((a, b) => a.time - b.time).slice(-PER_SYMBOL_LIMIT);
  printSingleSymbol(trades, SYMBOL, bnbUsdt);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
