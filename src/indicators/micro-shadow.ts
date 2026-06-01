import { bn } from '../math/decimal';
import { changeSinceRefPct } from './price-change';

export type ShadowHorizonMin = 5 | 15 | 30;

export function parseShadowHorizons(raw: string): ShadowHorizonMin[] {
  const out: ShadowHorizonMin[] = [];
  for (const part of raw.split(',')) {
    const n = Number(part.trim());
    if (n === 5 || n === 15 || n === 30) out.push(n);
  }
  if (out.length === 0) return [5, 15, 30];
  return [...new Set(out)].sort((a, b) => a - b) as ShadowHorizonMin[];
}

export function isHorizonDue(recordedAtMs: number, horizonMin: number, nowMs: number): boolean {
  return nowMs >= recordedAtMs + horizonMin * 60_000;
}

export function forwardPctFromRef(refPrice: string, currentPrice: string): string | null {
  const pct = changeSinceRefPct(refPrice, currentPrice);
  return pct === '—' ? null : pct;
}

export function hitTakeProfitGross(forwardPct: string | null, tpGrossPct: string): boolean {
  if (forwardPct == null) return false;
  const fwd = bn(forwardPct);
  const tp = bn(tpGrossPct);
  if (!fwd.isFinite() || !tp.isFinite()) return false;
  return fwd.gte(tp);
}

export function wouldPassScoreOnly(
  scoreNum: number,
  entryMinScore: number,
  regimeAllowed: boolean,
): boolean {
  return scoreNum >= entryMinScore && regimeAllowed;
}
