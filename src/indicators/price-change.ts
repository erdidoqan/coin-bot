import { bn } from '../math/decimal';

/** (current − ref) / ref × 100, işaretli string */
export function changeSinceRefPct(refPrice: string, currentPrice: string): string {
  const ref = bn(refPrice);
  if (ref.lte(0)) return '—';
  const current = bn(currentPrice);
  if (!current.isFinite()) return '—';
  return current.minus(ref).dividedBy(ref).times(100).toFixed(2);
}
