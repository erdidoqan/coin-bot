import type { BookTicker, Ticker24hr } from '../exchange/binance';
import { bn } from '../math/decimal';

const STABLE_BASES = new Set([
  'USDC',
  'FDUSD',
  'TUSD',
  'BUSD',
  'DAI',
  'USDP',
  'EUR',
  'AEUR',
  'USD1',
  'USDE',
]);
const LEVERAGED_SUFFIX = /(UP|DOWN|BEAR|BULL)$/i;

export const MIN_QUOTE_VOLUME = 5_000_000;
export const MAX_PRICE_CHANGE_PCT = 15;
/** Gözcü watchlist varsayılan boyutu (D1 `watchlist_size` öncelikli) */
export const WATCHLIST_SIZE_DEFAULT = 10;
/** Tick scalp gözcü: min 24s USDT hacim */
export const TICK_WATCHLIST_MIN_QUOTE_VOLUME = 5_000_000;
/** Tick scalp gözcü: 24s değişim alt sınırı (%) — negatif günler de izlenir */
export const TICK_WATCHLIST_MIN_DAILY_CHANGE_PCT = -10;

export type FilterSkipReason =
  | 'not_usdt'
  | 'stable_base'
  | 'low_volume'
  | 'spread'
  | 'price_change'
  | 'leveraged_name'
  | 'low_volatility';

export interface FilterResult {
  passed: Ticker24hr[];
  skippedSamples: Array<{ symbol: string; reason: FilterSkipReason }>;
  filteredCount: number;
}

export function isLeveragedOrDerivativeSymbol(symbol: string): boolean {
  if (!symbol.endsWith('USDT')) return false;
  const base = symbol.slice(0, -4);
  if (LEVERAGED_SUFFIX.test(base)) return true;
  if (/UPUSDT|DOWNUSDT/i.test(symbol)) return true;
  return false;
}

export function isLowVolatilityTicker(
  priceChangePercent: string | number,
  stableMaxVolatilityPct: string,
): boolean {
  return bn(priceChangePercent).abs().lt(stableMaxVolatilityPct);
}

export interface FilterOptions {
  stableMaxVolatilityPct: string;
  maxSkippedSamples?: number;
}

function skipReasonFor(
  t: Ticker24hr,
  stableMaxVolatilityPct: string,
): FilterSkipReason | null {
  if (!t.symbol.endsWith('USDT')) return 'not_usdt';

  const base = t.symbol.slice(0, -4);
  if (STABLE_BASES.has(base)) return 'stable_base';
  if (isLeveragedOrDerivativeSymbol(t.symbol)) return 'leveraged_name';

  const quoteVolume = Number(t.quoteVolume);
  const priceChangePercent = Number(t.priceChangePercent);

  if (quoteVolume <= MIN_QUOTE_VOLUME) return 'low_volume';
  if (priceChangePercent <= 0 || priceChangePercent >= MAX_PRICE_CHANGE_PCT) return 'price_change';
  if (isLowVolatilityTicker(priceChangePercent, stableMaxVolatilityPct)) return 'low_volatility';

  return null;
}

export function filterTickersWithMeta(tickers: Ticker24hr[], options: FilterOptions): FilterResult {
  const maxSamples = options.maxSkippedSamples ?? 5;
  const passed: Ticker24hr[] = [];
  const skippedSamples: FilterResult['skippedSamples'] = [];
  let filteredCount = 0;

  for (const t of tickers) {
    const reason = skipReasonFor(t, options.stableMaxVolatilityPct);
    if (reason) {
      filteredCount++;
      if (skippedSamples.length < maxSamples) {
        skippedSamples.push({ symbol: t.symbol, reason });
      }
      continue;
    }
    passed.push(t);
  }

  return { passed, skippedSamples, filteredCount };
}

export function sortByQuoteVolume(tickers: Ticker24hr[]): Ticker24hr[] {
  return [...tickers].sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume));
}

export function pickTopWatchlist(
  tickers: Ticker24hr[],
  options: FilterOptions,
  size: number = WATCHLIST_SIZE_DEFAULT,
): FilterResult & { top: Ticker24hr[] } {
  const { passed, skippedSamples, filteredCount } = filterTickersWithMeta(tickers, options);
  const top = sortByQuoteVolume(passed).slice(0, size);
  return { passed, skippedSamples, filteredCount, top };
}

export interface TickWatchlistOptions {
  stableMaxVolatilityPct: string;
  minQuoteVolumeUsdt?: number;
  minDailyChangePct?: number;
  maxDailyChangePct?: number;
  maxSkippedSamples?: number;
}

function skipReasonForTick(
  t: Ticker24hr,
  stableMaxVolatilityPct: string,
  minDailyChangePct: number,
  maxDailyChangePct: number,
  minQuoteVolumeUsdt: number,
): FilterSkipReason | null {
  if (!t.symbol.endsWith('USDT')) return 'not_usdt';

  const base = t.symbol.slice(0, -4);
  if (STABLE_BASES.has(base)) return 'stable_base';
  if (isLeveragedOrDerivativeSymbol(t.symbol)) return 'leveraged_name';

  const quoteVolume = Number(t.quoteVolume);
  const priceChangePercent = Number(t.priceChangePercent);

  if (quoteVolume < minQuoteVolumeUsdt) return 'low_volume';
  if (priceChangePercent < minDailyChangePct || priceChangePercent >= maxDailyChangePct) {
    return 'price_change';
  }
  if (isLowVolatilityTicker(priceChangePercent, stableMaxVolatilityPct)) return 'low_volatility';

  return null;
}

/** Tick scalp gözcü: hibrit/mikro kadar sıkı değil; hacme göre üst N (negatif 24s dahil). */
export function pickTickWatchlist(
  tickers: Ticker24hr[],
  options: TickWatchlistOptions,
  size: number,
): FilterResult & { top: Ticker24hr[] } {
  const maxSamples = options.maxSkippedSamples ?? 5;
  const minVol = options.minQuoteVolumeUsdt ?? TICK_WATCHLIST_MIN_QUOTE_VOLUME;
  const minCh = options.minDailyChangePct ?? TICK_WATCHLIST_MIN_DAILY_CHANGE_PCT;
  const maxCh = options.maxDailyChangePct ?? MAX_PRICE_CHANGE_PCT;
  const passed: Ticker24hr[] = [];
  const skippedSamples: FilterResult['skippedSamples'] = [];
  let filteredCount = 0;

  for (const t of tickers) {
    const reason = skipReasonForTick(
      t,
      options.stableMaxVolatilityPct,
      minCh,
      maxCh,
      minVol,
    );
    if (reason) {
      filteredCount++;
      if (skippedSamples.length < maxSamples) {
        skippedSamples.push({ symbol: t.symbol, reason });
      }
      continue;
    }
    passed.push(t);
  }

  const top = sortByQuoteVolume(passed).slice(0, size);
  return { passed, skippedSamples, filteredCount, top };
}

/** @deprecated pickTopWatchlist kullanın */
export function pickTop3(tickers: Ticker24hr[], options: FilterOptions): FilterResult & { top: Ticker24hr[] } {
  return pickTopWatchlist(tickers, options, 3);
}

/** @deprecated Use pickTopWatchlist with FilterOptions */
export function filterTickers(tickers: Ticker24hr[]): Ticker24hr[] {
  return filterTickersWithMeta(tickers, { stableMaxVolatilityPct: '0.1' }).passed;
}

export interface MicroUniverseOptions {
  stableMaxVolatilityPct: string;
  minQuoteVolumeUsdt: number;
  maxSpreadPct: string;
  maxSkippedSamples?: number;
}

function spreadPctFromBook(t: BookTicker): number {
  const bid = bn(t.bidPrice);
  const ask = bn(t.askPrice);
  if (bid.isZero() || ask.isZero()) return 100;
  const mid = bid.plus(ask).dividedBy(2);
  if (mid.isZero()) return 100;
  return ask.minus(bid).dividedBy(mid).times(100).toNumber();
}

export function pickMicroUniverse(
  tickers: Ticker24hr[],
  bookBySymbol: Map<string, BookTicker>,
  options: MicroUniverseOptions,
  size: number,
): FilterResult & { top: Ticker24hr[] } {
  const maxSamples = options.maxSkippedSamples ?? 5;
  const passed: Ticker24hr[] = [];
  const skippedSamples: FilterResult['skippedSamples'] = [];
  let filteredCount = 0;

  for (const t of tickers) {
    let reason = skipReasonFor(t, options.stableMaxVolatilityPct);
    if (!reason && Number(t.quoteVolume) < options.minQuoteVolumeUsdt) {
      reason = 'low_volume';
    }
    if (!reason) {
      const book = bookBySymbol.get(t.symbol);
      const spread = book ? spreadPctFromBook(book) : null;
      if (spread != null && spread > Number(options.maxSpreadPct)) {
        reason = 'spread';
      }
    }
    if (reason) {
      filteredCount++;
      if (skippedSamples.length < maxSamples) {
        skippedSamples.push({ symbol: t.symbol, reason });
      }
      continue;
    }
    passed.push(t);
  }

  const top = sortByQuoteVolume(passed).slice(0, size);
  return { passed, skippedSamples, filteredCount, top };
}
