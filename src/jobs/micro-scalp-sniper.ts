import { getBotState } from '../db/bot-state';
import {
  getMicroScalpConfig,
  getTradingConfig,
  getScalpConfig,
  isMicroScalpEnabled,
} from '../db/bot-config';
import { listMicroScalpCandidates, listWatchlist } from '../db/watchlist';
import { logEvent } from '../db/trade-log';
import { getRegimeCache } from '../db/trade-features';
import { regimeAllowsEntry } from '../indicators/market-regime';
import { TradingGateway } from '../exchange/gateway';
import {
  ensureMarketDataWatchlist,
  fetchScoreFromDo,
} from '../exchange/market-data-client';
import { buildMicroScalpScoreConfig } from '../indicators/micro-scalp';
import { runMicroScalpScan } from './micro-scalp-scan';
import { runMicroShadowResolve } from './micro-shadow-resolve';
import { tryScalpEntry, type ScalpEntryContext } from './scalp-entry';

export async function runMicroScalpSniper(env: Env): Promise<void> {
  const state = await getBotState(env.DB);
  if (state.status !== 'IDLE') return;

  if (!(await isMicroScalpEnabled(env.DB, env))) return;

  const gateway = new TradingGateway(env);
  const micro = await getMicroScalpConfig(env.DB, env);
  const trading = await getTradingConfig(env.DB, env);
  const scalp = await getScalpConfig(env.DB, env);

  const watchlist = await listWatchlist(env.DB);
  await ensureMarketDataWatchlist(env, watchlist.map((w) => w.symbol), buildMicroScalpScoreConfig(micro));

  await runMicroScalpScan(env, gateway);
  await runMicroShadowResolve(env);

  const { regime } = await getRegimeCache(env.DB);
  const regimeGate = regimeAllowsEntry(
    regime as 'trend' | 'chop' | 'panic' | 'low_liquidity',
    micro.phase3Enabled,
  );
  if (!regimeGate.allowed) {
    await logEvent(env.DB, 'SNIPER_SKIP', {
      reason: 'regime_block',
      regime,
    });
    return;
  }

  let candidates = await listMicroScalpCandidates(env.DB);
  if (candidates.length === 0) {
    const top = [...watchlist].sort(
      (a, b) => Number(b.micro_score ?? 0) - Number(a.micro_score ?? 0),
    )[0];
    await logEvent(env.DB, 'SNIPER_SKIP', {
      reason: 'no_micro_eligible',
      bestSymbol: top?.symbol ?? null,
      bestScore: top?.micro_score ?? null,
    });
    return;
  }

  if (env.MARKET_DATA) {
    const withLive: typeof candidates = [];
    for (const c of candidates) {
      const live = await fetchScoreFromDo(env, c.symbol);
      if (live && Date.now() - live.updatedAt < 120_000) {
        if (live.pass) withLive.push(c);
        continue;
      }
      withLive.push(c);
    }
    if (withLive.length > 0) candidates = withLive;
  }

  const indexBySymbol = new Map(watchlist.map((e, i) => [e.symbol, i]));

  for (const entry of candidates) {
    const liveScore = env.MARKET_DATA ? await fetchScoreFromDo(env, entry.symbol) : null;
    await logEvent(env.DB, 'MICRO_BEST_PICK', {
      symbol: entry.symbol,
      score: liveScore?.score ?? entry.micro_score,
      doPass: liveScore?.pass ?? null,
      sector: entry.sector_tag,
      action: entry === candidates[0] ? 'scalp_try_best' : 'scalp_try_next',
    });

    const rowIndex = indexBySymbol.get(entry.symbol) ?? 0;
    const entered = await tryScalpEntry(env, entry, {
      gateway,
      quoteUsdt: trading.buyQuoteUsdt,
      scalp,
      entryIndex: rowIndex,
      regime,
    });
    if (entered) return;
  }

  await logEvent(env.DB, 'SNIPER_SKIP', {
    reason: 'eligible_scalp_failed',
    tried: candidates.map((c) => c.symbol),
  });
}
