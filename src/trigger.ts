import { runScout } from './jobs/scout';
import { runSniper } from './jobs/sniper';
import { runReconcile } from './jobs/reconcile';
import { runTickScalpMaintenance } from './jobs/tick-scalp-sniper';
import { runGridMaintenance, recoverAllActiveGrids, forceRecenterGrid } from './jobs/grid-run';
import { runGridScout } from './jobs/grid-scout';
import { runGridSweep } from './jobs/grid-sweep';
import { runDustConvert } from './jobs/dust-convert';
import { getBotState } from './db/bot-state';
import { isTickScalpEnabled, getConfig } from './db/bot-config';
import { countOpenPositions } from './db/open-positions';

export type ManualJob =
  | 'scout'
  | 'sniper'
  | 'reconcile'
  | 'tick'
  | 'grid'
  | 'grid-scout'
  | 'grid-sweep'
  | 'dust-convert'
  | 'grid-recover-active'
  | 'grid-recenter'
  | 'all';

async function isGridEnabled(env: Env): Promise<boolean> {
  return (await getConfig(env.DB, 'grid_enabled', env)) === 'true';
}

/**
 * Cron yönlendirici. Grid modunda scout (watchlist + DO WS) ÇALIŞMAZ — grid tek
 * sembolle çalışır, watchlist/DO'ya ihtiyacı yok. Her iki cron da grid bakımına gider.
 */
export async function runScheduled(env: Env, cron: string): Promise<void> {
  if (await isGridEnabled(env)) {
    // 15-dk: aday seç + DO'ya ver (WS izleme). 1-dk: grid bakımı + readiness'li giriş.
    if (cron === '*/15 * * * *') {
      await runGridScout(env);
    } else {
      await runGridMaintenance(env);
    }
    return;
  }
  if (cron === '*/15 * * * *') {
    await runScout(env);
    return;
  }
  await runSniperOrReconcile(env);
}

export async function runSniperOrReconcile(env: Env): Promise<void> {
  // Grid modu aktifse tek yol: grid bakımı (kurulum + fill + trend koruması).
  if (await isGridEnabled(env)) {
    await runGridMaintenance(env);
    return;
  }
  const state = await getBotState(env.DB);
  const tickEnabled = await isTickScalpEnabled(env.DB, env);
  const tickOpenCount = tickEnabled
    ? await countOpenPositions(env.DB, { entryMode: 'tick_scalp' })
    : 0;

  if (tickEnabled && tickOpenCount > 0) {
    await runReconcile(env);
    await runTickScalpMaintenance(env);
    return;
  }

  if (state.status === 'IDLE') {
    if (tickEnabled) {
      await runTickScalpMaintenance(env);
      return;
    }
    await runSniper(env);
    return;
  }
  if (
    state.status === 'TIER_1_BULL' ||
    state.status === 'MANUAL_INTERVENTION' ||
    state.status === 'ERROR'
  ) {
    await runReconcile(env);
    if (tickEnabled) {
      await runTickScalpMaintenance(env);
    }
  }
}

/** Manuel tick koşusu: sadece tick sniper/reconcile akışı. */
export async function runManualTick(env: Env): Promise<void> {
  await runSniperOrReconcile(env);
}

export async function runManualJob(env: Env, job: ManualJob): Promise<void> {
  switch (job) {
    case 'scout':
      await runScout(env);
      break;
    case 'sniper':
      await runSniper(env);
      break;
    case 'reconcile':
      await runReconcile(env);
      break;
    case 'tick':
      await runManualTick(env);
      break;
    case 'grid':
      await runGridScout(env);
      await runGridMaintenance(env);
      break;
    case 'grid-scout':
      await runGridScout(env);
      break;
    case 'grid-sweep':
      await runGridSweep(env);
      break;
    case 'dust-convert':
      await runDustConvert(env);
      break;
    case 'grid-recover-active':
      await recoverAllActiveGrids(env);
      break;
    case 'grid-recenter': {
      const { getActiveGrids } = await import('./db/grid');
      const grids = await getActiveGrids(env.DB);
      for (const g of grids) {
        if (g.status === 'ACTIVE') {
          await forceRecenterGrid(env, { gridId: g.id });
        }
      }
      await runGridMaintenance(env);
      break;
    }
    case 'all':
      await runScout(env);
      await runSniperOrReconcile(env);
      break;
  }
}

export function parseManualJob(value: string | null): ManualJob | null {
  const jobs: ManualJob[] = [
    'scout',
    'sniper',
    'reconcile',
    'tick',
    'grid',
    'grid-scout',
    'grid-sweep',
    'dust-convert',
    'grid-recover-active',
    'grid-recenter',
    'all',
  ];
  return jobs.includes(value as ManualJob) ? (value as ManualJob) : null;
}

export function isTriggerAuthorized(request: Request, env: Env): boolean {
  const secret = env.TRIGGER_SECRET;
  if (!secret) return false;
  const header = request.headers.get('X-Trigger-Secret');
  const query = new URL(request.url).searchParams.get('secret');
  return header === secret || query === secret;
}
