import { getTradingConfig, getScalpConfig, isHybridEnabled } from '../db/bot-config';
import { getBotState } from '../db/bot-state';
import { listWatchlist } from '../db/watchlist';
import { logEvent } from '../db/trade-log';
import { TradingGateway } from '../exchange/gateway';
import { refreshWatchlistMomentumRankings } from './momentum-watchlist';
import { tryScalpEntry } from './scalp-entry';
import { runPullbackOnlySniper } from './sniper-pullback-only';

export async function runHybridSniper(env: Env): Promise<void> {
  const state = await getBotState(env.DB);
  if (state.status !== 'IDLE') return;

  const watchlist = await listWatchlist(env.DB);
  if (watchlist.length === 0) {
    await logEvent(env.DB, 'SNIPER_SKIP', { reason: 'empty_watchlist' });
    return;
  }

  const hybrid = await isHybridEnabled(env.DB, env);
  if (!hybrid) {
    await runPullbackOnlySniper(env);
    return;
  }

  const gateway = new TradingGateway(env);
  const trading = await getTradingConfig(env.DB, env);
  const scalp = await getScalpConfig(env.DB, env);

  const watchlistBySymbol = new Map(
    watchlist.map((entry, index) => [entry.symbol, { entry, index }]),
  );

  try {
    const ranked = await refreshWatchlistMomentumRankings(
      env,
      gateway,
      watchlist.map((w) => w.symbol),
    );

    const eligible = ranked.filter((r) => r.entryEligible);
    if (eligible.length === 0) {
      const top = ranked[0];
      await logEvent(env.DB, 'SNIPER_SKIP', {
        reason: 'no_entry_eligible',
        bestSymbol: top?.symbol ?? null,
        bestScorePct: top?.score.continuationScore ?? null,
        greenCount: top?.score.greenCount ?? 0,
      });
      return;
    }

    for (const r of eligible) {
      const row = watchlistBySymbol.get(r.symbol);
      if (!row) continue;

      await logEvent(env.DB, 'MOMENTUM_BEST_PICK', {
        symbol: r.symbol,
        rank: r.rank,
        scorePct: r.score.continuationScore,
        greenCount: r.score.greenCount,
        entryEligible: r.entryEligible,
        action: r.rank === eligible[0]!.rank ? 'scalp_try_best' : 'scalp_try_next',
      });

      const entered = await tryScalpEntry(env, row.entry, {
        gateway,
        quoteUsdt: trading.buyQuoteUsdt,
        scalp,
        entryIndex: row.index,
      });
      if (entered) return;
    }

    await logEvent(env.DB, 'SNIPER_SKIP', {
      reason: 'eligible_scalp_failed',
      tried: eligible.map((r) => r.symbol),
    });
  } catch (err) {
    await logEvent(env.DB, 'CRON_ERROR', {
      job: 'hybrid-sniper',
      message: err instanceof Error ? err.message : String(err),
    });
    console.error('hybrid-sniper error', err);
    throw err;
  }
}
