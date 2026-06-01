/**
 * Acil: açık emirleri iptal + serbest BNB market sat.
 * .dev.vars içindeki BINANCE_API_KEY/SECRET kullanır.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const varsPath = path.join(ROOT, '..', '.dev.vars');
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
const BASE = 'https://api.binance.com';
const SYMBOL = 'BNBUSDT';

function sign(query) {
  return crypto.createHmac('sha256', API_SECRET).update(query).digest('hex');
}

async function api(method, pathname, params = {}) {
  const ts = Date.now();
  const q = new URLSearchParams({
    ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
    timestamp: String(ts),
    recvWindow: '5000',
  });
  const sig = sign(q.toString());
  const url = `${BASE}${pathname}?${q}&signature=${sig}`;
  const res = await fetch(url, {
    method,
    headers: { 'X-MBX-APIKEY': API_KEY },
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(text.slice(0, 300));
  }
  if (!res.ok || (data.code && data.code < 0)) {
    throw new Error(data.msg ?? text);
  }
  return data;
}

async function main() {
  console.log('Hesap BNB bakiyesi...');
  const account = await api('GET', '/api/v3/account');
  const bnb = account.balances.find((b) => b.asset === 'BNB');
  console.log('BNB free:', bnb?.free, 'locked:', bnb?.locked);

  console.log('\nAçık emirler...');
  const open = await api('GET', '/api/v3/openOrders', { symbol: SYMBOL });
  console.log(open.length ? open : '(yok)');
  for (const o of open) {
    console.log(`  İptal: ${o.orderId} ${o.type} ${o.status}`);
    await api('DELETE', '/api/v3/order', { symbol: SYMBOL, orderId: o.orderId });
  }

  const account2 = await api('GET', '/api/v3/account');
  const bnb2 = account2.balances.find((b) => b.asset === 'BNB');
  const free = Number(bnb2?.free ?? 0);
  console.log('\nİptal sonrası free:', bnb2?.free);

  const infoRes = await fetch(`${BASE}/api/v3/exchangeInfo?symbol=${SYMBOL}`);
  const info = await infoRes.json();
  const sym = info.symbols[0];
  const lot = sym.filters.find((f) => f.filterType === 'LOT_SIZE');
  const step = Number(lot.stepSize);
  const minQty = Number(lot.minQty);
  const sellQty = (Math.floor(free / step) * step).toFixed(
    (String(step).split('.')[1] ?? '').length,
  );
  console.log('Satış miktarı:', sellQty, 'minQty:', minQty);

  if (Number(sellQty) < minQty) {
    console.log('Miktar minQty altında — manuel kontrol gerekir.');
    return;
  }

  console.log('\nMarket SELL...');
  const sell = await api('POST', '/api/v3/order', {
    symbol: SYMBOL,
    side: 'SELL',
    type: 'MARKET',
    quantity: sellQty,
  });
  console.log('Satış:', sell.status, 'proceeds quote:', sell.cummulativeQuoteQty);

  const account3 = await api('GET', '/api/v3/account');
  const bnb3 = account3.balances.find((b) => b.asset === 'BNB');
  console.log('\nSon BNB free:', bnb3?.free, 'locked:', bnb3?.locked);
}

main().catch((e) => {
  console.error('HATA:', e.message);
  process.exit(1);
});
