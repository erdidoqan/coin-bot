#!/usr/bin/env node
/**
 * Reposition sonrası kaçırılan alım analizi: iptal edilen limit fiyatına
 * mum low değdi mi, yeni emir daha yüksekte mi kaldı?
 */
import { execSync } from 'node:child_process';
import path from 'node:path';

const REPO = path.join(import.meta.dirname, '..');
const BASE = 'https://api.binance.com';
const START_MS = Date.parse('2026-05-31T17:00:00Z');

function d1(sql) {
  const raw = execSync(
    `wrangler d1 execute coin-bot-db --remote --json --command ${JSON.stringify(sql)}`,
    { cwd: REPO, encoding: 'utf8' },
  );
  return JSON.parse(raw)[0].results;
}

async function klines(symbol, startMs) {
  const out = [];
  let end = Date.now();
  while (true) {
    const url = `${BASE}/api/v3/klines?symbol=${symbol}&interval=1m&limit=1000&endTime=${end}`;
    const rows = await fetch(url).then((r) => r.json());
    if (!rows.length) break;
    for (const r of rows) {
      if (r[0] >= startMs) {
        out.unshift({ t: r[0], low: +r[3], high: +r[2], close: +r[4] });
      }
    }
    end = rows[0][0] - 1;
    if (rows[0][0] < startMs) break;
  }
  return out;
}

function levels(lower, upper, n) {
  const step = (upper - lower) / n;
  return Array.from({ length: n + 1 }, (_, i) => lower + i * step);
}

function analyzeSymbol(symbol, gridId, lower, upper, gridCount) {
  const lv = levels(lower, upper, gridCount);
  const orders = d1(
    `SELECT side, level_index, price, status, created_at, updated_at FROM grid_orders WHERE grid_id=${gridId} ORDER BY id`,
  );
  const repos = d1(
    `SELECT payload, created_at FROM trade_log WHERE event_type='GRID_BUY_LADDER_REPOSITION' AND payload LIKE '%"gridId":${gridId}%' ORDER BY id`,
  );

  return { symbol, gridId, lv, orders, repos };
}

async function main() {
  const ondo = analyzeSymbol('ONDOUSDT', 183, 0.34535, 0.36785, 10);
  const meme = analyzeSymbol('MEMEUSDT', 184, 0.0005565, 0.0006255, 10);

  for (const g of [ondo, meme]) {
    const kl = await klines(g.symbol, START_MS);
    const minLow = Math.min(...kl.map((k) => k.low));
    const maxHigh = Math.max(...kl.map((k) => k.high));

    console.log(`\n${'='.repeat(60)}\n${g.symbol} grid #${g.gridId}\n${'='.repeat(60)}`);
    console.log(`1m mum (17:00+): min low ${minLow} | max high ${maxHigh}`);
    console.log(`Reposition sayısı: ${g.repos.length}`);

    const canceledBuys = g.orders.filter((o) => o.side === 'BUY' && o.status === 'CANCELED');
    const openBuys = g.orders.filter((o) => o.side === 'BUY' && o.status === 'OPEN');
    const filledBuys = g.orders.filter((o) => o.side === 'BUY' && o.status === 'FILLED');

    console.log(`İptal alış: ${canceledBuys.length} | Açık: ${openBuys.length} | Dolu: ${filledBuys.length}`);

    const canceledPrices = [...new Set(canceledBuys.map((o) => +o.price))].sort((a, b) => a - b);
    console.log(`İptal fiyat bandı: ${canceledPrices[0]?.toFixed(8)} – ${canceledPrices.at(-1)?.toFixed(8)}`);

    if (openBuys.length) {
      console.log(
        `Şu an açık: ${openBuys.map((o) => o.price).join(', ')} (seviye ${openBuys.map((o) => o.level_index).join(',')})`,
      );
    }

    // Kaçırılan: iptal fiyatına low değdi, ama o dakikada açık emir o fiyatta değildi
    let missCount = 0;
    const missSamples = [];

    for (const c of canceledBuys) {
      const cancelAt = Date.parse(c.updated_at.replace(' ', 'T') + 'Z');
      const price = +c.price;
      const touched = kl.filter((k) => k.t >= cancelAt - 120_000 && k.low <= price * 1.0001);
      if (touched.length === 0) continue;
      // Sonraki 5 dk içinde yeni emir bu fiyattan yüksek miydi?
      const afterRepos = g.repos.filter((r) => Date.parse(r.created_at.replace(' ', 'T') + 'Z') >= cancelAt);
      const nextOpenHigher = canceledBuys.some(
        (o) =>
          o.status === 'CANCELED' &&
          +o.price > price &&
          Date.parse(o.created_at.replace(' ', 'T') + 'Z') > cancelAt,
      );
      if (touched.length && nextOpenHigher) {
        missCount++;
        if (missSamples.length < 5) {
          missSamples.push({
            canceled: price,
            low: Math.min(...touched.map((k) => k.low)),
            at: new Date(touched[0].t).toISOString().slice(11, 16),
          });
        }
      }
    }

    // Daha net: her reposition'da iptal edilen min fiyat vs sonraki yeni min fiyat vs arada min low
    console.log('\nReposition pencereleri (iptal → yeni hedef):');
    for (const r of g.repos) {
      const p = JSON.parse(r.payload);
      const t = Date.parse(r.created_at.replace(' ', 'T') + 'Z');
      const targets = (p.targetLevels ?? []).map((i) => g.lv[i]?.toFixed(8) ?? '?');
      const windowKl = kl.filter((k) => k.t >= t - 60_000 && k.t <= t + 120_000);
      const wLow = windowKl.length ? Math.min(...windowKl.map((k) => k.low)) : null;
      console.log(
        `  ${r.created_at.slice(11, 16)} fiyat=${p.lastPrice} iptal=${p.buysCanceled} yeni=[${targets.join(',')}] 1m-low±2dk=${wLow ?? 'n/a'}`,
      );
    }

    // Dip emirler (0.3437 ONDO) — fiyat oraya indi mi?
    const deepest = Math.min(...canceledPrices);
    const hitDeepest = minLow <= deepest * 1.001;
    console.log(`\nEn dip iptal emir: ${deepest} | 17:00+ low bunun altına indi mi? ${hitDeepest ? 'EVET' : 'HAYIR'}`);

    if (g.symbol === 'ONDOUSDT') {
      const oldDip = 0.3437;
      console.log(`Eski dip (recenter öncesi ~0.3437): low<=0.3437? ${minLow <= oldDip ? 'EVET — kaçırılmış olabilir' : 'HAYIR'}`);
    }

    const currentOpens = openBuys.map((o) => +o.price);
    const missedVsNow = minLow < Math.min(...currentOpens) * 0.999;
    console.log(
      `Session low (${minLow}) şu anki açık alışların (${currentOpens.join('/')}) altına indi mi? ${missedVsNow ? 'EVET' : 'HAYIR'}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
