import type { MidSample } from './tick-decline';
import { bn } from '../math/decimal';

export interface TickReversalConfig {
  recoveryMinPct: string;
  midSlopeSampleCount: number;
  midSlopeMinRising: number;
  noNewLowSec: number;
  minSecAfterTrough: number;
  maxSecAfterTrough: number;
  requireSpreadTightening: boolean;
  obRatioAtRecoveryMin: string;
  /** Komisyon sonrası min recovery (fee + margin); config recoveryMin ile max alınır */
  feeRoundtripPct?: string;
  recoveryFeeMarginPct?: string;
}

export interface TickReversalObContext {
  spreadPct: number;
  spreadPctPrev: number | null;
  spreadHistory: number[];
  bidAskRatio: number;
  bidAskRatioAtTrough: number | null;
}

export interface TickReversalEvaluation {
  ok: boolean;
  failReason: string | null;
  recoveryFromWsLowPct: string | null;
  midSlopeOk: boolean;
  midSlopeStrength: number;
  secSinceTrough: number | null;
  reversalScore: number;
  spreadTighteningOk: boolean;
  obRecoveryOk: boolean;
}

export function recoveryFromLowPct(windowLow: string, mid: string): string | null {
  const low = bn(windowLow);
  if (low.lte(0)) return null;
  const m = bn(mid);
  if (!m.isFinite() || m.lte(0)) return null;
  return m.minus(low).dividedBy(low).times(100).toFixed(4);
}

export function countRisingMidSamples(samples: MidSample[], count: number): {
  rising: number;
  strength: number;
} {
  if (samples.length < 2) return { rising: 0, strength: 0 };
  const tail = samples.slice(-count);
  let rising = 0;
  for (let i = 1; i < tail.length; i++) {
    if (tail[i]!.mid > tail[i - 1]!.mid) rising++;
  }
  const strength = tail.length > 1 ? rising / (tail.length - 1) : 0;
  return { rising, strength };
}

export function effectiveRecoveryMinPct(config: TickReversalConfig): string {
  const base = bn(config.recoveryMinPct);
  if (!config.feeRoundtripPct) return config.recoveryMinPct;
  const floor = bn(config.feeRoundtripPct).plus(config.recoveryFeeMarginPct ?? '0.05');
  return (base.gt(floor) ? base : floor).toFixed(4);
}

export function scoreFromPartial(partial: {
  recoveryFromWsLowPct?: string | null;
  midSlopeStrength?: number;
  spreadTighteningOk?: boolean;
  obRecoveryOk?: boolean;
  ob?: TickReversalObContext;
}): number {
  const recoveryN = partial.recoveryFromWsLowPct
    ? Number(partial.recoveryFromWsLowPct)
    : 0;
  const obBonus =
    partial.obRecoveryOk && partial.ob
      ? Math.max(0, partial.ob.bidAskRatio - (partial.ob.bidAskRatioAtTrough ?? 1))
      : 0;
  return computeReversalScore({
    recoveryPct: Number.isFinite(recoveryN) ? recoveryN : 0,
    midSlopeStrength: partial.midSlopeStrength ?? 0,
    obBonus,
    spreadPenalty: partial.spreadTighteningOk === false ? 0.1 : 0,
  });
}

export function evaluateTickReversal(input: {
  samples: MidSample[];
  currentMid: string;
  windowLow: string;
  troughTimeMs: number;
  config: TickReversalConfig;
  ob?: TickReversalObContext;
  nowMs?: number;
}): TickReversalEvaluation {
  const nowMs = input.nowMs ?? Date.now();
  const recoveryFloor = effectiveRecoveryMinPct(input.config);
  const fail = (
    failReason: string,
    partial: Partial<TickReversalEvaluation> = {},
  ): TickReversalEvaluation => {
    const score = scoreFromPartial({
      recoveryFromWsLowPct: partial.recoveryFromWsLowPct,
      midSlopeStrength: partial.midSlopeStrength,
      spreadTighteningOk: partial.spreadTighteningOk,
      obRecoveryOk: partial.obRecoveryOk,
      ob: input.ob,
    });
    return {
      ok: false,
      failReason,
      recoveryFromWsLowPct: null,
      midSlopeOk: false,
      midSlopeStrength: 0,
      secSinceTrough: null,
      reversalScore: score,
      spreadTighteningOk: false,
      obRecoveryOk: false,
      ...partial,
    };
  };

  const mid = bn(input.currentMid);
  if (!mid.isFinite() || mid.lte(0)) {
    return fail('no_mid');
  }

  const recoveryPct = recoveryFromLowPct(input.windowLow, input.currentMid);
  if (!recoveryPct || bn(recoveryPct).lt(recoveryFloor)) {
    return fail('recovery_too_shallow', { recoveryFromWsLowPct: recoveryPct });
  }

  const secSinceTrough = Math.max(0, (nowMs - input.troughTimeMs) / 1000);
  if (secSinceTrough < input.config.minSecAfterTrough) {
    return fail('too_early_after_trough', {
      recoveryFromWsLowPct: recoveryPct,
      secSinceTrough,
    });
  }
  if (secSinceTrough > input.config.maxSecAfterTrough) {
    return fail('too_late_after_trough', {
      recoveryFromWsLowPct: recoveryPct,
      secSinceTrough,
    });
  }

  const lowBn = bn(input.windowLow);
  const epsilon = lowBn.times('0.00005');
  const noNewLowCutoff = nowMs - input.config.noNewLowSec * 1000;
  const recent = input.samples.filter((s) => s.t >= noNewLowCutoff);
  for (const s of recent) {
    if (bn(s.mid).lt(lowBn.plus(epsilon))) {
      return fail('new_low_after_trough', {
        recoveryFromWsLowPct: recoveryPct,
        secSinceTrough,
      });
    }
  }

  const slope = countRisingMidSamples(input.samples, input.config.midSlopeSampleCount);
  const midSlopeOk = slope.rising >= input.config.midSlopeMinRising;
  if (!midSlopeOk) {
    return fail('mid_slope_negative', {
      recoveryFromWsLowPct: recoveryPct,
      secSinceTrough,
      midSlopeStrength: slope.strength,
    });
  }

  let spreadTighteningOk = true;
  let obRecoveryOk = true;
  if (input.ob) {
    if (input.config.requireSpreadTightening) {
      const prev = input.ob.spreadPctPrev;
      const hist = input.ob.spreadHistory;
      const avgHist =
        hist.length >= 2
          ? hist.reduce((a, b) => a + b, 0) / hist.length
          : prev ?? input.ob.spreadPct;
      spreadTighteningOk =
        input.ob.spreadPct <= (prev ?? avgHist) || input.ob.spreadPct <= avgHist;
      if (!spreadTighteningOk) {
        return fail('spread_not_tightening', {
          recoveryFromWsLowPct: recoveryPct,
          secSinceTrough,
          midSlopeOk: true,
          midSlopeStrength: slope.strength,
          spreadTighteningOk: false,
        });
      }
    }

    const troughRatio = input.ob.bidAskRatioAtTrough;
    if (troughRatio != null && troughRatio > 0) {
      const minRatio = bn(troughRatio).times(input.config.obRatioAtRecoveryMin);
      obRecoveryOk = bn(input.ob.bidAskRatio).gte(minRatio);
      if (!obRecoveryOk) {
        return fail('ob_weak_at_recovery', {
          recoveryFromWsLowPct: recoveryPct,
          secSinceTrough,
          midSlopeOk: true,
          midSlopeStrength: slope.strength,
          spreadTighteningOk,
          obRecoveryOk: false,
        });
      }
    }
  }

  const recoveryN = Number(recoveryPct);
  const reversalScore = computeReversalScore({
    recoveryPct: recoveryN,
    midSlopeStrength: slope.strength,
    obBonus: obRecoveryOk && input.ob ? Math.max(0, input.ob.bidAskRatio - (input.ob.bidAskRatioAtTrough ?? 1)) : 0,
    spreadPenalty: spreadTighteningOk ? 0 : 0.1,
  });

  return {
    ok: true,
    failReason: null,
    recoveryFromWsLowPct: recoveryPct,
    midSlopeOk: true,
    midSlopeStrength: slope.strength,
    secSinceTrough,
    reversalScore,
    spreadTighteningOk,
    obRecoveryOk,
  };
}

export function computeReversalScore(parts: {
  recoveryPct: number;
  midSlopeStrength: number;
  scoutAlignment?: number;
  obBonus?: number;
  spreadPenalty?: number;
}): number {
  const scout = parts.scoutAlignment ?? 0;
  const ob = parts.obBonus ?? 0;
  const penalty = parts.spreadPenalty ?? 0;
  return (
    parts.recoveryPct * 3 +
    parts.midSlopeStrength * 2 +
    scout * 1 +
    ob * 1 -
    penalty
  );
}

export function scoutAlignmentScore(scoutVsFillPct: string | null, capPct: number): number {
  if (scoutVsFillPct == null) return 0.5;
  const abs = Math.min(Math.abs(Number(scoutVsFillPct)), capPct);
  if (Number.isNaN(abs)) return 0.5;
  return Math.max(0, 1 - abs / capPct);
}

export function passesScoutPriceBand(
  scoutPrice: string,
  referencePrice: string,
  maxBelowPct: string,
  maxAbovePct: string,
): { ok: boolean; failReason: string | null; scoutVsFillPct: string | null } {
  const scout = bn(scoutPrice);
  const ref = bn(referencePrice);
  if (scout.lte(0) || ref.lte(0)) {
    return { ok: true, failReason: null, scoutVsFillPct: null };
  }
  const pct = ref.minus(scout).dividedBy(scout).times(100).toFixed(4);
  if (bn(pct).lt(bn(maxBelowPct).negated())) {
    return { ok: false, failReason: 'scout_price_too_far_below', scoutVsFillPct: pct };
  }
  if (bn(pct).gt(maxAbovePct)) {
    return { ok: false, failReason: 'scout_price_too_far_above', scoutVsFillPct: pct };
  }
  return { ok: true, failReason: null, scoutVsFillPct: pct };
}

export function defaultTickReversalConfig(): TickReversalConfig {
  return {
    recoveryMinPct: '0.05',
    midSlopeSampleCount: 5,
    midSlopeMinRising: 3,
    noNewLowSec: 30,
    minSecAfterTrough: 10,
    maxSecAfterTrough: 45,
    requireSpreadTightening: true,
    obRatioAtRecoveryMin: '1.0',
  };
}
