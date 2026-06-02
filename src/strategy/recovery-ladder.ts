/** Kurtarma kademeli işlem — manuel adımlar (anchor = recovery_avg_cost). */

export type RecoveryLadderStepKind = 'hold' | 'buy' | 'sell' | 'sell_all';

export interface RecoveryLadderStepDef {
  id: string;
  thresholdPct: number;
  kind: RecoveryLadderStepKind;
  /** Alım: pozisyon değerinin % · Satış: recovery_qty'nin % */
  actionPct?: number;
  label: string;
}

export const RECOVERY_LADDER_STEPS: RecoveryLadderStepDef[] = [
  { id: 'dip_5', thresholdPct: -5, kind: 'hold', label: '−5% · Tut' },
  { id: 'dip_15', thresholdPct: -15, kind: 'buy', actionPct: 10, label: '−15% · Al %10' },
  { id: 'dip_25', thresholdPct: -25, kind: 'buy', actionPct: 25, label: '−25% · Al %25' },
  { id: 'up_5', thresholdPct: 5, kind: 'hold', label: '+5% · Tut' },
  { id: 'up_15', thresholdPct: 15, kind: 'hold', label: '+15% · Tut' },
  { id: 'up_25', thresholdPct: 25, kind: 'sell', actionPct: 10, label: '+25% · Sat %10' },
  { id: 'up_35', thresholdPct: 35, kind: 'sell', actionPct: 20, label: '+35% · Sat %20' },
  { id: 'up_45', thresholdPct: 45, kind: 'sell', actionPct: 30, label: '+45% · Sat %30' },
  { id: 'up_60', thresholdPct: 60, kind: 'sell', actionPct: 40, label: '+60% · Sat %40' },
  { id: 'up_100', thresholdPct: 100, kind: 'sell_all', label: '+100% · Tümünü sat' },
];

export function getRecoveryLadderStep(stepId: string): RecoveryLadderStepDef | undefined {
  return RECOVERY_LADDER_STEPS.find((s) => s.id === stepId);
}

export function movePctFromAnchor(anchor: number, lastPrice: number): number | null {
  if (!(anchor > 0) || !(lastPrice > 0)) return null;
  return ((lastPrice - anchor) / anchor) * 100;
}

/** Eşik geçildi mi (bilgi amaçlı; manuel tıklamada zorunlu değil). */
export function isThresholdReached(movePct: number, thresholdPct: number): boolean {
  if (thresholdPct < 0) return movePct <= thresholdPct;
  return movePct >= thresholdPct;
}

export function quoteUsdtForLadderBuy(
  positionQty: number,
  lastPrice: number,
  actionPct: number,
): number | null {
  if (!(positionQty > 0) || !(lastPrice > 0) || !(actionPct > 0)) return null;
  return positionQty * lastPrice * (actionPct / 100);
}

export function baseQtyForLadderSell(recoveryQty: number, actionPct: number): number | null {
  if (!(recoveryQty > 0) || !(actionPct > 0)) return null;
  return recoveryQty * (actionPct / 100);
}

export interface RecoveryLadderStepView {
  id: string;
  label: string;
  kind: RecoveryLadderStepKind;
  thresholdPct: number;
  actionPct: number | null;
  done: boolean;
  suggested: boolean;
}

/** Otomasyon: sıradaki ilk tamamlanmamış ve eşiği geçmiş adım. */
export function pickAutoRecoveryLadderStep(
  doneIds: string[],
  anchor: number,
  lastPrice: number,
): RecoveryLadderStepDef | null {
  const movePct = movePctFromAnchor(anchor, lastPrice);
  if (movePct == null) return null;
  const doneSet = new Set(doneIds);
  for (const step of RECOVERY_LADDER_STEPS) {
    if (doneSet.has(step.id)) continue;
    if (isThresholdReached(movePct, step.thresholdPct)) return step;
  }
  return null;
}

export function buildRecoveryLadderStepViews(
  doneIds: string[],
  anchor: number,
  lastPrice: number | null,
): RecoveryLadderStepView[] {
  const movePct = lastPrice != null ? movePctFromAnchor(anchor, lastPrice) : null;
  const doneSet = new Set(doneIds);
  return RECOVERY_LADDER_STEPS.map((s) => ({
    id: s.id,
    label: s.label,
    kind: s.kind,
    thresholdPct: s.thresholdPct,
    actionPct: s.actionPct ?? null,
    done: doneSet.has(s.id),
    suggested: movePct != null && isThresholdReached(movePct, s.thresholdPct),
  }));
}
