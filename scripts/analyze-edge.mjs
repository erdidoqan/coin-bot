#!/usr/bin/env node
/**
 * Faz 1 — Kanıt madenciliği (analyze-edge)
 *
 * Mevcut canlı işlem verisinden yeni sinyali ve TP/SL'yi KANITA göre kalibre eder.
 * - TRADE_OUTCOME / POSITION_CLOSED: gerçekleşmiş pnl + MFE/MAE + giriş context.
 * - TICK_SHADOW_RESOLVED: girilmeyen adaylar dahil forward-60s yönü (daha az bias).
 *
 * Adımlar:
 *   1) Veri çıkarımı (remote D1, wrangler --json)
 *   2) Sinyal keşfi: feature kovaları -> win-rate (realized + shadow)
 *   3) TP/SL/maxHold grid sweep: kayıtlı MFE/MAE üzerinden net EV (fee dahil)
 *   4) Çıktı: docs/signal-spec.md + konsol özeti
 *
 * Çalıştırma:
 *   node scripts/analyze-edge.mjs
 *   FEE_ROUNDTRIP=0.15 node scripts/analyze-edge.mjs   # fee varsayımını değiştir
 *
 * Not: MFE/MAE kayıtları 1-dk reconcile'dan; kaba olabilir (spec'te uyarı var).
 */

import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DB = 'coin-bot-db';
const FEE_ROUNDTRIP = Number(process.env.FEE_ROUNDTRIP ?? '0.15'); // maker giriş + maker TP (BNB) ~%0.15
const STOP_FEE = Number(process.env.STOP_FEE ?? '0.075'); // market stop tek bacak taker

function d1(sql) {
  const cmd = `npx wrangler d1 execute ${DB} --remote --json --command ${JSON.stringify(sql)}`;
  const out = execSync(cmd, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' });
  const start = out.indexOf('[');
  const json = JSON.parse(out.slice(start));
  return json[0]?.results ?? [];
}

function num(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ---------- 1) Veri çıkarımı ----------

function loadTrades() {
  const rows = d1(
    "SELECT created_at, payload FROM trade_log WHERE event_type='TRADE_OUTCOME' ORDER BY id",
  );
  const trades = [];
  for (const r of rows) {
    let p;
    try {
      p = JSON.parse(r.payload);
    } catch {
      continue;
    }
    const e = p.entry ?? {};
    const pnl = num(p.pnl);
    if (pnl == null) continue;
    trades.push({
      closedAt: r.created_at,
      symbol: p.symbol,
      source: p.source ?? null,
      sector: e.sector ?? null,
      entryProfile: e.entryProfile ?? null,
      pnl,
      win: pnl > 0,
      exitPct: num(p.exit_pct_from_cost),
      mfe: num(p.max_favorable_pct), // peak'ten lehe %
      mae: num(p.max_adverse_pct), // trough'tan aleyhe % (negatif)
      // giriş özellikleri
      gainPct: num(e.gainPct),
      scoutVsFillPct: num(e.scoutVsFillPct),
      recoveryPct: num(e.recoveryFromWsLowPct),
      secSinceTrough: num(e.secSinceTrough),
      reversalScore: num(e.reversalScore),
      spreadPct: num(e.spreadPct),
      bidAskRatio: num(e.bidAskRatio),
      hour: r.created_at ? Number(r.created_at.slice(11, 13)) : null,
    });
  }
  return trades;
}

function loadShadow() {
  const rows = d1(
    "SELECT payload FROM trade_log WHERE event_type='TICK_SHADOW_RESOLVED' ORDER BY id",
  );
  const out = [];
  for (const r of rows) {
    let p;
    try {
      p = JSON.parse(r.payload);
    } catch {
      continue;
    }
    out.push({
      positive: p.forward60sPositive === true,
      forwardPct: num(p.forward60sPct),
      gainPct: num(p.gainPctAtSignal),
      recoveryPct: num(p.recoveryPctAtSignal),
      reversalScore: num(p.reversalScore),
    });
  }
  return out;
}

// ---------- 2) Feature kovaları ----------

function quantileBuckets(rows, key, nBuckets = 5) {
  const vals = rows.map((r) => r[key]).filter((v) => v != null).sort((a, b) => a - b);
  if (vals.length < nBuckets * 2) return null;
  const edges = [];
  for (let i = 1; i < nBuckets; i++) {
    edges.push(vals[Math.floor((i / nBuckets) * vals.length)]);
  }
  const buckets = Array.from({ length: nBuckets }, () => ({ n: 0, wins: 0, pnl: 0, lo: null, hi: null }));
  for (const r of rows) {
    const v = r[key];
    if (v == null) continue;
    let b = 0;
    while (b < edges.length && v >= edges[b]) b++;
    const bucket = buckets[b];
    bucket.n++;
    if (r.win) bucket.wins++;
    bucket.pnl += r.pnl;
    bucket.lo = bucket.lo == null ? v : Math.min(bucket.lo, v);
    bucket.hi = bucket.hi == null ? v : Math.max(bucket.hi, v);
  }
  return buckets.filter((b) => b.n > 0).map((b) => ({
    range: `${fmt(b.lo)}..${fmt(b.hi)}`,
    n: b.n,
    winRate: b.wins / b.n,
    avgPnl: b.pnl / b.n,
  }));
}

function shadowBuckets(rows, key, nBuckets = 5) {
  const vals = rows.map((r) => r[key]).filter((v) => v != null).sort((a, b) => a - b);
  if (vals.length < nBuckets * 2) return null;
  const edges = [];
  for (let i = 1; i < nBuckets; i++) edges.push(vals[Math.floor((i / nBuckets) * vals.length)]);
  const buckets = Array.from({ length: nBuckets }, () => ({ n: 0, pos: 0, lo: null, hi: null }));
  for (const r of rows) {
    const v = r[key];
    if (v == null) continue;
    let b = 0;
    while (b < edges.length && v >= edges[b]) b++;
    const bk = buckets[b];
    bk.n++;
    if (r.positive) bk.pos++;
    bk.lo = bk.lo == null ? v : Math.min(bk.lo, v);
    bk.hi = bk.hi == null ? v : Math.max(bk.hi, v);
  }
  return buckets.filter((b) => b.n > 0).map((b) => ({
    range: `${fmt(b.lo)}..${fmt(b.hi)}`,
    n: b.n,
    posRate: b.pos / b.n,
  }));
}

function categoryStats(rows, key) {
  const map = new Map();
  for (const r of rows) {
    const k = r[key] ?? '—';
    if (!map.has(k)) map.set(k, { n: 0, wins: 0, pnl: 0 });
    const m = map.get(k);
    m.n++;
    if (r.win) m.wins++;
    m.pnl += r.pnl;
  }
  return [...map.entries()]
    .map(([k, m]) => ({ key: k, n: m.n, winRate: m.wins / m.n, sumPnl: m.pnl }))
    .sort((a, b) => b.sumPnl - a.sumPnl);
}

// ---------- 3) TP/SL grid sweep (kayıtlı MFE/MAE) ----------

/**
 * Bir işlemi (TP, SL) altında simüle et. Ordering bilinmiyor -> stop-first konservatif:
 * MAE stop'u tetiklerse ÖNCE stop varsay (en kötü durum).
 * net = brüt sonuç - fee.
 */
function simulateTrade(t, tp, sl) {
  const mfe = t.mfe ?? 0;
  const mae = t.mae ?? 0; // negatif veya 0
  const stopHit = mae <= -sl;
  const tpHit = mfe >= tp;
  let gross;
  if (stopHit) gross = -sl - STOP_FEE - FEE_ROUNDTRIP / 2; // stop: maker giriş yarı + market stop fee
  else if (tpHit) gross = tp - FEE_ROUNDTRIP; // maker giriş + maker TP
  else {
    // timeout: kayıtlı çıkış %'sini proxy al (yoksa 0), maker varsay
    const mark = t.exitPct ?? 0;
    gross = mark - FEE_ROUNDTRIP;
  }
  return gross;
}

function sweep(trades) {
  const tps = [0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.8, 1.0];
  const sls = [0.2, 0.25, 0.3, 0.4, 0.5];
  const results = [];
  for (const tp of tps) {
    for (const sl of sls) {
      let sum = 0;
      let wins = 0;
      let n = 0;
      for (const t of trades) {
        if (t.mfe == null || t.mae == null) continue;
        const net = simulateTrade(t, tp, sl);
        sum += net;
        if (net > 0) wins++;
        n++;
      }
      if (n === 0) continue;
      results.push({ tp, sl, n, evPct: sum / n, winRate: wins / n, totalPct: sum });
    }
  }
  results.sort((a, b) => b.evPct - a.evPct);
  return results;
}

// ---------- yardımcı ----------

function fmt(v) {
  if (v == null) return '—';
  if (typeof v !== 'number') return String(v);
  return Number.isInteger(v) ? String(v) : v.toFixed(3);
}
function pct(v) {
  return v == null ? '—' : `${(v * 100).toFixed(1)}%`;
}

function mdTable(headers, rows) {
  const head = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${r.join(' | ')} |`).join('\n');
  return `${head}\n${sep}\n${body}`;
}

// ---------- main ----------

console.log('Veri çekiliyor (remote D1)...');
const trades = loadTrades();
const shadow = loadShadow();
console.log(`TRADE_OUTCOME: ${trades.length}, TICK_SHADOW_RESOLVED: ${shadow.length}`);

const wins = trades.filter((t) => t.win).length;
const overall = {
  n: trades.length,
  winRate: wins / trades.length,
  avgPnl: trades.reduce((s, t) => s + t.pnl, 0) / trades.length,
  avgWinExit: avg(trades.filter((t) => t.win).map((t) => t.exitPct)),
  avgLossExit: avg(trades.filter((t) => !t.win).map((t) => t.exitPct)),
  avgMfe: avg(trades.map((t) => t.mfe)),
  avgMae: avg(trades.map((t) => t.mae)),
};

function avg(arr) {
  const v = arr.filter((x) => x != null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

const NUMERIC_FEATURES = [
  'gainPct',
  'recoveryPct',
  'secSinceTrough',
  'reversalScore',
  'spreadPct',
  'bidAskRatio',
  'scoutVsFillPct',
  'hour',
];

const featureReport = {};
for (const f of NUMERIC_FEATURES) featureReport[f] = quantileBuckets(trades, f);

const shadowReport = {
  gainPct: shadowBuckets(shadow, 'gainPct'),
  recoveryPct: shadowBuckets(shadow, 'recoveryPct'),
  reversalScore: shadowBuckets(shadow, 'reversalScore'),
};

const sweepResults = sweep(trades);
const sourceStats = categoryStats(trades, 'source');
const sectorStats = categoryStats(trades, 'sector');
const profileStats = categoryStats(trades, 'entryProfile');

// ---------- konsol özeti ----------
console.log('\n=== GENEL ===');
console.log(
  `n=${overall.n} winRate=${pct(overall.winRate)} avgPnl=${fmt(overall.avgPnl)} USDT ` +
    `avgWinExit=${fmt(overall.avgWinExit)}% avgLossExit=${fmt(overall.avgLossExit)}% ` +
    `avgMFE=${fmt(overall.avgMfe)}% avgMAE=${fmt(overall.avgMae)}%`,
);
console.log('\n=== TP/SL SWEEP (top 8, net EV %/işlem, fee dahil) ===');
for (const r of sweepResults.slice(0, 8)) {
  console.log(
    `TP=${r.tp}% SL=${r.sl}% -> EV=${(r.evPct).toFixed(4)}%/işlem winRate=${pct(r.winRate)} n=${r.n}`,
  );
}

// ---------- docs/signal-spec.md ----------
const lines = [];
lines.push('# Sinyal Spesifikasyonu (Faz 1 — kanıt madenciliği çıktısı)');
lines.push('');
lines.push(`Üretim: \`scripts/analyze-edge.mjs\` · fee_roundtrip=%${FEE_ROUNDTRIP} (maker), stop_fee=%${STOP_FEE} (market).`);
lines.push('');
lines.push('## Genel (gerçekleşmiş tick_scalp işlemleri)');
lines.push('');
lines.push(
  mdTable(
    ['Metrik', 'Değer'],
    [
      ['İşlem', String(overall.n)],
      ['Win-rate', pct(overall.winRate)],
      ['Ort. PnL (USDT)', fmt(overall.avgPnl)],
      ['Ort. kazanç çıkış %', fmt(overall.avgWinExit)],
      ['Ort. kayıp çıkış %', fmt(overall.avgLossExit)],
      ['Ort. MFE %', fmt(overall.avgMfe)],
      ['Ort. MAE %', fmt(overall.avgMae)],
    ],
  ),
);
lines.push('');
lines.push('> Uyarı: MFE/MAE 1-dk reconcile excursion kayıtlarından; kaba/altörneklenmiş olabilir. Sweep birinci-derece tahmin.');
lines.push('');

lines.push('## TP/SL/EV grid sweep (kayıtlı MFE/MAE, stop-first konservatif)');
lines.push('');
lines.push(
  mdTable(
    ['TP %', 'SL %', 'net EV %/işlem', 'win-rate', 'n'],
    sweepResults.slice(0, 12).map((r) => [
      String(r.tp),
      String(r.sl),
      r.evPct.toFixed(4),
      pct(r.winRate),
      String(r.n),
    ]),
  ),
);
lines.push('');
const best = sweepResults[0];
lines.push(
  best
    ? `**En iyi (kayıtlı sweep):** TP=%${best.tp}, SL=%${best.sl} → net EV ${best.evPct.toFixed(4)}%/işlem, win-rate ${pct(best.winRate)}.`
    : '**Sweep boş** (yeterli MFE/MAE verisi yok).',
);
lines.push('');

lines.push('## Sinyal keşfi — feature kovaları (realized win-rate)');
lines.push('');
for (const f of NUMERIC_FEATURES) {
  const rep = featureReport[f];
  if (!rep) continue;
  lines.push(`### ${f}`);
  lines.push('');
  lines.push(
    mdTable(
      ['Aralık', 'n', 'win-rate', 'avg PnL'],
      rep.map((b) => [b.range, String(b.n), pct(b.winRate), fmt(b.avgPnl)]),
    ),
  );
  lines.push('');
}

lines.push('## Shadow çapraz-doğrulama (forward-60s pozitif oranı)');
lines.push('');
for (const [k, rep] of Object.entries(shadowReport)) {
  if (!rep) continue;
  lines.push(`### ${k} (shadow)`);
  lines.push('');
  lines.push(
    mdTable(
      ['Aralık', 'n', 'pozitif oranı'],
      rep.map((b) => [b.range, String(b.n), pct(b.posRate)]),
    ),
  );
  lines.push('');
}

lines.push('## Kategori kırılımları');
lines.push('');
lines.push('### Çıkış kaynağı');
lines.push('');
lines.push(
  mdTable(
    ['source', 'n', 'win-rate', 'toplam PnL'],
    sourceStats.map((s) => [String(s.key), String(s.n), pct(s.winRate), fmt(s.sumPnl)]),
  ),
);
lines.push('');
lines.push('### Profil');
lines.push('');
lines.push(
  mdTable(
    ['profil', 'n', 'win-rate', 'toplam PnL'],
    profileStats.map((s) => [String(s.key), String(s.n), pct(s.winRate), fmt(s.sumPnl)]),
  ),
);
lines.push('');
lines.push('### Sektör (top 12 / bottom 5 PnL)');
lines.push('');
lines.push(
  mdTable(
    ['sektör', 'n', 'win-rate', 'toplam PnL'],
    [...sectorStats.slice(0, 12), ...sectorStats.slice(-5)].map((s) => [
      String(s.key),
      String(s.n),
      pct(s.winRate),
      fmt(s.sumPnl),
    ]),
  ),
);
lines.push('');

lines.push('## Faz 3 için öneri (otomatik taslak — insan doğrulaması şart)');
lines.push('');
if (best) {
  lines.push(`- take_profit_pct ≈ %${best.tp}, stop_loss_pct ≈ %${best.sl} (sweep en iyi EV).`);
  lines.push(
    `- Net EV ${best.evPct.toFixed(4)}%/işlem ${best.evPct > 0 ? 'POZİTİF — devam' : 'NEGATİF — sinyali sıkılaştır / Spot Grid B-planı'}.`,
  );
}
lines.push('- Sinyal eşikleri: yukarıdaki kovalarda win-rate (ve shadow pozitif oranı) >%55 olan aralıkları AND ile birleştir.');
lines.push('- Overfit koruması: train/validation zaman ayrımı ile bu spec doğrulanmadan canlı açılmaz.');
lines.push('');

const outPath = resolve(ROOT, 'docs/signal-spec.md');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, lines.join('\n'));
console.log(`\nÇıktı: ${outPath}`);
