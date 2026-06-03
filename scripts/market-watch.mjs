/**
 * Binance canlı piyasa gözlemcisi (WebSocket).
 *
 * !miniTicker@arr akışına bağlanır (saniyede bir tüm sembollerin 24s özeti).
 * USDT çiftlerini izler; BTC/ETH, piyasa genişliği (breadth), 24s ortalama değişim
 * ve İZLEME PENCERESİ içindeki kısa vadeli momentumu raporlar.
 *
 * Kullanım:  node scripts/market-watch.mjs [izlemeSaniye] [minQuoteVolUSDT]
 *   örn:     node scripts/market-watch.mjs 210 5000000
 */

const DURATION_SEC = Number(process.argv[2] || 210); // ~3.5 dk
const MIN_QUOTE_VOL = Number(process.argv[3] || 5_000_000); // likidite filtresi (24s USDT hacmi)
const SNAPSHOT_EVERY_MS = 30_000;
const WS_URL = 'wss://stream.binance.com:9443/ws/!miniTicker@arr';

/** symbol -> { open24h, last, h, l, q, firstSeenInWindow, firstTsInWindow } */
const state = new Map();
const startTs = Date.now();
let msgCount = 0;
let lastSnapshotTs = 0;

function pct(a, b) {
  if (!(b > 0)) return null;
  return ((a - b) / b) * 100;
}

function fmt(n, d = 2) {
  if (n == null || !Number.isFinite(n)) return 'n/a';
  return n.toFixed(d);
}

function usdtRows() {
  const rows = [];
  for (const [sym, s] of state) {
    if (!sym.endsWith('USDT')) continue;
    if (!(s.q >= MIN_QUOTE_VOL)) continue;
    rows.push({ sym, ...s });
  }
  return rows;
}

function snapshot(label) {
  const rows = usdtRows();
  if (rows.length === 0) {
    console.log(`[${label}] henüz yeterli veri yok...`);
    return;
  }

  let up = 0;
  let down = 0;
  let sum24h = 0;
  let sumWin = 0;
  let winCount = 0;
  for (const r of rows) {
    const ch24 = pct(r.last, r.open24h);
    if (ch24 != null) {
      sum24h += ch24;
      if (ch24 > 0) up++;
      else if (ch24 < 0) down++;
    }
    const chWin = pct(r.last, r.firstSeenInWindow);
    if (chWin != null) {
      sumWin += chWin;
      winCount++;
    }
  }

  const total = up + down;
  const breadth = total > 0 ? (up / total) * 100 : 0;

  const btc = state.get('BTCUSDT');
  const eth = state.get('ETHUSDT');
  const elapsed = ((Date.now() - startTs) / 1000).toFixed(0);

  console.log(`\n========== [${label}] t+${elapsed}s · ${rows.length} USDT çifti (hacim≥${(MIN_QUOTE_VOL / 1e6).toFixed(1)}M) ==========`);
  if (btc) {
    console.log(
      `BTC  $${fmt(btc.last, 2)}  | 24s ${fmt(pct(btc.last, btc.open24h))}%  | pencere ${fmt(pct(btc.last, btc.firstSeenInWindow))}%`,
    );
  }
  if (eth) {
    console.log(
      `ETH  $${fmt(eth.last, 2)}  | 24s ${fmt(pct(eth.last, eth.open24h))}%  | pencere ${fmt(pct(eth.last, eth.firstSeenInWindow))}%`,
    );
  }
  console.log(`Breadth (yükselen): ${fmt(breadth, 1)}%  (${up} ↑ / ${down} ↓)`);
  console.log(`Ortalama 24s değişim: ${fmt(sum24h / total)}%`);
  console.log(`Ortalama PENCERE değişim (${elapsed}s): ${fmt(winCount > 0 ? sumWin / winCount : null)}%`);

  // pencere içi en sert düşenler
  const winSorted = rows
    .map((r) => ({ sym: r.sym, chWin: pct(r.last, r.firstSeenInWindow), ch24: pct(r.last, r.open24h) }))
    .filter((r) => r.chWin != null)
    .sort((a, b) => a.chWin - b.chWin)
    .slice(0, 8);
  console.log('Pencere içi en sert düşenler:');
  for (const r of winSorted) {
    console.log(`   ${r.sym.padEnd(12)} pencere ${fmt(r.chWin)}%  (24s ${fmt(r.ch24)}%)`);
  }
}

console.log(`Binance WS'e bağlanılıyor... ${DURATION_SEC}s izlenecek (Ctrl+C ile çık).`);
const ws = new WebSocket(WS_URL);

ws.addEventListener('open', () => {
  console.log('Bağlandı. Veri akışı başladı.\n');
});

ws.addEventListener('message', (ev) => {
  msgCount++;
  let arr;
  try {
    arr = JSON.parse(ev.data);
  } catch {
    return;
  }
  if (!Array.isArray(arr)) return;
  const now = Date.now();
  for (const t of arr) {
    const sym = t.s;
    const last = Number(t.c);
    const open24h = Number(t.o);
    const q = Number(t.q);
    if (!sym || !(last > 0)) continue;
    const prev = state.get(sym);
    if (prev) {
      prev.last = last;
      prev.open24h = open24h;
      prev.h = Number(t.h);
      prev.l = Number(t.l);
      prev.q = q;
    } else {
      state.set(sym, {
        open24h,
        last,
        h: Number(t.h),
        l: Number(t.l),
        q,
        firstSeenInWindow: last,
        firstTsInWindow: now,
      });
    }
  }

  if (now - lastSnapshotTs >= SNAPSHOT_EVERY_MS) {
    lastSnapshotTs = now;
    snapshot('snapshot');
  }
});

ws.addEventListener('error', (e) => {
  console.error('WS hata:', e.message || e);
});

ws.addEventListener('close', () => {
  console.log('\nWS kapandı.');
});

setTimeout(() => {
  snapshot('FINAL ÖZET');
  console.log(`\nToplam ${msgCount} mesaj işlendi · ${state.size} sembol görüldü.`);
  ws.close();
  setTimeout(() => process.exit(0), 500);
}, DURATION_SEC * 1000);
