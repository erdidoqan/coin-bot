import type { Kline } from '../exchange/binance';
import { bn } from '../math/decimal';

export interface ContinuationWindowSpec {
  label: string;
  interval: string;
  limit: number;
  mode: 'triple' | 'lastPair' | 'ten5m';
}

export const CONTINUATION_WINDOWS: ContinuationWindowSpec[] = [
  { label: '1h', interval: '1h', limit: 3, mode: 'triple' },
  { label: '30m', interval: '30m', limit: 3, mode: 'triple' },
  { label: '15m', interval: '15m', limit: 3, mode: 'triple' },
  { label: '10m', interval: '5m', limit: 3, mode: 'ten5m' },
  { label: '5m', interval: '5m', limit: 2, mode: 'lastPair' },
  { label: '1m', interval: '1m', limit: 2, mode: 'lastPair' },
];

export const SHORT_TF_LABELS = new Set(['5m', '10m', '1m']);

export interface ContinuationWindowResult {
  label: string;
  interval: string;
  priorLegPct: string;
  pullbackPct: string;
  recoveryPct: string;
  passed: boolean;
  failReason: string | null;
}

export interface ContinuationConfig {
  minRecoveryPct: string;
  maxPullbackPct: string;
  minGreenWindows: number;
  requireShortTf: boolean;
}

function candleGainPct(open: string, close: string): string | null {
  const o = bn(open);
  if (o.isZero()) return null;
  return bn(close).minus(o).dividedBy(o).times(100).toFixed(4);
}

function evaluatePullbackRecovery(
  pullbackPct: string,
  recoveryPct: string,
  config: ContinuationConfig,
): { passed: boolean; failReason: string | null } {
  if (bn(pullbackPct).gt(config.maxPullbackPct)) {
    return { passed: false, failReason: 'pullback_too_large' };
  }
  if (bn(recoveryPct).lt(config.minRecoveryPct)) {
    return { passed: false, failReason: 'recovery_weak' };
  }
  if (bn(pullbackPct).gt(0)) {
    return { passed: false, failReason: 'no_pullback' };
  }
  return { passed: true, failReason: null };
}

/** 3 mum: [0] itki → [1] esneme → [2] toparlanma */
export function analyzeTripleContinuation(
  klines: Kline[],
  label: string,
  interval: string,
  config: ContinuationConfig,
): ContinuationWindowResult | null {
  if (klines.length < 3) return null;

  const c0 = klines[0]!;
  const c1 = klines[1]!;
  const c2 = klines[2]!;

  const priorLegPct = candleGainPct(c0.open, c1.close) ?? '0';
  const pullbackPct = candleGainPct(c1.open, c1.close) ?? '0';
  const recoveryPct = candleGainPct(c2.open, c2.close) ?? '0';
  const { passed, failReason } = evaluatePullbackRecovery(pullbackPct, recoveryPct, config);

  return {
    label,
    interval,
    priorLegPct,
    pullbackPct,
    recoveryPct,
    passed,
    failReason,
  };
}

/** Son iki mum: önceki esneme, son toparlanma (5m / 1m). */
export function analyzeLastPairContinuation(
  klines: Kline[],
  label: string,
  interval: string,
  config: ContinuationConfig,
): ContinuationWindowResult | null {
  if (klines.length < 2) return null;

  const prev = klines[klines.length - 2]!;
  const last = klines[klines.length - 1]!;

  const pullbackPct = candleGainPct(prev.open, prev.close) ?? '0';
  const recoveryPct = candleGainPct(last.open, last.close) ?? '0';
  const priorLegPct = pullbackPct;
  const { passed, failReason } = evaluatePullbackRecovery(pullbackPct, recoveryPct, config);

  return {
    label,
    interval,
    priorLegPct,
    pullbackPct,
    recoveryPct,
    passed,
    failReason,
  };
}

export function analyzeTen5mContinuation(
  klines: Kline[],
  config: ContinuationConfig,
): ContinuationWindowResult | null {
  const r = analyzeTripleContinuation(klines, '10m', '5m', config);
  if (!r) return null;
  return { ...r, label: '10m' };
}

export function aggregateContinuation(
  windows: ContinuationWindowResult[],
  config: ContinuationConfig,
): {
  windows: ContinuationWindowResult[];
  greenCount: number;
  continuationScore: string;
  avgRecoveryPct: string;
  entryEligible: boolean;
  continuationPassed: boolean;
  failReason: string | null;
} {
  const passedWindows = windows.filter((w) => w.passed);
  const greenCount = passedWindows.length;

  const allRecoveries = windows.map((w) => bn(w.recoveryPct));
  const avgRecoveryPct =
    allRecoveries.length > 0
      ? allRecoveries
          .reduce((a, g) => a.plus(g), bn(0))
          .dividedBy(allRecoveries.length)
          .toFixed(4)
      : '0';

  let entryScore = '0';
  if (passedWindows.length > 0) {
    const sum = passedWindows.reduce((a, w) => a.plus(w.recoveryPct), bn(0));
    entryScore = sum.dividedBy(passedWindows.length).toFixed(4);
  }

  const shortTfOk =
    !config.requireShortTf ||
    windows.some((w) => SHORT_TF_LABELS.has(w.label) && w.passed);

  const entryEligible = greenCount >= config.minGreenWindows && shortTfOk;
  const continuationPassed = entryEligible;

  let failReason: string | null = null;
  if (!entryEligible) {
    if (greenCount < config.minGreenWindows) failReason = 'insufficient_green_windows';
    else if (!shortTfOk) failReason = 'short_tf_required';
  }

  return {
    windows,
    greenCount,
    /** Giriş skoru: yalnızca geçen pencereler (bot). */
    continuationScore: entryScore,
    /** Sıralama / dashboard: tüm pencerelerin recovery ortalaması. */
    avgRecoveryPct,
    entryEligible,
    continuationPassed,
    failReason,
  };
}
