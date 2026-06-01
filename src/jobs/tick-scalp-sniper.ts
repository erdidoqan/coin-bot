import { getTickScalpConfig, isTickScalpEnabled } from '../db/bot-config';
import { listWatchlist } from '../db/watchlist';
import { logEvent } from '../db/trade-log';
import {
  ensureMarketDataWatchlist,
  fetchMarketDataStatus,
  fetchTickRank,
} from '../exchange/market-data-client';
import { buildTickGainSnapshot } from './tick-gain-snapshot';
import { runTickShadowResolve } from './tick-shadow-resolve';
import { buildTickMarketDataSync } from './tick-config-sync';

/** Dakikalık cron (tick modu): shadow çözümü + DO WS sağlık / rank özeti. Giriş DO WebSocket sniper. */
export async function runTickScalpMaintenance(env: Env): Promise<void> {
  await runTickShadowResolve(env);

  if (!(await isTickScalpEnabled(env.DB, env))) return;

  const tick = await getTickScalpConfig(env.DB, env);
  const watchlist = await listWatchlist(env.DB);

  if (watchlist.length === 0) {
    await logEvent(env.DB, 'TICK_WS_HEARTBEAT', {
      reason: 'empty_watchlist',
      mode: 'tick_scalp_ws',
    });
    return;
  }

  await ensureMarketDataWatchlist(
    env,
    watchlist.map((w) => w.symbol),
    buildTickMarketDataSync(tick),
  );

  const status = await fetchMarketDataStatus(env);
  const now = Date.now();
  const wsStale =
    !status?.lastMessageAt || now - status.lastMessageAt > 60_000;

  const rank = await fetchTickRank(env);
  if (rank?.rows?.length) {
    const watchSymbols = new Set(watchlist.map((w) => w.symbol));
    const snapshot = buildTickGainSnapshot(rank.rows, watchSymbols, tick);
    await logEvent(env.DB, 'TICK_GAIN_SNAPSHOT', { ...snapshot, source: 'ws_maintenance' });

    const top = [...rank.rows]
      .filter((r) => !r.stale)
      .sort((a, b) => b.reversalScore - a.reversalScore)
      .slice(0, 5);
    if (top.length > 0) {
      await logEvent(env.DB, 'TICK_REVERSAL_RANK', {
        source: 'ws_maintenance',
        top: top.map((r) => ({
          symbol: r.symbol,
          reversalScore: r.reversalScore,
          recoveryPct: r.recoveryFromWsLowPct,
          gainPct: r.gainPct,
          wsDeclinePct: r.wsDeclinePct,
          pass: r.pass,
          reversalOk: r.reversalOk,
          failReason: r.failReason ?? r.reversalFailReason,
        })),
      });
    }
  }

  await logEvent(env.DB, 'TICK_WS_HEARTBEAT', {
    mode: 'tick_scalp_ws',
    watchlistSize: watchlist.length,
    wsStale,
    lastMessageAt: status?.lastMessageAt ?? null,
    messageCount: status?.messageCount ?? null,
    symbolCount: status?.symbolCount ?? null,
    workerPublicUrl: Boolean(env.WORKER_PUBLIC_URL),
    marketDataBound: Boolean(env.MARKET_DATA),
  });
}
