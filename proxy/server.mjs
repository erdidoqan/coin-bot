/**
 * Binance forward proxy — sabit çıkış IP'li sunucuda çalıştırın.
 * Worker BINANCE_PROXY_URL ile buraya istek atar; bu process Binance'e iletir.
 *
 *   export PROXY_SECRET="uzun-rastgele-secret"
 *   export PORT=8788
 *   node proxy/server.mjs
 *
 * Binance API → Trusted IPs: bu sunucunun çıkış IP'si (curl -s ifconfig.me)
 */

import http from 'node:http';

const PORT = Number(process.env.PORT ?? 8788);
const HOST = process.env.HOST ?? '127.0.0.1';
const PROXY_SECRET = process.env.PROXY_SECRET ?? '';
const ALLOWED_PREFIX = (process.env.BINANCE_BASE_URL ?? 'https://api.binance.com').replace(/\/$/, '');

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method !== 'POST' || req.url !== '/forward') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    if (!PROXY_SECRET || req.headers['x-proxy-secret'] !== PROXY_SECRET) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const raw = await readBody(req);
    const body = JSON.parse(raw || '{}');
    const targetUrl = body.url;
    const method = body.method ?? 'GET';
    const headers = body.headers ?? {};

    if (typeof targetUrl !== 'string' || !targetUrl.startsWith(ALLOWED_PREFIX)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'url must start with ' + ALLOWED_PREFIX }));
      return;
    }

    const upstream = await fetch(targetUrl, { method, headers });
    const text = await upstream.text();
    res.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
    });
    res.end(text);
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`binance-proxy listening on ${HOST}:${PORT}`);
  console.log(`allow prefix: ${ALLOWED_PREFIX}`);
  if (!PROXY_SECRET) console.warn('WARN: PROXY_SECRET empty — set before production');
});
