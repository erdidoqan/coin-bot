/** Binance listelenme + CoinGecko market cap (scanner kalite filtresi, saatlik cache) */

interface CacheEntry<T> {
  at: number;
  data: T;
}

const LISTING_TTL_MS = 6 * 3600 * 1000;
const MCap_TTL_MS = 6 * 3600 * 1000;

interface CoinGeckoMarketRow {
  symbol: string;
  market_cap: number;
  fully_diluted_valuation: number | null;
  circulating_supply: number;
  total_supply: number | null;
}

export interface CoinFundamentals {
  marketCapUsd: number;
  fdvUsd: number | null;
  circulatingSupply: number;
  maxSupply: number | null;
}

type ListingMap = Map<string, number | null>;
type FundamentalsMap = Map<string, CoinFundamentals>;

declare global {
  // eslint-disable-next-line no-var
  var __dipWatchListingCache: CacheEntry<ListingMap> | undefined;
  // eslint-disable-next-line no-var
  var __dipWatchFundamentalsCache: CacheEntry<FundamentalsMap> | undefined;
}

async function fetchBinanceListingMap(env: Env): Promise<ListingMap> {
  const base = env.BINANCE_BASE_URL ?? 'https://api.binance.com';
  const res = await fetch(`${base}/api/v3/exchangeInfo`);
  if (!res.ok) return new Map();
  const body = (await res.json()) as {
    symbols?: Array<{ symbol?: string; onboardDate?: number }>;
  };
  const map: ListingMap = new Map();
  for (const s of body.symbols ?? []) {
    if (!s.symbol?.endsWith('USDT')) continue;
    map.set(s.symbol, typeof s.onboardDate === 'number' ? s.onboardDate : null);
  }
  return map;
}

async function fetchCoinGeckoFundamentals(): Promise<FundamentalsMap> {
  const map: FundamentalsMap = new Map();
  const pages = 4;
  for (let page = 1; page <= pages; page++) {
    const url = new URL('https://api.coingecko.com/api/v3/coins/markets');
    url.searchParams.set('vs_currency', 'usd');
    url.searchParams.set('order', 'market_cap_desc');
    url.searchParams.set('per_page', '250');
    url.searchParams.set('page', String(page));
    url.searchParams.set('sparkline', 'false');
    const res = await fetch(url.toString(), {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) break;
    const rows = (await res.json()) as CoinGeckoMarketRow[];
    for (const row of rows) {
      if (!row.symbol || !(row.market_cap > 0)) continue;
      const key = row.symbol.toUpperCase();
      map.set(key, {
        marketCapUsd: row.market_cap,
        fdvUsd: row.fully_diluted_valuation ?? null,
        circulatingSupply: row.circulating_supply,
        maxSupply: row.total_supply,
      });
    }
    if (rows.length < 250) break;
  }
  return map;
}

export async function getDipWatchListingMap(env: Env): Promise<ListingMap> {
  const now = Date.now();
  const cached = globalThis.__dipWatchListingCache;
  if (cached && now - cached.at < LISTING_TTL_MS) return cached.data;
  const data = await fetchBinanceListingMap(env);
  globalThis.__dipWatchListingCache = { at: now, data };
  return data;
}

export async function getDipWatchFundamentalsMap(): Promise<FundamentalsMap> {
  const now = Date.now();
  const cached = globalThis.__dipWatchFundamentalsCache;
  if (cached && now - cached.at < MCap_TTL_MS) return cached.data;
  try {
    const data = await fetchCoinGeckoFundamentals();
    globalThis.__dipWatchFundamentalsCache = { at: now, data };
    return data;
  } catch {
    return cached?.data ?? new Map();
  }
}

/** USDT çifti → base asset (CoinGecko symbol genelde base ticker lowercase) */
export function lookupFundamentals(
  symbol: string,
  fundamentals: FundamentalsMap,
): CoinFundamentals | null {
  if (!symbol.endsWith('USDT')) return null;
  const base = symbol.slice(0, -4).toUpperCase();
  return fundamentals.get(base) ?? fundamentals.get(base.toLowerCase()) ?? null;
}

export function listingAgeDays(onboardMs: number | null): number | null {
  if (onboardMs == null || !Number.isFinite(onboardMs)) return null;
  return Math.max(0, (Date.now() - onboardMs) / (86400 * 1000));
}
