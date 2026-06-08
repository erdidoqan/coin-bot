/**
 * Fiyat penceresi yardımcıları — saf/bağımsız.
 *
 * Capitulation/rolling getiri hesapları. Grid'den bağımsız; dip-reversal taraması
 * ve diğer stratejiler kullanır.
 */

/** DO 1m: ref = klines[length - 1 - barsAgo].close; (last - ref)/ref * 100. */
export function rollingReturnPct(
  lastPrice: number | null,
  klines: Array<{ close: number | string }> | null,
  barsAgo: number,
): number | null {
  if (lastPrice == null || !(lastPrice > 0) || !klines || barsAgo < 1) return null;
  const refIdx = klines.length - 1 - barsAgo;
  if (refIdx < 0) return null;
  const ref = Number(klines[refIdx]!.close);
  if (!(ref > 0)) return null;
  return Number((((lastPrice - ref) / ref) * 100).toFixed(2));
}

/** Son windowMin dakikadaki 5m kapanışlardan tepe → last düşüş %. */
export function windowDropPctFromCloses(
  closes: number[],
  lastPrice: number,
  windowMin: number,
): number {
  if (closes.length === 0 || !(lastPrice > 0) || windowMin <= 0) return 0;
  const bars = Math.max(1, Math.ceil(windowMin / 5));
  const slice = closes.slice(-bars);
  const peak = Math.max(...slice, lastPrice);
  if (!(peak > 0)) return 0;
  const drop = ((peak - lastPrice) / peak) * 100;
  return drop > 0 ? drop : 0;
}
