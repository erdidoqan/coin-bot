import { bn } from '../math/decimal';

/** İmzalı yüzde: (curr − prev) / |prev| × 100 */
export function signedPctDelta(prev: string | number | null | undefined, curr: string | number | null | undefined): string | null {
  const p = bn(String(prev ?? ''));
  const c = bn(String(curr ?? ''));
  if (!p.isFinite() || !c.isFinite()) return null;
  if (p.isZero()) return c.isZero() ? '0' : null;
  const pct = c.minus(p).dividedBy(p.abs()).times(100);
  if (pct.isZero()) return '0';
  const sign = pct.gt(0) ? '+' : '';
  return `${sign}${pct.toFixed(1)}`;
}

/** Skor (0–1) için puan farkı ×100, örn. 0.85→0.94 = +9.0 */
export function signedScorePtsDelta(
  prev: string | number | null | undefined,
  curr: string | number | null | undefined,
): string | null {
  const p = bn(String(prev ?? ''));
  const c = bn(String(curr ?? ''));
  if (!p.isFinite() || !c.isFinite()) return null;
  const pts = c.minus(p).times(100);
  if (pts.isZero()) return '0';
  const sign = pts.gt(0) ? '+' : '';
  return `${sign}${pts.toFixed(1)}`;
}

export interface WatchlistMetricDeltas {
  scorePts: string | null;
  volumePct: string | null;
  aggressionPct: string | null;
  orderbookPct: string | null;
}

export function buildWatchlistMetricDeltas(input: {
  prevScore?: string | null;
  prevVolumeRatio?: string | null;
  prevAggressionRatio?: string | null;
  prevOrderbook?: number | null;
  score: string;
  volumeRatio: string;
  aggressionRatio: string;
  orderbook?: number | null;
}): WatchlistMetricDeltas {
  return {
    scorePts: signedScorePtsDelta(input.prevScore, input.score),
    volumePct: signedPctDelta(input.prevVolumeRatio, input.volumeRatio),
    aggressionPct: signedPctDelta(input.prevAggressionRatio, input.aggressionRatio),
    orderbookPct: signedPctDelta(input.prevOrderbook, input.orderbook),
  };
}

export function parsePrevFromMicroDetail(detail: string | null): {
  score: string | null;
  volumeRatio: string | null;
  aggressionRatio: string | null;
  orderbook: number | null;
} {
  if (!detail) {
    return { score: null, volumeRatio: null, aggressionRatio: null, orderbook: null };
  }
  try {
    const p = JSON.parse(detail) as Record<string, unknown>;
    const ob = p.components as Record<string, number> | undefined;
    return {
      score: p.score != null ? String(p.score) : null,
      volumeRatio: p.volumeRatio != null ? String(p.volumeRatio) : null,
      aggressionRatio: p.aggressionRatio != null ? String(p.aggressionRatio) : null,
      orderbook: ob?.orderbookRatio != null ? Number(ob.orderbookRatio) : null,
    };
  } catch {
    return { score: null, volumeRatio: null, aggressionRatio: null, orderbook: null };
  }
}
