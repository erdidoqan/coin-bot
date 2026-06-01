import { isPeggedUsdUsdtSymbol } from '../config/filters';

/** 24s aralıkta konum: 0 = dipte, 100 = tepede */
export function positionIn24hRangePct(last: number, low: number, high: number): number | null {
  if (!Number.isFinite(last) || !Number.isFinite(low) || !Number.isFinite(high)) return null;
  const span = high - low;
  if (span <= 0) return null;
  const pct = ((last - low) / span) * 100;
  return Math.max(0, Math.min(100, pct));
}

/** Son fiyatın 24s dibinden yüzde uzaklığı (pozitif = dipten yukarı) */
export function distanceFromLowPct(last: number, low: number): number | null {
  if (!Number.isFinite(last) || !Number.isFinite(low) || low <= 0) return null;
  return ((last - low) / low) * 100;
}

/** Paper PnL: (last - entry) / entry * 100 */
export function paperPnlPct(entry: number, last: number): number | null {
  if (!Number.isFinite(entry) || !Number.isFinite(last) || entry <= 0) return null;
  return ((last - entry) / entry) * 100;
}

export function heldHoursSince(isoAt: string, nowMs = Date.now()): number {
  const t = Date.parse(isoAt);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, (nowMs - t) / (3600 * 1000));
}

export interface DipWatchTickerInput {
  symbol: string;
  lastPrice: number;
  low24h: number;
  high24h: number;
  quoteVolume: number;
}

export interface DipWatchScannerRow {
  symbol: string;
  lastPrice: number;
  low24h: number;
  high24h: number;
  positionPct: number;
  distanceFromLowPct: number;
  quoteVolume: number;
  spreadPct?: number | null;
  volMcapRatio?: number | null;
  listingDays?: number | null;
}

/** Havuzdaki tüm USDT çiftleri — 24s konuma göre sıralı (dipte olanlar üstte), konum eşiği yok. */
export function buildDipScannerRows(
  tickers: DipWatchTickerInput[],
  minQuoteVolumeUsdt: number,
  limit: number,
): DipWatchScannerRow[] {
  const rows: DipWatchScannerRow[] = [];
  for (const t of tickers) {
    if (!t.symbol.endsWith('USDT')) continue;
    if (isPeggedUsdUsdtSymbol(t.symbol)) continue;
    if (t.quoteVolume < minQuoteVolumeUsdt) continue;
    const pos = positionIn24hRangePct(t.lastPrice, t.low24h, t.high24h);
    const dist = distanceFromLowPct(t.lastPrice, t.low24h);
    if (pos == null || dist == null) continue;
    rows.push({
      symbol: t.symbol,
      lastPrice: t.lastPrice,
      low24h: t.low24h,
      high24h: t.high24h,
      positionPct: pos,
      distanceFromLowPct: dist,
      quoteVolume: t.quoteVolume,
    });
  }
  rows.sort((a, b) => a.positionPct - b.positionPct || b.quoteVolume - a.quoteVolume);
  return rows.slice(0, limit);
}
