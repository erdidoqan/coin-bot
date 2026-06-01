import {
  getDipWatchConfig,
  listActiveEntries,
  updateLiveMetrics,
  type DipWatchEntryRow,
} from '../db/dip-watch';
import { BinanceClient } from '../exchange/binance';
import {
  ensureMarketDataWatchlist,
  fetchTickersFromDo,
} from '../exchange/market-data-client';
import { paperPnlPct } from '../strategy/dip-watch';
import type { Ticker24hr } from '../exchange/binance';

function tickerMap(tickers: Ticker24hr[]): Map<string, Ticker24hr> {
  const m = new Map<string, Ticker24hr>();
  for (const t of tickers) {
    m.set(t.symbol, t);
  }
  return m;
}

function lastFromTicker(t: Ticker24hr): number {
  return Number(t.lastPrice) || 0;
}

async function fetchAllTickers(env: Env): Promise<Ticker24hr[]> {
  const fromDo = await fetchTickersFromDo(env);
  if (fromDo && fromDo.length > 0) return fromDo;
  const client = new BinanceClient(env);
  return client.getTicker24hr();
}

export async function refreshActiveDipWatchMetrics(
  env: Env,
  entries: DipWatchEntryRow[],
  tickers: Ticker24hr[],
): Promise<void> {
  if (entries.length === 0) return;
  const map = tickerMap(tickers);
  for (const entry of entries) {
    const t = map.get(entry.symbol);
    if (!t) continue;
    const last = lastFromTicker(t);
    if (!(last > 0)) continue;
    const pnl = paperPnlPct(entry.entry_price, last);
    if (pnl == null) continue;
    const prevGain = entry.max_gain_pct ?? 0;
    const prevDraw = entry.max_draw_pct ?? 0;
    await updateLiveMetrics(env.DB, {
      id: entry.id,
      lastPrice: last,
      unrealizedPct: pnl,
      maxGainPct: Math.max(prevGain, pnl),
      maxDrawPct: Math.min(prevDraw, pnl),
    });
  }
}

/** Cron: aktif izleme listesi + scanner havuzu için DO WS; D1 canlı metrikleri güncelle */
export async function runDipWatchRefresh(env: Env): Promise<void> {
  const cfg = await getDipWatchConfig(env.DB, env);
  const active = await listActiveEntries(env.DB);
  const symbols = new Set(active.map((e) => e.symbol));

  const tickers = await fetchAllTickers(env);
  if (tickers.length === 0) return;

  const pool = tickers
    .filter((t) => t.symbol.endsWith('USDT'))
    .filter((t) => Number(t.quoteVolume) >= cfg.minQuoteVolumeUsdt)
    .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
    .slice(0, cfg.scanPoolSize)
    .map((t) => t.symbol);

  for (const s of pool) symbols.add(s);

  if (symbols.size > 0) {
    await ensureMarketDataWatchlist(env, [...symbols]);
  }

  await refreshActiveDipWatchMetrics(env, active, tickers);
}
