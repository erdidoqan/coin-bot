export { MarketDataDO } from './durable-objects/market-data-do';
import {
  runScheduled,
  runManualJob,
  parseManualJob,
  isTriggerAuthorized,
} from './trigger';
import { handleAdminApi, adminApiPreflight } from './admin/router';
import { handleTickFire, type TickFirePayload } from './jobs/tick-fire';

export default {
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    // Grid modunda scout/DO-WS çalışmaz; runScheduled içinde yönlendirilir.
    ctx.waitUntil(runScheduled(env, controller.cron));
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    const preflight = adminApiPreflight(request);
    if (preflight) return preflight;

    if (url.pathname.startsWith('/admin/api')) {
      return handleAdminApi(request, env);
    }

    if (url.pathname === '/internal/tick-fire') {
      if (request.method !== 'POST') {
        return Response.json({ error: 'POST only' }, { status: 405 });
      }
      if (!isTriggerAuthorized(request, env)) {
        return new Response('Unauthorized', { status: 401 });
      }
      let body: TickFirePayload;
      try {
        body = (await request.json()) as TickFirePayload;
      } catch {
        return Response.json({ error: 'invalid_json' }, { status: 400 });
      }
      return handleTickFire(env, body);
    }

    if (url.pathname === '/trigger') {
      if (request.method !== 'POST') {
        return Response.json(
          {
            error: 'POST only',
            jobs: ['scout', 'sniper', 'reconcile', 'tick', 'all'],
            hint: 'POST /trigger?job=scout  Header: X-Trigger-Secret: <TRIGGER_SECRET>',
          },
          { status: 405 },
        );
      }

      if (!isTriggerAuthorized(request, env)) {
        return new Response('Unauthorized — set TRIGGER_SECRET and send X-Trigger-Secret header', {
          status: 401,
        });
      }

      const job = parseManualJob(url.searchParams.get('job'));
      if (!job) {
        return Response.json(
          {
            error: 'Invalid job',
            valid: [
              'scout',
              'sniper',
              'reconcile',
              'tick',
              'grid',
              'grid-sweep',
              'dust-convert',
              'grid-recover-active',
              'dip-watch-refresh',
              'all',
            ],
          },
          { status: 400 },
        );
      }

      ctx.waitUntil(runManualJob(env, job));
      return Response.json({ ok: true, job, at: new Date().toISOString() });
    }

    if (url.pathname === '/' || url.pathname === '/admin' || url.pathname === '/admin/') {
      return Response.redirect(`${url.origin}/admin/`, 302);
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('coin-bot ok — https://coin.digitexa.com/admin', { status: 200 });
  },
};
