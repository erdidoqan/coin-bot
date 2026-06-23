// Deploy sonrası: DO restart watchlist'i (in-memory symbols) sıfırlar; scout'u tetikleyip
// watchlist + DO'yu yeniden doldur (15dk cron'u beklemeden). DO restart deploy hemen
// sonrası tam oturmamış olabilir → DO doluluğunu DOĞRULA, boşsa RETRY (timing boşluğu önle).
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function triggerScout() {
  try {
    const res = await fetch(`${base}/trigger?job=scout`, {
      method: 'POST',
      headers: { 'X-Trigger-Secret': secret },
    });
    const body = await res.text();
    console.log(`post-deploy-scout: scout ${res.status} ${body}`);
    return res.ok;
  } catch (err) {
    console.warn(`post-deploy-scout: scout hatası — ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

async function doSymbolCount() {
  try {
    const res = await fetch(`${base}/admin/api/market-data?secret=${encodeURIComponent(secret)}`);
    if (!res.ok) return 0;
    const d = await res.json();
    return d?.status?.symbolCount ?? 0;
  } catch {
    return 0;
  }
}

// DO dolana kadar (symbolCount > 0) scout'u tekrar tetikle — max 4 deneme, 8sn arayla.
const MAX_TRIES = 4;
for (let i = 1; i <= MAX_TRIES; i++) {
  await triggerScout();
  await sleep(8000); // DO'nun WS kurup symbol işlemesi için bekle
  const count = await doSymbolCount();
  if (count > 0) {
    console.log(`post-deploy-scout: ✅ DO dolu (symbolCount=${count}, deneme ${i})`);
    process.exit(0);
  }
  console.log(`post-deploy-scout: DO hâlâ boş (deneme ${i}/${MAX_TRIES}), tekrar...`);
}
console.warn('post-deploy-scout: ⚠️ DO MAX_TRIES sonrası boş — 15dk scout cron dolduracak');
