/**
 * Aday Uygunluk canlı monitörü.
 *
 * Botun /grid-candidates endpoint'ini (WS/DO verisiyle beslenen) periyodik yoklar
 * ve her aday için şu metrikleri 5 dk boyunca izler:
 *   Düşüş% (windowDropPct) · Skor · 3dk · 10dk · 30dk · 1s
 *
 * Kullanım: node scripts/candidates-monitor.mjs [toplamSaniye] [aralıkSaniye]
 */

const TOTAL_SEC = Number(process.argv[2] || 300);
const EVERY_SEC = Number(process.argv[3] || 30);
const SECRET = process.env.TRIGGER_SECRET || 'coin-bot-trigger-2026';
const URL = `https://coin.digitexa.com/admin/api/grid-candidates?secret=${SECRET}&live=1`;

const f = (n, d = 2) => (n == null || !Number.isFinite(Number(n)) ? '  -  ' : Number(n).toFixed(d));
const pad = (s, n) => String(s).padEnd(n);

/** symbol -> [{t, score, drop, m3, m10, m30, h1, ready, blocker}] */
const history = new Map();
let pollNo = 0;

async function poll() {
  pollNo++;
  const ts = new Date();
  let data;
  try {
    const res = await fetch(URL, { signal: AbortSignal.timeout(45_000) });
    if (!res.ok) {
      console.log(`[poll ${pollNo}] HTTP ${res.status}`);
      return;
    }
    data = await res.json();
  } catch (e) {
    console.log(`[poll ${pollNo}] hata: ${e.message}`);
    return;
  }

  const cands = (data.candidates || []).slice().sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const rs = data.regimeSummary || {};
  const elapsed = Math.round((Date.now() - START) / 1000);

  console.log(
    `\n===== poll ${pollNo} · t+${elapsed}s · ${ts.toLocaleTimeString('tr-TR')} · rejim=${rs.regime} breadth=${rs.breadthPct}% BTC24s=${f(rs.btc24hChangePct)}% savunma=${rs.defensiveActive} ready=${rs.readyCount}/${rs.candidateCount} =====`,
  );
  console.log(
    `${pad('SEMBOL', 12)} ${pad('R', 2)} ${pad('Skor', 6)} ${pad('Düşüş%', 7)} ${pad('3dk', 7)} ${pad('10dk', 7)} ${pad('30dk', 7)} ${pad('1s', 7)} blocker`,
  );
  for (const c of cands) {
    const row = {
      t: elapsed,
      score: c.score,
      drop: c.windowDropPct,
      m3: c.priceChangePct3m,
      m10: c.priceChangePct10m,
      m30: c.priceChangePct30m,
      h1: c.priceChangePct1h,
      ready: c.ready,
      blocker: c.primaryBlocker,
    };
    if (!history.has(c.symbol)) history.set(c.symbol, []);
    history.get(c.symbol).push(row);
    console.log(
      `${pad(c.symbol, 12)} ${pad(c.ready ? '✓' : '✗', 2)} ${pad(f(c.score, 0), 6)} ${pad(f(c.windowDropPct), 7)} ${pad(f(c.priceChangePct3m), 7)} ${pad(f(c.priceChangePct10m), 7)} ${pad(f(c.priceChangePct30m), 7)} ${pad(f(c.priceChangePct1h), 7)} ${c.primaryBlocker ?? ''}`,
    );
  }
}

function finalSummary() {
  console.log(`\n\n############ 5 DK ÖZET (başlangıç → son) ############`);
  console.log(
    `${pad('SEMBOL', 12)} ${pad('Skor Δ', 14)} ${pad('1s Δ', 14)} ${pad('Düşüş% son', 11)} trend(3dk son)`,
  );
  const rows = [];
  for (const [sym, h] of history) {
    if (h.length < 1) continue;
    const a = h[0];
    const b = h[h.length - 1];
    rows.push({ sym, a, b, dScore: (b.score ?? 0) - (a.score ?? 0) });
  }
  rows.sort((x, y) => (y.b.score ?? 0) - (x.b.score ?? 0));
  for (const { sym, a, b, dScore } of rows) {
    const arrow = dScore > 0.5 ? '↑' : dScore < -0.5 ? '↓' : '→';
    console.log(
      `${pad(sym, 12)} ${pad(`${f(a.score, 0)}→${f(b.score, 0)} ${arrow}`, 14)} ${pad(`${f(a.h1)}→${f(b.h1)}`, 14)} ${pad(f(b.drop), 11)} ${f(b.m3)}%`,
    );
  }
}

const START = Date.now();
console.log(`Aday Uygunluk monitörü başlıyor · ${TOTAL_SEC}s · her ${EVERY_SEC}s · ${URL.replace(SECRET, '***')}`);

await poll();
const timer = setInterval(async () => {
  if (Date.now() - START >= TOTAL_SEC * 1000) {
    clearInterval(timer);
    finalSummary();
    process.exit(0);
  }
  await poll();
}, EVERY_SEC * 1000);
