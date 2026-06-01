#!/usr/bin/env node
/**
 * Grid kurulum anında fiyat aralık içinde nerede? (anchor vs lower/upper)
 * wrangler d1 execute ... --remote --json
 */
import { execSync } from 'node:child_process';
import path from 'node:path';

const REPO = path.join(import.meta.dirname, '..');

function d1(sql) {
  const raw = execSync(
    `wrangler d1 execute coin-bot-db --remote --json --command ${JSON.stringify(sql)}`,
    { cwd: REPO, encoding: 'utf8' },
  );
  return JSON.parse(raw)[0].results;
}

const rows = d1(
  `SELECT id, symbol, lower_price, upper_price, anchor_price, created_at FROM grid_state WHERE anchor_price IS NOT NULL AND CAST(lower_price AS REAL) > 0 ORDER BY id`,
);

console.log('\n=== Grid kurulum: fiyatın aralık içindeki konumu (anchor) ===\n');
console.log('id  | symbol       | konum % | bant        | 24s getiri*');
console.log('-'.repeat(62));

const bands = { ust: 0, ortaUst: 0, orta: 0, alt: 0 };
const positions = [];

for (const r of rows) {
  const l = Number(r.lower_price);
  const u = Number(r.upper_price);
  const a = Number(r.anchor_price);
  const pct = ((a - l) / (u - l)) * 100;
  positions.push(pct);
  let band = 'alt';
  if (pct >= 70) {
    band = 'ust (yükseliş bandı)';
    bands.ust++;
  } else if (pct >= 50) {
    band = 'orta-ust';
    bands.ortaUst++;
  } else if (pct >= 30) {
    band = 'orta';
    bands.orta++;
  } else {
    bands.alt++;
  }
  const rangePct = ((u - l) / ((u + l) / 2)) * 100;
  console.log(
    `${String(r.id).padStart(3)} | ${r.symbol.padEnd(12)} | ${pct.toFixed(0).padStart(6)}% | ${band.padEnd(11)} | aralık ~${rangePct.toFixed(1)}%`,
  );
}

const avg = positions.reduce((s, x) => s + x, 0) / positions.length;
console.log('\n--- Özet ---');
console.log(`Grid sayısı: ${rows.length}`);
console.log(`Ortalama konum: %${avg.toFixed(0)} (50 = tam orta)`);
console.log(`Üst bant (≥70%): ${bands.ust} (${((bands.ust / rows.length) * 100).toFixed(0)}%)`);
console.log(`Orta-üst+ (≥50%): ${bands.ust + bands.ortaUst} (${(((bands.ust + bands.ortaUst) / rows.length) * 100).toFixed(0)}%)`);
console.log(`Alt bant (≤30%): ${bands.alt} (${((bands.alt / rows.length) * 100).toFixed(0)}%)`);

const setups = d1(
  `SELECT payload FROM trade_log WHERE event_type='GRID_SETUP' ORDER BY id DESC LIMIT 40`,
);

console.log('\n=== Son GRID_SETUP logları (spacing) ===\n');
for (const s of setups.slice(0, 15)) {
  try {
    const p = JSON.parse(s.payload);
    console.log(
      `${p.symbol?.padEnd(12) ?? '?'} grid ${p.gridId} spacing %${Number(p.spacingPct).toFixed(2)} buys ${p.buysPlaced}`,
    );
  } catch {
    /* skip */
  }
}

console.log(`
=== Yorum (kod mantığı) ===
• Aralık: son ~7 gün kapanışların p8–p92 bandı (grid_range_pctl=8).
• Giriş şartı: fiyat bu bandın İÇİNDE (price_in_range) — üst, alt veya orta olabilir.
• "Aşağı momentum" kapısı VAR; "yukarı momentum" kapısı YOK.
• Scout: 24s |değişim| > %12 olanlar elenir (aşırı pump/dump).
• Düşük ER (ranging) istenir — güçlü tek yönlü yükselişte çoğu zaman GİRİLMEZ.
• Kurulumda alışlar fiyatın ALTINA konur; fiyat üstteyse az alış seviyesi (normal).
`);
