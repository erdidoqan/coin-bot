/**
 * Momentum-bazlı breadth — saf/test edilebilir.
 *
 * 24 saatlik priceChangePercent yerine kısa-vade momentum kullanır: bir coin
 * "toparlanıyor" sayılır ⟺ son N kapalı mum kümülatif gain'i kendi ATR'sinin
 * belirli katından fazlaysa (volatilite-normalize). Böylece V-dönüşü 24s pencere
 * gecikmesi olmadan yakalanır ve eşik her coin/piyasa için otomatik ölçeklenir.
 */
import type { Kline } from '../exchange/binance';
import { bn } from '../math/decimal';
import { atrPctFromKlines, closedCandlesOnly } from './technical';

/** Son `lookback` kapalı mumun kümülatif % değişimi (close[-1] vs close[-1-lookback]). */
export function momentumPctFromKlines(klines: Kline[], lookback: number): string | null {
  const n = klines.length;
  if (lookback <= 0 || n < lookback + 1) return null;
  const ref = bn(klines[n - 1 - lookback]!.close);
  if (ref.lte(0)) return null;
  const cur = bn(klines[n - 1]!.close);
  return cur.minus(ref).dividedBy(ref).times(100).toFixed(4);
}

export interface MomentumUpResult {
  /** Yeterli veri yoksa null (breadth'te sayılmaz). */
  up: boolean | null;
  momentumPct: number | null;
  atrPct: number | null;
}

/**
 * Bir sembol "yukarı momentumda" mı? momentumPct >= atrPct * atrMult.
 * Açık mum çıkarılır; ATR ve momentum kapalı mumlardan hesaplanır.
 */
export function isSymbolMomentumUp(
  klines: Kline[],
  atrMult: number,
  lookback: number,
  atrPeriod = 14,
  nowMs = Date.now(),
): MomentumUpResult {
  const closed = closedCandlesOnly(klines, nowMs);
  // ATR period'unu eldeki mum sayısına adapte et: yeni watchlist sembollerinde
  // DO derinliği henüz 15 mumu bulmamış olabilir; az mumla da değerlendir.
  const effAtrPeriod = Math.min(atrPeriod, Math.max(2, closed.length - 1));
  const atrStr = atrPctFromKlines(closed, effAtrPeriod);
  const momStr = momentumPctFromKlines(closed, lookback);
  if (atrStr == null || momStr == null) {
    return { up: null, momentumPct: momStr != null ? Number(momStr) : null, atrPct: atrStr != null ? Number(atrStr) : null };
  }
  const atrPct = Number(atrStr);
  const momentumPct = Number(momStr);
  const threshold = atrPct * atrMult;
  return { up: momentumPct >= threshold, momentumPct, atrPct };
}

export interface MomentumBreadthResult {
  breadthPct: number;
  upCount: number;
  evaluated: number;
  total: number;
}

/**
 * Watchlist için momentum-breadth. `klinesBySymbol` her sembolün ham klines'ı.
 * ATR/momentum hesaplanamayan semboller `evaluated` dışında bırakılır.
 */
export function computeMomentumBreadth(
  symbols: string[],
  klinesBySymbol: (symbol: string) => Kline[],
  atrMult: number,
  lookback: number,
  nowMs = Date.now(),
): MomentumBreadthResult {
  let upCount = 0;
  let evaluated = 0;
  for (const symbol of symbols) {
    const klines = klinesBySymbol(symbol);
    const res = isSymbolMomentumUp(klines, atrMult, lookback, 14, nowMs);
    if (res.up == null) continue;
    evaluated++;
    if (res.up) upCount++;
  }
  const breadthPct = evaluated > 0 ? (upCount / evaluated) * 100 : 0;
  return { breadthPct, upCount, evaluated, total: symbols.length };
}
