/**
 * Grid scout (15-dk, grid modunda): likit USDT adaylarını seçer, watchlist'e yazar
 * ve MarketDataDO'ya verir → WebSocket ile canlı izleme. Grid girişi bu adaylar
 * arasından readiness (ranging) koşulu sağlananına yapılır (körü körüne değil).
 *
 * Ön filtre (scout risk): 24s |değişim| %, 24s aralık dar/geniş (min/max range_width),
 * kısa flash penceresi — readiness’te elenecek coinler watchlist’e yazılmaz.
 */
import { getGridConfig } from '../db/grid';
import { replaceWatchlist } from '../db/watchlist';
import { logEvent } from '../db/trade-log';
import { BinanceClient } from '../exchange/binance';
import { ensureMarketDataWatchlist } from '../exchange/market-data-client';
import { isSystemTradeBlockedSymbol } from '../config/system-trade-rules';
import {
  passesScoutFlashKlines,
  passesScoutHourDeclineKlines,
  passesScoutTickerRisk,
  scoutRiskConfigFromGrid,
  type ScoutRiskFilterConfig,
  type ScoutTickerRow,
} from '../strategy/grid-scout-filter';
import {
  resolveGridMarketDownturn,
  syncGridMarketDownturnObservability,
} from '../strategy/grid-market-downturn';

const STABLE_BASES = new Set([
  'USDC', 'FDUSD', 'TUSD', 'BUSD', 'DAI', 'USDP', 'EURI', 'AEUR', 'USD1', 'XUSD',
]);

/** Scout 5m kline: flash + 1s sürekli düşüş (12 bar) için yeterli tampon. */
const SCOUT_KLINE_LIMIT = 24;

async function filterScoutPool(
  client: BinanceClient,
  pool: ScoutTickerRow[],
  riskCfg: ScoutRiskFilterConfig,
): Promise<{ kept: string[]; rejected: Array<{ symbol: string; reason: string }> }> {
  const kept: string[] = [];
  const rejected: Array<{ symbol: string; reason: string }> = [];

  for (const t of pool) {
    const tick = passesScoutTickerRisk(t, riskCfg);
    if (!tick.pass) {
      rejected.push({ symbol: t.symbol, reason: tick.reason ?? 'ticker' });
      continue;
    }

    const needKlines =
      riskCfg.enabled &&
      (riskCfg.flashEnabled || (riskCfg.hourDeclineEnabled && (riskCfg.hourDeclineBars ?? 0) >= 2));
    if (needKlines) {
      try {
        const raw = await client.getKlines(t.symbol, '5m', SCOUT_KLINE_LIMIT);
        const closes = raw.map((k) => Number(k.close)).filter((c) => c > 0);
        const last = t.lastPrice > 0 ? t.lastPrice : (closes.at(-1) ?? 0);
        if (closes.length < 5 || !(last > 0)) {
          rejected.push({ symbol: t.symbol, reason: 'no_klines' });
          continue;
        }
        const hour = passesScoutHourDeclineKlines(closes, riskCfg);
        if (!hour.pass) {
          rejected.push({ symbol: t.symbol, reason: hour.reason ?? 'hour_decline' });
          continue;
        }
        const flash = passesScoutFlashKlines(closes, last, riskCfg);
        if (!flash.pass) {
          rejected.push({ symbol: t.symbol, reason: flash.reason ?? 'flash' });
          continue;
        }
      } catch {
        rejected.push({ symbol: t.symbol, reason: 'kline_error' });
        continue;
      }
    }

    kept.push(t.symbol);
  }

  return { kept, rejected };
}

export async function runGridScout(env: Env): Promise<void> {
  const cfg = await getGridConfig(env.DB, env);
  if (!cfg.enabled) return;

  const client = new BinanceClient(env);
  let candidates: string[] = [];
  let rejectedSample: Array<{ symbol: string; reason: string }> = [];
  let downturnResolved: Awaited<ReturnType<typeof resolveGridMarketDownturn>> | null = null;

  if (cfg.useWatchlist) {
    try {
      const tickers = await client.getTicker24hr();
      const excluded = new Set(cfg.excludeSymbols);
      const symsForBreadth = tickers
        .filter((t) => t.symbol.endsWith('USDT'))
        .map((t) => t.symbol);
      if (cfg.marketDownturnEnabled) {
        downturnResolved = await resolveGridMarketDownturn(
          env,
          client,
          cfg,
          symsForBreadth.slice(0, 80),
        );
        await syncGridMarketDownturnObservability(env.DB, downturnResolved);
      }

      const riskCfg = {
        ...scoutRiskConfigFromGrid(cfg),
        downturnActive: downturnResolved?.active ?? false,
        minChangePctInDownturn: cfg.marketDownturnScoutMinChangePct,
      };

      const pool: ScoutTickerRow[] = tickers
        .filter((t) => t.symbol.endsWith('USDT'))
        .filter((t) => !STABLE_BASES.has(t.symbol.replace(/USDT$/, '')))
        .filter((t) => !isSystemTradeBlockedSymbol(t.symbol))
        .filter((t) => !excluded.has(t.symbol))
        .filter((t) => Number(t.quoteVolume) > 0)
        .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
        .slice(0, cfg.candidateCount * cfg.scoutPoolMultiplier)
        .map((t) => ({
          symbol: t.symbol,
          quoteVolume: Number(t.quoteVolume),
          priceChangePercent: Number(t.priceChangePercent) || 0,
          highPrice: Number(t.highPrice) || 0,
          lowPrice: Number(t.lowPrice) || 0,
          lastPrice: Number(t.lastPrice) || 0,
        }));

      const { kept, rejected } = await filterScoutPool(client, pool, riskCfg);
      rejectedSample = rejected.slice(0, 12);
      candidates = kept.slice(0, cfg.candidateCount);
    } catch (err) {
      await logEvent(env.DB, 'GRID_SCOUT_ERROR', {
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
  }

  // pinned sembol her zaman izlensin (manual mod / fallback)
  if (cfg.symbol && !candidates.includes(cfg.symbol)) {
    candidates = [cfg.symbol, ...candidates].slice(0, Math.max(cfg.candidateCount, 1));
  }
  if (candidates.length === 0) candidates = [cfg.symbol];

  await replaceWatchlist(
    env.DB,
    candidates.map((symbol) => ({ symbol, price_at_addition: '0' })),
  );
  await ensureMarketDataWatchlist(env, candidates);

  await logEvent(env.DB, 'GRID_SCOUT', {
    candidateCount: candidates.length,
    useWatchlist: cfg.useWatchlist,
    riskFilter: cfg.scoutRiskFilterEnabled,
    sample: candidates.slice(0, 10),
    rejectedSample,
    ...(downturnResolved
      ? {
          marketDownturn: downturnResolved.active,
          downturnReasons: downturnResolved.reasons,
          breadthPct: downturnResolved.metrics.breadthPct,
          btc24hChangePct: downturnResolved.metrics.btc24hChangePct,
        }
      : {}),
  });
}
