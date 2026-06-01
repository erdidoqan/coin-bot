import { bn } from '../math/decimal';

/** Yüzen zarar bu eşiğin altındaysa bekleme süresi atlanır ve min SMA iyileşmesi 0 olur. */
export const ROTATION_LOSS_BYPASS_PCT = '-0.5';

/** Hafif zararda min iyileşme bu orana indirilir (ör. 0.15 → 0.0375). */
const LOSS_MIN_IMPROVEMENT_FACTOR = 0.25;

export interface ResolvedRotationThresholds {
  graceMinutes: number;
  configuredMinImprovementPct: string;
  effectiveMinImprovementPct: string;
  bypassGraceForLoss: boolean;
  lossRelaxedMin: boolean;
  floatingPnlPct: string | null;
}

export function resolveRotationThresholds(
  rotationWindowMinutes: string,
  rotationMinImprovementPct: string,
  elapsedMinutes: number | null,
  floatingPnlPct: string | null,
): ResolvedRotationThresholds & { inGracePeriod: boolean; rotationChecksActive: boolean } {
  const graceMinutes = Number(rotationWindowMinutes);
  const configuredMin = rotationMinImprovementPct;
  let effectiveMin = configuredMin;
  let bypassGraceForLoss = false;
  let lossRelaxedMin = false;

  if (floatingPnlPct !== null) {
    const pnl = bn(floatingPnlPct);
    if (pnl.lte(ROTATION_LOSS_BYPASS_PCT)) {
      effectiveMin = '0';
      bypassGraceForLoss = true;
      lossRelaxedMin = true;
    } else if (pnl.lt(0)) {
      effectiveMin = bn(configuredMin).times(LOSS_MIN_IMPROVEMENT_FACTOR).toFixed(4);
      lossRelaxedMin = true;
    }
  }

  const inGracePeriod =
    elapsedMinutes !== null && elapsedMinutes < graceMinutes && !bypassGraceForLoss;
  const rotationChecksActive =
    elapsedMinutes !== null && (elapsedMinutes >= graceMinutes || bypassGraceForLoss);

  return {
    graceMinutes,
    configuredMinImprovementPct: configuredMin,
    effectiveMinImprovementPct: effectiveMin,
    bypassGraceForLoss,
    lossRelaxedMin,
    floatingPnlPct,
    inGracePeriod,
    rotationChecksActive,
  };
}
