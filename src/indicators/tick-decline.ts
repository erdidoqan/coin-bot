import { bn } from '../math/decimal';

export interface MidSample {
  t: number;
  mid: number;
}

export interface TickDeclineConfig {
  /** bookTicker mid örnekleri — bu kadar saniye geriye bak */
  referenceWindowSec: number;
  /** Pencerede tepe→dip min düşüş (%) */
  minDeclinePct: string;
  requireWsDecline: boolean;
  /** Pencere süresinin en az bu oranında örnek olmalı */
  minSampleSpanRatio: number;
}

export interface TickDeclineEvaluation {
  ok: boolean;
  failReason: string | null;
  declinePct: string | null;
  windowHigh: string | null;
  windowLow: string | null;
  troughTimeMs: number | null;
  sampleCount: number;
  windowSpanMs: number;
}

const SAMPLE_INTERVAL_MS = 1000;

/** WS mid geçmişine örnek ekle (en fazla ~1/sn). */
export function appendMidSample(
  samples: MidSample[],
  mid: number,
  nowMs: number,
  maxRetentionMs: number,
): MidSample[] {
  if (!Number.isFinite(mid) || mid <= 0) return samples;
  const next = [...samples];
  const last = next[next.length - 1];
  if (last && nowMs - last.t < SAMPLE_INTERVAL_MS) {
    last.mid = mid;
  } else {
    next.push({ t: nowMs, mid });
  }
  const cutoff = nowMs - maxRetentionMs;
  return next.filter((s) => s.t >= cutoff);
}

/**
 * Pencerede önce tepe sonra dip (WS düşüş), ardından mevcut mid dip üstünde (toparlanma).
 * Giriş bandı ayrıca 1m low’dan ölçülür.
 */
export function evaluateWsDecline(input: {
  samples: MidSample[];
  currentMid: string | number;
  config: TickDeclineConfig;
  nowMs?: number;
}): TickDeclineEvaluation {
  const nowMs = input.nowMs ?? Date.now();
  const empty: TickDeclineEvaluation = {
    ok: false,
    failReason: null,
    declinePct: null,
    windowHigh: null,
    windowLow: null,
    troughTimeMs: null,
    sampleCount: 0,
    windowSpanMs: 0,
  };

  if (!input.config.requireWsDecline) {
    return { ...empty, ok: true };
  }

  const windowMs = input.config.referenceWindowSec * 1000;
  const minSpanMs = windowMs * input.config.minSampleSpanRatio;
  const inWindow = input.samples.filter((s) => nowMs - s.t <= windowMs);
  empty.sampleCount = inWindow.length;

  if (inWindow.length < 3) {
    return { ...empty, failReason: 'insufficient_ws_samples' };
  }

  const spanMs = inWindow[inWindow.length - 1]!.t - inWindow[0]!.t;
  empty.windowSpanMs = spanMs;
  if (spanMs < minSpanMs) {
    return { ...empty, failReason: 'ws_window_too_short' };
  }

  let highSample = inWindow[0]!;
  let lowSample = inWindow[0]!;
  for (const s of inWindow) {
    if (s.mid > highSample.mid) highSample = s;
    if (s.mid < lowSample.mid) lowSample = s;
  }

  const high = bn(highSample.mid);
  const low = bn(lowSample.mid);
  if (high.lte(0)) {
    return { ...empty, failReason: 'invalid_ws_high' };
  }

  const declinePct = high.minus(low).dividedBy(high).times(100).toFixed(4);
  empty.declinePct = declinePct;
  empty.windowHigh = high.toFixed(8);
  empty.windowLow = low.toFixed(8);
  empty.troughTimeMs = lowSample.t;

  if (bn(declinePct).lt(input.config.minDeclinePct)) {
    return { ...empty, failReason: 'decline_too_shallow' };
  }

  if (highSample.t > lowSample.t) {
    return { ...empty, failReason: 'no_peak_before_trough' };
  }

  const mid = bn(input.currentMid);
  if (!mid.isFinite() || mid.lte(0)) {
    return { ...empty, failReason: 'no_mid' };
  }

  if (mid.lte(low)) {
    return { ...empty, failReason: 'still_at_ws_low' };
  }

  return { ...empty, ok: true, failReason: null };
}

export function defaultTickDeclineConfig(): TickDeclineConfig {
  return {
    referenceWindowSec: 120,
    minDeclinePct: '0.08',
    requireWsDecline: true,
    minSampleSpanRatio: 0.5,
  };
}
