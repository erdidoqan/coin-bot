/**
 * Dip Reversal — rejim-adaptasyon (saf/test edilebilir).
 *
 * BTC trend (EMA min-ayrışma) + breadth (birincil risk) + ATR (volatil/grind)
 * ile giriş eşiklerine çarpan uygular. Grid'den izole; paylaşılan detectMarketRegime kullanılmaz.
 */
import type { DipReversalThresholds } from './dip-reversal';

export type DipReversalTrend = 'up' | 'down' | 'flat';

export type DipReversalMode =
  | 'calm'
  | 'volatile'
  | 'normal'
  | 'downtrend_volatile'
  | 'downtrend_grind';

export interface DipReversalAdaptThresholds {
  emaMinSepPct: number;
  calmAtrMax: number;
  volatileAtrMin: number;
  downtrendBreadthMax: number;
  calmDropMult: number;
  dtVolDropMult: number;
  dtVolReversalMult: number;
  dtVolRecoveryMult: number;
  dtGrindDropMult: number;
  dtGrindReversalMult: number;
  dtGrindRecoveryMult: number;
}

export interface DipReversalAdaptContext {
  ema9: number | null;
  ema21: number | null;
  emaSepPct: number | null;
  trend: DipReversalTrend;
  atrPct: number | null;
  breadthPct: number;
  riskOff: boolean;
}

export function classifyDipReversalMode(
  ctx: DipReversalAdaptContext,
  adapt: DipReversalAdaptThresholds,
): DipReversalMode {
  const atr = ctx.atrPct ?? 0;
  const riskOff = ctx.riskOff;
  const inRiskZone = ctx.trend === 'down' || ctx.trend === 'flat';

  if (inRiskZone && riskOff) {
    if (atr < adapt.calmAtrMax) return 'downtrend_grind';
    return 'downtrend_volatile';
  }

  if (ctx.trend !== 'down' && !riskOff && atr < adapt.calmAtrMax) {
    return 'calm';
  }

  if (atr >= adapt.volatileAtrMin) return 'volatile';

  return 'normal';
}

export function resolveTrendFromEma(
  ema9: number | null,
  ema21: number | null,
  emaMinSepPct: number,
): { trend: DipReversalTrend; emaSepPct: number | null } {
  if (ema9 == null || ema21 == null || !(ema21 > 0)) {
    return { trend: 'flat', emaSepPct: null };
  }
  const sepPct = (Math.abs(ema9 - ema21) / ema21) * 100;
  if (sepPct < emaMinSepPct) return { trend: 'flat', emaSepPct: sepPct };
  return {
    trend: ema9 < ema21 ? 'down' : 'up',
    emaSepPct: sepPct,
  };
}

function roundThr(n: number, decimals = 4): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

export function resolveAdaptiveThresholds(
  base: DipReversalThresholds,
  mode: DipReversalMode,
  adapt: DipReversalAdaptThresholds,
): DipReversalThresholds {
  switch (mode) {
    case 'calm':
      return {
        ...base,
        minCapitulationDropPct: roundThr(base.minCapitulationDropPct * adapt.calmDropMult),
      };
    case 'downtrend_volatile':
      return {
        ...base,
        minCapitulationDropPct: roundThr(
          base.minCapitulationDropPct * adapt.dtVolDropMult,
        ),
        minReversalScore: roundThr(base.minReversalScore * adapt.dtVolReversalMult),
        minRecoveryFromLowPct: roundThr(
          base.minRecoveryFromLowPct * adapt.dtVolRecoveryMult,
        ),
      };
    case 'downtrend_grind':
      return {
        ...base,
        minCapitulationDropPct: roundThr(
          base.minCapitulationDropPct * adapt.dtGrindDropMult,
        ),
        minReversalScore: roundThr(base.minReversalScore * adapt.dtGrindReversalMult),
        minRecoveryFromLowPct: roundThr(
          base.minRecoveryFromLowPct * adapt.dtGrindRecoveryMult,
        ),
      };
    case 'volatile':
    case 'normal':
    default:
      return { ...base };
  }
}

export interface AdaptEntryBlockOpts {
  downtrendMode: 'tighten' | 'block';
  /** downtrend_volatile + breadth bu eşiğin altında → giriş yok (risk-off). */
  volatileBlockEnabled?: boolean;
  volatileBlockBreadthMax?: number;
  breadthPct?: number;
}

export type AdaptEntryBlockReason = 'downtrend_grind' | 'volatile_riskoff_breadth';

/** Giriş blok nedeni; yoksa null. */
export function adaptEntryBlockReason(
  mode: DipReversalMode,
  opts: AdaptEntryBlockOpts,
): AdaptEntryBlockReason | null {
  if (mode === 'downtrend_grind' && opts.downtrendMode === 'block') {
    return 'downtrend_grind';
  }
  const breadthMax = opts.volatileBlockBreadthMax ?? 10;
  if (
    opts.volatileBlockEnabled !== false &&
    mode === 'downtrend_volatile' &&
    opts.breadthPct != null &&
    opts.breadthPct < breadthMax
  ) {
    return 'volatile_riskoff_breadth';
  }
  return null;
}

/** Grind+block veya volatile risk-off breadth → giriş kapalı. */
export function adaptBlocksEntry(mode: DipReversalMode, opts: AdaptEntryBlockOpts): boolean {
  return adaptEntryBlockReason(mode, opts) != null;
}
