import type { BookTicker, DepthLevel } from '../exchange/binance';

export interface DipWatchQualityConfig {
  enabled: boolean;
  minListingDays: number;
  maxSpreadPct: number;
  depthBandPct: number;
  minDepthQuoteUsdt: number;
  maxVolMcapRatio: number;
  minCirculatingSupplyPct: number;
  maxFdvToMcapRatio: number;
}

export function spreadPctFromBook(bid: number, ask: number): number | null {
  if (!(bid > 0 && ask > 0 && ask >= bid)) return null;
  const mid = (bid + ask) / 2;
  return mid > 0 ? ((ask - bid) / mid) * 100 : null;
}

export function spreadPctFromBookTicker(book: BookTicker): number | null {
  return spreadPctFromBook(Number(book.bidPrice), Number(book.askPrice));
}

/** ±bandPct içindeki bid/ask tarafı USDT notional derinliği */
export function quoteDepthWithinBand(
  mid: number,
  bids: DepthLevel[],
  asks: DepthLevel[],
  bandPct: number,
): { bidQuoteUsdt: number; askQuoteUsdt: number } {
  if (!(mid > 0)) return { bidQuoteUsdt: 0, askQuoteUsdt: 0 };
  const low = mid * (1 - bandPct / 100);
  const high = mid * (1 + bandPct / 100);
  let bidQuoteUsdt = 0;
  let askQuoteUsdt = 0;
  for (const b of bids) {
    const price = Number(b.price);
    const qty = Number(b.qty);
    if (!(price > 0 && qty > 0)) continue;
    if (price >= low) bidQuoteUsdt += price * qty;
  }
  for (const a of asks) {
    const price = Number(a.price);
    const qty = Number(a.qty);
    if (!(price > 0 && qty > 0)) continue;
    if (price <= high) askQuoteUsdt += price * qty;
  }
  return { bidQuoteUsdt, askQuoteUsdt };
}

export function passesOrderBookDepth(
  bidQuoteUsdt: number,
  askQuoteUsdt: number,
  minDepthQuoteUsdt: number,
): boolean {
  return bidQuoteUsdt >= minDepthQuoteUsdt && askQuoteUsdt >= minDepthQuoteUsdt;
}

export function volMcapRatio(quoteVolume24h: number, marketCapUsd: number): number | null {
  if (!(marketCapUsd > 0) || !(quoteVolume24h >= 0)) return null;
  return quoteVolume24h / marketCapUsd;
}

export function passesVolMcapRatio(ratio: number | null, maxRatio: number): boolean {
  if (ratio == null) return true;
  return ratio <= maxRatio;
}

export function passesListingAge(onboardMs: number | null, minListingDays: number): boolean {
  if (onboardMs == null || !Number.isFinite(onboardMs)) return true;
  const ageDays = (Date.now() - onboardMs) / (86400 * 1000);
  return ageDays >= minListingDays;
}

export function passesCirculatingSupplyPct(
  circulating: number | null,
  maxSupply: number | null,
  minCirculatingPct: number,
): boolean {
  if (!(maxSupply != null && maxSupply > 0) || circulating == null) return true;
  return (circulating / maxSupply) * 100 >= minCirculatingPct;
}

export function passesFdvToMcap(marketCap: number | null, fdv: number | null, maxRatio: number): boolean {
  if (!(marketCap != null && marketCap > 0) || fdv == null) return true;
  return fdv / marketCap <= maxRatio;
}

export type DipWatchQualityRejectReason =
  | 'spread'
  | 'depth'
  | 'listing_age'
  | 'vol_mcap'
  | 'supply_unlock'
  | 'fdv';

export function evaluateDipWatchQuality(input: {
  cfg: DipWatchQualityConfig;
  spreadPct: number | null;
  bidDepthUsdt: number;
  askDepthUsdt: number;
  onboardMs: number | null;
  quoteVolume24h: number;
  marketCapUsd: number | null;
  circulatingSupply: number | null;
  maxSupply: number | null;
  fdvUsd: number | null;
  skipDepthCheck?: boolean;
}): { pass: boolean; reason?: DipWatchQualityRejectReason } {
  if (!input.cfg.enabled) return { pass: true };
  const cfg = input.cfg;

  if (input.spreadPct != null && input.spreadPct > cfg.maxSpreadPct) {
    return { pass: false, reason: 'spread' };
  }

  if (
    !input.skipDepthCheck &&
    !passesOrderBookDepth(input.bidDepthUsdt, input.askDepthUsdt, cfg.minDepthQuoteUsdt)
  ) {
    return { pass: false, reason: 'depth' };
  }

  if (!passesListingAge(input.onboardMs, cfg.minListingDays)) {
    return { pass: false, reason: 'listing_age' };
  }

  const volMcap = volMcapRatio(input.quoteVolume24h, input.marketCapUsd ?? 0);
  if (!passesVolMcapRatio(volMcap, cfg.maxVolMcapRatio)) {
    return { pass: false, reason: 'vol_mcap' };
  }

  if (
    !passesCirculatingSupplyPct(
      input.circulatingSupply,
      input.maxSupply,
      cfg.minCirculatingSupplyPct,
    )
  ) {
    return { pass: false, reason: 'supply_unlock' };
  }

  if (!passesFdvToMcap(input.marketCapUsd, input.fdvUsd, cfg.maxFdvToMcapRatio)) {
    return { pass: false, reason: 'fdv' };
  }

  return { pass: true };
}
