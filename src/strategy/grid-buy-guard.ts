/**
 * Grid alım koruması — kurulum sonrası readiness / watchlist / anchor drawdown.
 */
import type { GridReadinessResult } from './grid-readiness';
import type { FlashDropLevel } from './grid-flash-drop';
import { anchorDrawdownPct } from './grid-flash-drop';

export const BUY_CANCEL_BLOCKERS = new Set([
  'downside_momentum',
  'hour_decline',
  'medium_downside',
  'flash_drop',
]);

export const DEFAULT_TEARDOWN_READINESS_BLOCKERS = [
  'downside_momentum',
  'hour_decline',
  'flash_drop',
];

export interface GridBuyGuardConfig {
  enabled: boolean;
  cancelOpenOnNotReady: boolean;
  blockNewOnNotReady: boolean;
  cancelAnchorDrawdownPct: number;
  teardownOnReadinessBlockers: boolean;
  teardownReadinessBlockers: Set<string>;
  recenterRequiresReady: boolean;
  useWatchlist: boolean;
}

export interface GridBuyGuardAssessment {
  readiness: GridReadinessResult;
  lastPrice: number;
  inWatchlist: boolean;
  anchorPrice: number;
  anchorDrawdownPct: number;
  flashLevel: FlashDropLevel;
}

export interface GridBuyGuardDecision {
  block: boolean;
  reason: string | null;
}

function parseBlockerCsv(csv: string): Set<string> {
  return new Set(
    csv
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export function parseTeardownReadinessBlockers(csv: string): Set<string> {
  const set = parseBlockerCsv(csv);
  return set.size > 0 ? set : new Set(DEFAULT_TEARDOWN_READINESS_BLOCKERS);
}

function readinessBlockerBlocks(
  readiness: GridReadinessResult,
  blockers: Set<string>,
): boolean {
  if (readiness.ready) return false;
  const id = readiness.primaryBlocker;
  return id != null && blockers.has(id);
}

function anchorDrawdownBlocks(anchorDd: number, thresholdPct: number): boolean {
  return thresholdPct > 0 && anchorDd >= thresholdPct;
}

function watchlistBlocks(inWatchlist: boolean, useWatchlist: boolean): boolean {
  return useWatchlist && !inWatchlist;
}

function evaluateBuyGuard(
  input: GridBuyGuardAssessment,
  cfg: GridBuyGuardConfig,
  blockers: Set<string>,
): GridBuyGuardDecision {
  if (!cfg.enabled) return { block: false, reason: null };

  if (watchlistBlocks(input.inWatchlist, cfg.useWatchlist)) {
    return { block: true, reason: 'not_in_watchlist' };
  }

  if (anchorDrawdownBlocks(input.anchorDrawdownPct, cfg.cancelAnchorDrawdownPct)) {
    return { block: true, reason: 'anchor_drawdown' };
  }

  if (readinessBlockerBlocks(input.readiness, blockers)) {
    return { block: true, reason: input.readiness.primaryBlocker ?? 'not_ready' };
  }

  return { block: false, reason: null };
}

export function shouldCancelOpenGridBuys(
  input: GridBuyGuardAssessment,
  cfg: GridBuyGuardConfig,
): GridBuyGuardDecision {
  if (!cfg.enabled || !cfg.cancelOpenOnNotReady) return { block: false, reason: null };
  return evaluateBuyGuard(input, cfg, BUY_CANCEL_BLOCKERS);
}

export function shouldBlockNewGridBuy(
  input: GridBuyGuardAssessment,
  cfg: GridBuyGuardConfig,
): GridBuyGuardDecision {
  if (!cfg.enabled || !cfg.blockNewOnNotReady) return { block: false, reason: null };
  return evaluateBuyGuard(input, cfg, BUY_CANCEL_BLOCKERS);
}

export function shouldTeardownForReadiness(
  input: GridBuyGuardAssessment,
  cfg: GridBuyGuardConfig,
): GridBuyGuardDecision {
  if (!cfg.enabled || !cfg.teardownOnReadinessBlockers) {
    return { block: false, reason: null };
  }
  if (readinessBlockerBlocks(input.readiness, cfg.teardownReadinessBlockers)) {
    return { block: true, reason: input.readiness.primaryBlocker ?? 'not_ready' };
  }
  return { block: false, reason: null };
}

export function shouldSkipRecenterForReadiness(
  input: GridBuyGuardAssessment,
  cfg: GridBuyGuardConfig,
): GridBuyGuardDecision {
  if (!cfg.enabled || !cfg.recenterRequiresReady) return { block: false, reason: null };
  if (!input.readiness.ready) {
    return { block: true, reason: input.readiness.primaryBlocker ?? 'not_ready' };
  }
  return { block: false, reason: null };
}

export function buildAssessmentLogPayload(
  input: GridBuyGuardAssessment,
): Record<string, unknown> {
  const failedGates = input.readiness.gates.filter((g) => !g.pass).map((g) => g.id);
  return {
    score: Number(input.readiness.score.toFixed(2)),
    ready: input.readiness.ready,
    primaryBlocker: input.readiness.primaryBlocker,
    failedGates,
    lastPrice: input.lastPrice,
    inWatchlist: input.inWatchlist,
    anchorPrice: input.anchorPrice,
    anchorDrawdownPct: Number(input.anchorDrawdownPct.toFixed(4)),
    flashLevel: input.flashLevel,
  };
}

export function buildGridBuyGuardAssessment(input: {
  readiness: GridReadinessResult;
  lastPrice: number;
  inWatchlist: boolean;
  anchorPrice: number;
  flashLevel: FlashDropLevel;
}): GridBuyGuardAssessment {
  return {
    readiness: input.readiness,
    lastPrice: input.lastPrice,
    inWatchlist: input.inWatchlist,
    anchorPrice: input.anchorPrice,
    anchorDrawdownPct: anchorDrawdownPct(input.anchorPrice, input.lastPrice),
    flashLevel: input.flashLevel,
  };
}

export function buyGuardConfigFromGrid(cfg: {
  rangeMode: 'auto' | 'manual';
  buyGuardEnabled: boolean;
  buyCancelOpenOnNotReady: boolean;
  buyBlockNewOnNotReady: boolean;
  buyCancelAnchorDrawdownPct: number;
  buyLogAssessment: boolean;
  teardownOnReadinessBlockers: boolean;
  teardownReadinessBlockersCsv: string;
  recenterRequiresReady: boolean;
  useWatchlist: boolean;
}): GridBuyGuardConfig {
  const manual = cfg.rangeMode === 'manual';
  return {
    enabled: !manual && cfg.buyGuardEnabled,
    cancelOpenOnNotReady: cfg.buyCancelOpenOnNotReady,
    blockNewOnNotReady: cfg.buyBlockNewOnNotReady,
    cancelAnchorDrawdownPct: cfg.buyCancelAnchorDrawdownPct,
    teardownOnReadinessBlockers: cfg.teardownOnReadinessBlockers,
    teardownReadinessBlockers: parseTeardownReadinessBlockers(cfg.teardownReadinessBlockersCsv),
    recenterRequiresReady: cfg.recenterRequiresReady,
    useWatchlist: cfg.useWatchlist,
  };
}
