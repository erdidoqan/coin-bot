import { BinanceClient } from '../exchange/binance';
import { pickTopWatchlist, pickMicroUniverse, pickTickWatchlist } from '../config/filters';
import { sectorTagForSymbol } from '../config/sector-map';
import {
  getConfig,
  getWatchlistSize,
  isHybridEnabled,
  isMicroScalpEnabled,
  isTickScalpEnabled,
  getMicroScalpConfig,
  getTickScalpConfig,
  getScoutTickConfig,
} from '../db/bot-config';
import { replaceWatchlist, listWatchlist } from '../db/watchlist';
import { logEvent } from '../db/trade-log';
import { TradingGateway } from '../exchange/gateway';
import { refreshWatchlistMomentumRankings } from './momentum-watchlist';
import { isLate15mPump } from '../indicators/pump-filter';
import {
  ensureMarketDataWatchlist,
  fetchTickersFromDo,
} from '../exchange/market-data-client';
import { buildTickMarketDataSync } from './tick-config-sync';
import { buildMicroScalpScoreConfig } from '../indicators/micro-scalp';
import { filterScoutBy1hPeak } from './scout-1h-peak';
import {
  isSystemTradeBlockedSymbol,
  listSystemTradeBlockedSymbols,
} from '../config/system-trade-rules';

export async function runScout(env: Env): Promise<void> {
  try {
    const stableMaxVolatilityPct = await getConfig(env.DB, 'stable_max_volatility_pct', env);
    const tickEnabled = await isTickScalpEnabled(env.DB, env);
    const microScalpEnabled = await isMicroScalpEnabled(env.DB, env);
    const microEnabled = microScalpEnabled || tickEnabled;
    const client = new BinanceClient(env);

    let tickers = await fetchTickersFromDo(env);
    if (!tickers || tickers.length < 500) {
      tickers = await client.getTicker24hr();
    }
    const systemBlockedSymbols = listSystemTradeBlockedSymbols();
    const tradableTickers = tickers.filter((t) => !isSystemTradeBlockedSymbol(t.symbol));
    const systemBlockedCount = tickers.length - tradableTickers.length;

    let kept: Array<{ symbol: string; lastPrice: string; quoteVolume?: string; priceChangePercent?: string }> = [];
    let filteredCount = 0;
    let skippedSamples: Array<{ symbol: string; reason: string }> = [];
    let watchlistSize = await getWatchlistSize(env.DB, env);
    let scoutMode: 'micro' | 'tick' | 'hybrid' = 'hybrid';

    if (microScalpEnabled) {
      scoutMode = 'micro';
      const micro = await getMicroScalpConfig(env.DB, env);
      watchlistSize = micro.universeSize;
      const picked = pickMicroUniverse(
        tradableTickers,
        new Map(),
        {
          stableMaxVolatilityPct,
          minQuoteVolumeUsdt: micro.minQuoteVolumeUsdt,
          maxSpreadPct: micro.maxSpreadPct,
          maxSkippedSamples: 8,
        },
        watchlistSize,
      );
      filteredCount = picked.filteredCount;
      skippedSamples = picked.skippedSamples;
      kept = picked.top;
    } else if (tickEnabled) {
      scoutMode = 'tick';
      const tickMajorOnly = (await getConfig(env.DB, 'tick_major_only', env)) !== 'false';
      const tickMajorSymbolsRaw = await getConfig(env.DB, 'tick_major_symbols', env);
      const tickMajorSymbols = parseTickMajorSymbols(tickMajorSymbolsRaw);
      const sourceTickers =
        tickMajorOnly && tickMajorSymbols.length > 0
          ? tradableTickers.filter((t) => tickMajorSymbols.includes(t.symbol))
          : tradableTickers;
      if (tickMajorOnly && tickMajorSymbols.length > 0) {
        watchlistSize = Math.min(watchlistSize, tickMajorSymbols.length);
      }
      const picked = pickTickWatchlist(
        sourceTickers,
        { stableMaxVolatilityPct, maxSkippedSamples: 8 },
        watchlistSize,
      );
      filteredCount = picked.filteredCount;
      skippedSamples = picked.skippedSamples;
      kept = picked.top;
    } else {
      const picked = pickTopWatchlist(
        tradableTickers,
        { stableMaxVolatilityPct, maxSkippedSamples: 8 },
        watchlistSize,
      );
      filteredCount = picked.filteredCount;
      skippedSamples = picked.skippedSamples;
      kept = picked.top;
    }

    const max15mPumpPct = await getConfig(env.DB, 'scout_max_15m_pump_pct', env);
    const pumpFiltered: Array<{ symbol: string; gain15mPct: string }> = [];
    let afterPump: typeof kept = [];

    for (const t of kept) {
      const { pumped, gainPct } = await isLate15mPump(client, t.symbol, max15mPumpPct, env);
      if (pumped && gainPct) {
        pumpFiltered.push({ symbol: t.symbol, gain15mPct: gainPct });
        continue;
      }
      afterPump.push(t);
    }

    let peakFiltered: Array<{ symbol: string; peak1hPct: string | null; reason: string }> = [];
    let finalKept = afterPump;
    let scoutMin1hPeakPct: string | null = null;

    if (tickEnabled) {
      const scoutTick = await getScoutTickConfig(env.DB, env);
      if (scoutTick.require1hPeak) {
        scoutMin1hPeakPct = scoutTick.min1hPeakPct;
        const peakResult = await filterScoutBy1hPeak(client, afterPump, scoutTick.min1hPeakPct);
        finalKept = peakResult.kept;
        peakFiltered = peakResult.peakFiltered;
      }
    }

    const currentWatchlist = await listWatchlist(env.DB);
    const currentSymbols = currentWatchlist.map((w) => w.symbol);
    const nextBySymbol = new Map(finalKept.map((t) => [t.symbol, t]));
    const sameSymbolSet =
      currentSymbols.length === nextBySymbol.size &&
      currentSymbols.every((sym) => nextBySymbol.has(sym));

    let normalizedKept = finalKept;
    if (sameSymbolSet) {
      normalizedKept = currentSymbols
        .map((sym) => nextBySymbol.get(sym))
        .filter(
          (row): row is { symbol: string; lastPrice: string; quoteVolume?: string; priceChangePercent?: string } =>
            row != null,
        );

      const refreshStatements = normalizedKept.map((t) =>
        env.DB
          .prepare('UPDATE watchlist SET price_at_addition = ?, sector_tag = ? WHERE symbol = ?')
          .bind(t.lastPrice, sectorTagForSymbol(t.symbol), t.symbol),
      );
      if (refreshStatements.length > 0) {
        await env.DB.batch(refreshStatements);
      }
    } else {
      const currentOrder = new Map(currentSymbols.map((sym, idx) => [sym, idx]));
      normalizedKept = [...finalKept].sort((a, b) => {
        const ai = currentOrder.get(a.symbol);
        const bi = currentOrder.get(b.symbol);
        if (ai != null && bi != null) return ai - bi;
        if (ai != null) return -1;
        if (bi != null) return 1;
        return 0;
      });

      await replaceWatchlist(
        env.DB,
        normalizedKept.map((t) => ({
          symbol: t.symbol,
          price_at_addition: t.lastPrice,
          sector_tag: sectorTagForSymbol(t.symbol),
        })),
      );
    }

    await logEvent(env.DB, 'SCOUT_RUN', {
      candidateCount: tickers.length,
      tradableCandidateCount: tradableTickers.length,
      systemBlockedCount,
      systemBlockedSymbols,
      filteredCount,
      skippedSamples,
      watchlistSize,
      stableMaxVolatilityPct,
      scoutMax15mPumpPct: max15mPumpPct,
      microEnabled,
      scoutMode,
      dataSource: env.MARKET_DATA ? 'ws_do' : 'rest',
      pumpFiltered,
      peakFiltered,
      scoutMin1hPeakPct,
      watchlistReplaced: !sameSymbolSet,
      selected: normalizedKept.map((t) => ({
        symbol: t.symbol,
        quoteVolume: t.quoteVolume,
        priceChangePercent: t.priceChangePercent,
        lastPrice: t.lastPrice,
        sector: sectorTagForSymbol(t.symbol),
      })),
    });

    if (microEnabled) {
      const symbols = normalizedKept.map((t) => t.symbol);
      if (tickEnabled) {
        const tick = await getTickScalpConfig(env.DB, env);
        await ensureMarketDataWatchlist(env, symbols, buildTickMarketDataSync(tick));
      } else {
        const micro = await getMicroScalpConfig(env.DB, env);
        await ensureMarketDataWatchlist(env, symbols, buildMicroScalpScoreConfig(micro));
      }
    } else if (await isHybridEnabled(env.DB, env)) {
      try {
        const wl = await listWatchlist(env.DB);
        const gateway = new TradingGateway(env);
        await refreshWatchlistMomentumRankings(
          env,
          gateway,
          wl.map((w) => w.symbol),
        );
      } catch (momErr) {
        await logEvent(env.DB, 'MOMENTUM_SCAN_SKIP', {
          job: 'scout',
          message: momErr instanceof Error ? momErr.message : String(momErr),
        });
      }
    }
  } catch (err) {
    await logEvent(env.DB, 'CRON_ERROR', {
      job: 'scout',
      message: err instanceof Error ? err.message : String(err),
    });
    console.error('scout error', err);
    throw err;
  }
}

function parseTickMajorSymbols(raw: string): string[] {
  const parsed = raw
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.endsWith('USDT'));
  if (parsed.length > 0) return [...new Set(parsed)];
  return ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'];
}
