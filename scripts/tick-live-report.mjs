/**
 * Canlı DO /tick-rank + coin eşik simülasyonu (production admin API).
 * Kullanım: TRIGGER_SECRET=... node scripts/tick-live-report.mjs ZECUSDT
 */
const symbol = (process.argv[2] ?? 'ZECUSDT').toUpperCase();
const base = process.env.COIN_BOT_URL ?? 'https://coin.digitexa.com';
const secret = process.env.TRIGGER_SECRET;
if (!secret) {
  console.error('TRIGGER_SECRET gerekli (veya .dev.vars)');
  process.exit(1);
}

const url = `${base}/admin/api/tick-live?symbol=${encodeURIComponent(symbol)}`;
const res = await fetch(url, { headers: { 'X-Trigger-Secret': secret } });
const body = await res.json();
if (!res.ok) {
  console.error(res.status, body);
  process.exit(1);
}

console.log(`\n=== ${body.symbol} @ ${body.at} ===\n`);
console.log('DO:', body.do);
console.log('Config:', body.config);
console.log(`Rank: #${body.rank.position ?? '—'} / ${body.rank.total}  eligible=${body.eligible}  wouldFireWs=${body.wouldFireWs}`);
console.log('\nTop 5:');
for (const t of body.rank.top5) {
  console.log(`  ${t.symbol}  skor=${t.reversalScore.toFixed(2)}  pass=${t.pass}  rev=${t.reversalOk}`);
}
if (body.row) {
  console.log('\nRow:', {
    mid: body.row.mid,
    gainPct: body.row.gainPct,
    recoveryPct: body.row.recoveryFromWsLowPct,
    wsDeclinePct: body.row.wsDeclinePct,
    reversalScore: body.row.reversalScore,
    bidAskRatio: body.row.bidAskRatio,
    spreadPct: body.row.spreadPct,
    failReason: body.failReason,
  });
}
console.log('\nEşik simülasyonu:');
for (const g of body.gates) {
  const mark = g.pass ? '✓' : '✗';
  console.log(`  ${mark} ${g.label}: ${g.actual}  (hedef: ${g.threshold})${g.note ? ` — ${g.note}` : ''}`);
}
