import { getTradingConfig, getScalpConfig } from '../db/bot-config';
import { getBotState } from '../db/bot-state';
import { listWatchlist } from '../db/watchlist';
import { logEvent } from '../db/trade-log';
import { TradingGateway } from '../exchange/gateway';
import { refreshWatchlistMomentumRankings } from './momentum-watchlist';
import { tryScalpEntry } from './scalp-entry';
import { bn } from '../math/decimal';

/** Hard-stop sonrası aynı coine yeniden giriş yasağı (dakika) — testere döngüsü koruması. */
const HARD_STOP_COOLDOWN_MIN = 30;

/** Coin son N dakikada hard-stop ile mi kapandı? (gir-stop-gir döngüsünü engeller) */
export async function isInHardStopCooldown(
  db: D1Database,
  symbol: string,
  minutes: number,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 FROM trade_log
       WHERE event_type = 'POSITION_CLOSED'
         AND payload LIKE ?1
         AND payload LIKE '%hard_stop%'
         AND created_at >= datetime('now', ?2)
       LIMIT 1`,
    )
    .bind(`%"symbol":"${symbol}"%`, `-${minutes} minutes`)
    .first();
  return row != null;
}

// Auto Strateji momentum girişi (router 'momentum' seçince çağrılır). Pullback fallback yok.
// solo: BTC genel trend desteklemese de tek güçlü coin'e küçük (yarı) pozisyonla giriş.
export async function runHybridSniper(
  env: Env,
  opts?: { forceMomentum?: boolean; solo?: boolean },
): Promise<void> {
  const state = await getBotState(env.DB);
  if (state.status !== 'IDLE') return;

  const watchlist = await listWatchlist(env.DB);
  if (watchlist.length === 0) {
    await logEvent(env.DB, 'SNIPER_SKIP', { reason: 'empty_watchlist' });
    return;
  }

  const gateway = new TradingGateway(env);
  const trading = await getTradingConfig(env.DB, env);
  const scalp = await getScalpConfig(env.DB, env);
  // Solo modda BTC desteği yok → riski yarıya indir.
  const quoteUsdt = opts?.solo
    ? bn(trading.buyQuoteUsdt).times('0.5').toString()
    : trading.buyQuoteUsdt;

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

      // Testere koruması: hard-stop yiyen coine cooldown süresince tekrar girme
      // (PEPE gibi yönsüz/volatil coinlerde gir-stop-gir döngüsünü kırar).
      if (await isInHardStopCooldown(env.DB, r.symbol, HARD_STOP_COOLDOWN_MIN)) {
        await logEvent(env.DB, 'COOLDOWN_SKIP', {
          symbol: r.symbol,
          reason: 'recent_hard_stop',
          cooldownMin: HARD_STOP_COOLDOWN_MIN,
        });
        continue;
      }

      await logEvent(env.DB, 'MOMENTUM_BEST_PICK', {
        symbol: r.symbol,
        rank: r.rank,
        scorePct: r.score.continuationScore,
        greenCount: r.score.greenCount,
        entryEligible: r.entryEligible,
        solo: opts?.solo === true,
        quoteUsdt,
        action: r.rank === eligible[0]!.rank ? 'scalp_try_best' : 'scalp_try_next',
      });

      const entered = await tryScalpEntry(env, row.entry, {
        gateway,
        quoteUsdt,
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
