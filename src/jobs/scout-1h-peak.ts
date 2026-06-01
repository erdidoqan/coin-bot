import type { BinanceClient, Kline } from '../exchange/binance';
import { gainFromRefPct } from '../indicators/tick-entry';
import { bn } from '../math/decimal';

export type ScoutTickerCandidate = {
  symbol: string;
  lastPrice: string;
  quoteVolume?: string;
  priceChangePercent?: string;
};

export type Scout1hPeakFilterResult = {
  symbol: string;
  peak1hPct: string | null;
  reason: string;
};

/** Aktif 1h mum: open→high tepe %. */
export function peak1hFromOpenHigh(klines: Kline[]): string | null {
  const c = klines[klines.length - 1];
  if (!c) return null;
  return gainFromRefPct(c.open, c.high);
}

const SCOUT_PEAK_BATCH = 6;

/** Gözcü: 1h open→high tepe ≥ minPeakPct olmayanları çıkar (tick girişte tekrar kontrol yok). */
export async function filterScoutBy1hPeak(
  client: BinanceClient,
  candidates: ScoutTickerCandidate[],
  minPeakPct: string,
): Promise<{
  kept: ScoutTickerCandidate[];
  peakFiltered: Scout1hPeakFilterResult[];
}> {
  const kept: ScoutTickerCandidate[] = [];
  const peakFiltered: Scout1hPeakFilterResult[] = [];

  for (let i = 0; i < candidates.length; i += SCOUT_PEAK_BATCH) {
    const chunk = candidates.slice(i, i + SCOUT_PEAK_BATCH);
    const rows = await Promise.all(
      chunk.map(async (t) => {
        try {
          const klines = await client.getKlines(t.symbol, '1h', 2);
          if (!klines?.length) {
            return { t, peak: null as string | null, reason: 'no_1h_kline' };
          }
          const peak = peak1hFromOpenHigh(klines);
          if (peak == null) {
            return { t, peak: null, reason: 'no_1h_peak' };
          }
          if (bn(peak).lt(minPeakPct)) {
            return { t, peak, reason: '1h_peak_below_min' };
          }
          return { t, peak, reason: '' };
        } catch {
          return { t, peak: null, reason: 'no_1h_kline' };
        }
      }),
    );

    for (const row of rows) {
      if (row.reason) {
        peakFiltered.push({
          symbol: row.t.symbol,
          peak1hPct: row.peak,
          reason: row.reason,
        });
      } else {
        kept.push(row.t);
      }
    }
  }

  return { kept, peakFiltered };
}
