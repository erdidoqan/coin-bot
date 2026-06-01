import { getTradingConfig } from '../db/bot-config';
import { getBotState } from '../db/bot-state';
import { listWatchlist } from '../db/watchlist';
import { logEvent } from '../db/trade-log';
import { TradingGateway } from '../exchange/gateway';
import { tryPullbackEntry } from './pullback-entry';

/** hybrid_enabled=false iken yalnızca pullback girişi */
export async function runPullbackOnlySniper(env: Env): Promise<void> {
  const state = await getBotState(env.DB);
  if (state.status !== 'IDLE') return;

  const watchlist = await listWatchlist(env.DB);
  if (watchlist.length === 0) {
    await logEvent(env.DB, 'SNIPER_SKIP', { reason: 'empty_watchlist' });
    return;
  }

  const gateway = new TradingGateway(env);
  const trading = await getTradingConfig(env.DB, env);
  const cursor = state.watchlist_cursor ?? 0;

  try {
    for (let i = 0; i < watchlist.length; i++) {
      const entry = watchlist[(cursor + i) % watchlist.length]!;
      const entryIndex = (cursor + i) % watchlist.length;
      const entered = await tryPullbackEntry(env, entry, {
        gateway,
        quoteUsdt: trading.buyQuoteUsdt,
        pullbackTolerancePct: trading.pullbackTolerancePct,
        trailingActivationPct: trading.trailingActivationPct,
        trailingTightCallbackPct: trading.trailingTightCallbackPct,
        entryIndex,
      });
      if (entered) return;
    }
  } catch (err) {
    await logEvent(env.DB, 'CRON_ERROR', {
      job: 'sniper',
      message: err instanceof Error ? err.message : String(err),
    });
    console.error('sniper error', err);
    throw err;
  }
}
