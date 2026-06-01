import {
  addDipWatchEntry,
  closeDipWatchEntry,
  getActiveEntryBySymbol,
  getDipWatchConfig,
  listActiveEntries,
  listClosedEntries,
  summarizeClosedEntries,
  type DipWatchEntryRow,
} from '../db/dip-watch';
import { BinanceClient } from '../exchange/binance';
import {
  fetchSymbolMidPrice,
  fetchTickersFromDo,
} from '../exchange/market-data-client';
import { isPeggedUsdUsdtSymbol } from '../config/filters';
import { buildQualityFilteredScanner } from '../jobs/dip-watch-scanner';
import type { DipWatchQualitySummary } from '../jobs/dip-watch-scanner';
import {
  heldHoursSince,
  paperPnlPct,
  positionIn24hRangePct,
  type DipWatchScannerRow,
} from '../strategy/dip-watch';
import type { Ticker24hr } from '../exchange/binance';

export interface DipWatchActiveRow {
  id: number;
  symbol: string;
  entryPrice: number;
  entryAt: string;
  lastPrice: number;
  low24h: number;
  high24h: number;
  positionPct: number | null;
  distanceFromLowPct: number | null;
  unrealizedPct: number | null;
  maxGainPct: number;
  maxDrawPct: number;
  heldHours: number;
}

export interface DipWatchApiResponse {
  config: Awaited<ReturnType<typeof getDipWatchConfig>>;
  scanner: DipWatchScannerRow[];
  active: DipWatchActiveRow[];
  summary: {
    activeCount: number;
    maxTracked: number;
    marketDataAvailable: boolean;
    quality: DipWatchQualitySummary;
  };
  updatedAt: string;
}

export interface DipWatchHistoryApiResponse {
  rows: Array<{
    id: number;
    symbol: string;
    entryPrice: number;
    entryAt: string;
    exitPrice: number | null;
    exitAt: string | null;
    exitReason: string | null;
    realizedPct: number | null;
    maxGainPct: number | null;
    maxDrawPct: number | null;
    entryPositionPct: number | null;
    heldHours: number | null;
  }>;
  summary: Awaited<ReturnType<typeof summarizeClosedEntries>>;
}

function tickersHave24hRange(tickers: Ticker24hr[]): boolean {
  let ok = 0;
  for (const t of tickers) {
    if (!t.symbol.endsWith('USDT')) continue;
    const high = Number(t.highPrice);
    const low = Number(t.lowPrice);
    if (high > low && low > 0) ok++;
    if (ok >= 12) return true;
  }
  return false;
}

async function fetchTickers(env: Env): Promise<Ticker24hr[]> {
  const fromDo = await fetchTickersFromDo(env);
  if (fromDo && fromDo.length > 0 && tickersHave24hRange(fromDo)) return fromDo;
  const client = new BinanceClient(env);
  return client.getTicker24hr();
}

function tickerToInput(t: Ticker24hr) {
  return {
    symbol: t.symbol,
    lastPrice: Number(t.lastPrice) || 0,
    low24h: Number(t.lowPrice) || 0,
    high24h: Number(t.highPrice) || 0,
    quoteVolume: Number(t.quoteVolume) || 0,
  };
}

async function resolveLastPrice(
  env: Env,
  symbol: string,
  tickers: Map<string, Ticker24hr>,
): Promise<number | null> {
  const t = tickers.get(symbol);
  if (t) {
    const last = Number(t.lastPrice);
    if (last > 0) return last;
  }
  const mid = await fetchSymbolMidPrice(env, symbol);
  if (mid) {
    const n = Number(mid);
    if (n > 0) return n;
  }
  return null;
}

function enrichActiveRow(
  entry: DipWatchEntryRow,
  last: number,
  low24h: number,
  high24h: number,
): DipWatchActiveRow {
  const pnl = paperPnlPct(entry.entry_price, last);
  const pos = positionIn24hRangePct(last, low24h, high24h);
  const dist = distanceFromLowPct(last, low24h);
  const liveGain = pnl != null ? Math.max(entry.max_gain_pct ?? 0, pnl) : (entry.max_gain_pct ?? 0);
  const liveDraw = pnl != null ? Math.min(entry.max_draw_pct ?? 0, pnl) : (entry.max_draw_pct ?? 0);
  return {
    id: entry.id,
    symbol: entry.symbol,
    entryPrice: entry.entry_price,
    entryAt: entry.entry_at,
    lastPrice: last,
    low24h,
    high24h,
    positionPct: pos,
    distanceFromLowPct: dist,
    unrealizedPct: pnl,
    maxGainPct: liveGain,
    maxDrawPct: liveDraw,
    heldHours: heldHoursSince(entry.entry_at),
  };
}

export async function buildDipWatchReport(env: Env): Promise<DipWatchApiResponse> {
  const cfg = await getDipWatchConfig(env.DB, env);
  const tickers = await fetchTickers(env);
  const map = new Map(tickers.map((t) => [t.symbol, t]));

  const poolInputs = tickers
    .filter((t) => t.symbol.endsWith('USDT'))
    .filter((t) => !isPeggedUsdUsdtSymbol(t.symbol))
    .filter((t) => Number(t.quoteVolume) >= cfg.minQuoteVolumeUsdt)
    .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
    .slice(0, cfg.scanPoolSize)
    .map(tickerToInput);

  const { scanner, qualitySummary } = await buildQualityFilteredScanner(
    env,
    poolInputs,
    cfg.quality,
    cfg.scanPoolSize,
    cfg.minQuoteVolumeUsdt,
  );

  const activeEntries = await listActiveEntries(env.DB);
  const active: DipWatchActiveRow[] = [];
  for (const entry of activeEntries) {
    const t = map.get(entry.symbol);
    const low = t ? Number(t.lowPrice) : (entry.entry_low24h ?? 0);
    const high = t ? Number(t.highPrice) : (entry.entry_high24h ?? 0);
    const last =
      (await resolveLastPrice(env, entry.symbol, map)) ??
      entry.last_price ??
      entry.entry_price;
    active.push(enrichActiveRow(entry, last, low, high));
  }

  return {
    config: cfg,
    scanner,
    active,
    summary: {
      activeCount: active.length,
      maxTracked: cfg.maxTracked,
      marketDataAvailable: Boolean(env.MARKET_DATA),
      quality: qualitySummary,
    },
    updatedAt: new Date().toISOString(),
  };
}

export async function buildDipWatchHistoryReport(
  env: Env,
  opts: { symbol?: string; limit?: number },
): Promise<DipWatchHistoryApiResponse> {
  const rows = await listClosedEntries(env.DB, {
    symbol: opts.symbol,
    limit: opts.limit ?? 50,
  });
  const summary = await summarizeClosedEntries(env.DB);
  return {
    rows: rows.map((r) => ({
      id: r.id,
      symbol: r.symbol,
      entryPrice: r.entry_price,
      entryAt: r.entry_at,
      exitPrice: r.exit_price,
      exitAt: r.exit_at,
      exitReason: r.exit_reason,
      realizedPct: r.unrealized_pct,
      maxGainPct: r.max_gain_pct,
      maxDrawPct: r.max_draw_pct,
      entryPositionPct: r.entry_position_pct,
      heldHours:
        r.exit_at && r.entry_at ? heldHoursSince(r.entry_at, Date.parse(r.exit_at)) : null,
    })),
    summary,
  };
}

export async function handleDipWatchAddSymbol(
  env: Env,
  symbolRaw: string,
): Promise<{ ok: true; report: DipWatchApiResponse } | { ok: false; error: string }> {
  const symbol = symbolRaw.trim().toUpperCase();
  if (!symbol.endsWith('USDT')) {
    return { ok: false, error: 'Geçersiz sembol (USDT çifti gerekli)' };
  }

  const tickers = await fetchTickers(env);
  const t = tickers.find((x) => x.symbol === symbol);
  if (!t) {
    return { ok: false, error: 'Sembol bulunamadı' };
  }

  const last =
    (await resolveLastPrice(env, symbol, new Map(tickers.map((x) => [x.symbol, x])))) ??
    Number(t.lastPrice);
  if (!(last > 0)) {
    return { ok: false, error: 'Fiyat alınamadı' };
  }

  const low = Number(t.lowPrice) || 0;
  const high = Number(t.highPrice) || 0;
  const pos = positionIn24hRangePct(last, low, high);

  const added = await addDipWatchEntry(env.DB, {
    symbol,
    entryPrice: last,
    entryLow24h: low,
    entryHigh24h: high,
    entryPositionPct: pos,
  });
  if (!added.ok) {
    return { ok: false, error: added.error };
  }

  const symbols = (await listActiveEntries(env.DB)).map((e) => e.symbol);
  const { ensureMarketDataWatchlist } = await import('../exchange/market-data-client');
  await ensureMarketDataWatchlist(env, symbols);

  const report = await buildDipWatchReport(env);
  return { ok: true, report };
}

export async function handleDipWatchRemoveSymbol(
  env: Env,
  symbolRaw: string,
): Promise<{ ok: true; report: DipWatchApiResponse } | { ok: false; error: string }> {
  const symbol = symbolRaw.trim().toUpperCase();
  const entry = await getActiveEntryBySymbol(env.DB, symbol);
  if (!entry) {
    return { ok: false, error: 'Aktif kayıt bulunamadı' };
  }

  const tickers = await fetchTickers(env);
  const last =
    (await resolveLastPrice(env, symbol, new Map(tickers.map((x) => [x.symbol, x])))) ??
    entry.last_price ??
    entry.entry_price;

  const closed = await closeDipWatchEntry(env.DB, symbol, last, 'manual');
  if (!closed.ok) {
    return { ok: false, error: closed.error };
  }

  const report = await buildDipWatchReport(env);
  return { ok: true, report };
}
