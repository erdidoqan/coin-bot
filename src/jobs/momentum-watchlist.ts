import {
  getMomentumConfig,
  getMomentumContinuationExtras,
  getConfig,
  setConfig,
} from '../db/bot-config';
import { listWatchlist, updateWatchlistMomentum } from '../db/watchlist';
import { logEvent } from '../db/trade-log';
import type { TradingGateway } from '../exchange/gateway';
import {
  checkMultiTfMomentum,
  rankMomentumResults,
  buildMomentumDetailPayload,
  parseMomentumDetailJson,
  computeMomentumScore,
  type BatchMomentumItem,
} from '../indicators/multi-tf-momentum';

/** Worker subrequest limiti: tur başına en fazla 5 sembol canlı kline. */
const MOMENTUM_BATCH_SIZE = 5;

export function watchlistToBatchItems(entries: Awaited<ReturnType<typeof listWatchlist>>): BatchMomentumItem[] {
  return entries.map((e) => {
    const parsed = parseMomentumDetailJson(e.momentum_detail);
    return {
      symbol: e.symbol,
      passed: parsed?.entryEligible ?? e.momentum_ok === 1,
      detail: {
        passed: parsed?.entryEligible ?? false,
        windows: parsed?.windows ?? [],
        dailyChangePct: parsed?.dailyChangePct ?? null,
        failReason: parsed?.failReason ?? null,
        continuationScore: parsed?.continuationScore ?? '0',
        avgRecoveryPct: parsed?.scorePct ?? '0',
        greenCount: parsed?.greenCount ?? 0,
        entryEligible: parsed?.entryEligible ?? false,
        continuationPassed: parsed?.continuationPassed ?? false,
      },
    };
  });
}

/**
 * Watchlist momentum: her turda bir dilim tara, tüm liste için cache’den sırala.
 */
export async function refreshWatchlistMomentumRankings(
  env: Env,
  gateway: TradingGateway,
  symbols: string[],
): Promise<ReturnType<typeof rankMomentumResults>> {
  const momentumConfig = await getMomentumConfig(env.DB, env);
  const continuationExtras = await getMomentumContinuationExtras(env.DB, env);
  const cursor = Number(await getConfig(env.DB, 'momentum_scan_cursor', env)) || 0;
  const batch: string[] = [];
  for (let i = 0; i < MOMENTUM_BATCH_SIZE && i < symbols.length; i++) {
    batch.push(symbols[(cursor + i) % symbols.length]!);
  }
  const nextCursor = symbols.length > 0 ? (cursor + MOMENTUM_BATCH_SIZE) % symbols.length : 0;

  const tickers = await gateway.binance.getTicker24hr();
  const tickerBySymbol = new Map(tickers.map((t) => [t.symbol, t]));

  for (const symbol of batch) {
    const detail = await checkMultiTfMomentum(
      gateway.binance,
      symbol,
      momentumConfig,
      continuationExtras,
      tickerBySymbol.get(symbol),
    );
    const score = computeMomentumScore(detail);
    await updateWatchlistMomentum(env.DB, [
      {
        symbol,
        momentum_ok: detail.entryEligible,
        momentum_detail: JSON.stringify({
          passed: detail.entryEligible,
          entryEligible: detail.entryEligible,
          continuationPassed: detail.continuationPassed,
          failReason: detail.failReason,
          dailyChangePct: detail.dailyChangePct,
          windows: detail.windows,
          scorePct: score.scorePct,
          avgRecoveryPct: detail.avgRecoveryPct,
          continuationScore: score.continuationScore,
          entryScore: score.continuationScore,
          passedCount: score.passedCount,
          greenCount: score.greenCount,
          totalWindows: score.totalWindows,
          minGainPct: score.minGainPct,
          maxGainPct: score.maxGainPct,
        }),
      },
    ]);
  }

  await setConfig(env.DB, 'momentum_scan_cursor', String(nextCursor));

  const entries = await listWatchlist(env.DB);
  const ranked = rankMomentumResults(watchlistToBatchItems(entries));

  await updateWatchlistMomentum(
    env.DB,
    ranked.map((r) => ({
      symbol: r.symbol,
      momentum_ok: r.entryEligible,
      momentum_detail: JSON.stringify(buildMomentumDetailPayload(r)),
    })),
  );

  await logEvent(env.DB, 'MOMENTUM_SCAN', {
    symbols,
    batchScanned: batch,
    scanCursor: cursor,
    nextCursor,
    rankings: ranked.map((r) => ({
      rank: r.rank,
      symbol: r.symbol,
      passed: r.entryEligible,
      entryEligible: r.entryEligible,
      scorePct: r.score.scorePct,
      entryScore: r.score.continuationScore,
      greenCount: r.score.greenCount,
      windows: r.detail.windows.map((w) => ({
        label: w.label,
        recoveryPct: w.recoveryPct ?? w.gainPct,
        pullbackPct: w.pullbackPct,
        passed: w.passed,
      })),
    })),
    best: ranked[0]
      ? {
          symbol: ranked[0].symbol,
          scorePct: ranked[0].score.continuationScore,
          passed: ranked[0].entryEligible,
          greenCount: ranked[0].score.greenCount,
        }
      : null,
  });

  for (const r of ranked) {
    if (r.entryEligible) {
      await logEvent(env.DB, 'MOMENTUM_PASS', {
        symbol: r.symbol,
        rank: r.rank,
        scorePct: r.score.scorePct,
      entryScore: r.score.continuationScore,
        greenCount: r.score.greenCount,
      });
    }
  }

  return ranked;
}
