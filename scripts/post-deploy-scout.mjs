// Deploy sonrası: DO restart watchlist'i (in-memory symbols) sıfırlar; scout'u hemen
// tetikleyip watchlist + DO'yu yeniden doldur (15dk cron'u beklemeden).
import { readFileSync } from 'node:fs';

function readEnv(key) {
  try {
    const txt = readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8');
    const m = txt.match(new RegExp(`^${key}=(.*)$`, 'm'));
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
  } catch {
    return null;
  }
}

const base = readEnv('WORKER_PUBLIC_URL') || 'https://coin.digitexa.com';
const secret = readEnv('TRIGGER_SECRET');
if (!secret) {
  console.warn('post-deploy-scout: TRIGGER_SECRET yok (.dev.vars), scout atlandı');
  process.exit(0);
}

try {
  const res = await fetch(`${base}/trigger?job=scout`, {
    method: 'POST',
    headers: { 'X-Trigger-Secret': secret },
  });
  const body = await res.text();
  console.log(`post-deploy-scout: ${res.status} ${body}`);
} catch (err) {
  console.warn(`post-deploy-scout: tetikleme hatası — ${err instanceof Error ? err.message : err}`);
}
