/**
 * Flash Drop Guard — kısa vadeli ani düşüş tespiti (saf, test edilebilir).
 *
 * Grid açıkken anchor'dan drawdown, kline penceresi düşüşü ve alış fırtınası
 * ile WARN / PAUSE / RECOVERY seviyeleri üretir.
 */
import { bn } from '../math/decimal';

export type FlashDropLevel = 'none' | 'warn' | 'pause' | 'recovery';

export interface FlashDropConfig {
  enabled: boolean;
  warnPct: number;
  pausePct: number;
  recoveryPct: number;
  windowMin: number;
  maxFills: number;
  fillWindowMin: number;
  investmentOverfillMult: number;
}

export interface FlashDropFilledBuy {
  qty: number;
  price: number;
  atMs: number;
}

export interface FlashDropInput {
  anchorPrice: number;
  lastPrice: number;
  klineCloses: number[];
  recentFilledBuys: FlashDropFilledBuy[];
  filledBuyCostUsdt: number;
  investmentUsdt: number;
  nowMs: number;
  cfg: FlashDropConfig;
}

export interface FlashDropResult {
  level: FlashDropLevel;
  reasons: string[];
  metrics: {
    anchorDrawdownPct: number;
    windowDropPct: number;
    fillCountInWindow: number;
    filledBuyCostUsdt: number;
    investmentUsdt: number;
  };
}

const LEVEL_RANK: Record<FlashDropLevel, number> = {
  none: 0,
  warn: 1,
  pause: 2,
  recovery: 3,
};

function maxLevel(a: FlashDropLevel, b: FlashDropLevel): FlashDropLevel {
  return LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b;
}

/** Son windowMin dakikadaki 5m kapanışlardan tepe → last düşüş %. */
export function windowDropPctFromCloses(
  closes: number[],
  lastPrice: number,
  windowMin: number,
): number {
  if (closes.length === 0 || !(lastPrice > 0) || windowMin <= 0) return 0;
  const bars = Math.max(1, Math.ceil(windowMin / 5));
  const slice = closes.slice(-bars);
  const peak = Math.max(...slice, lastPrice);
  if (!(peak > 0)) return 0;
  const drop = ((peak - lastPrice) / peak) * 100;
  return drop > 0 ? drop : 0;
}

export function anchorDrawdownPct(anchorPrice: number, lastPrice: number): number {
  if (!(anchorPrice > 0) || !(lastPrice > 0)) return 0;
  if (lastPrice >= anchorPrice) return 0;
  return ((anchorPrice - lastPrice) / anchorPrice) * 100;
}

function countFillsInWindow(
  buys: FlashDropFilledBuy[],
  fillWindowMin: number,
  nowMs: number,
): number {
  const cutoff = nowMs - fillWindowMin * 60_000;
  return buys.filter((b) => b.atMs >= cutoff).length;
}

/** Fill penceresinde fiyat düşüyor mu? (ilk fill fiyatı > lastPrice). */
function fillsWhilePriceFalling(
  buys: FlashDropFilledBuy[],
  fillWindowMin: number,
  lastPrice: number,
  nowMs: number,
): boolean {
  const cutoff = nowMs - fillWindowMin * 60_000;
  const inWindow = buys.filter((b) => b.atMs >= cutoff);
  if (inWindow.length === 0) return false;
  const first = inWindow.reduce((a, b) => (a.atMs <= b.atMs ? a : b));
  return first.price > lastPrice;
}

export function evaluateFlashDrop(input: FlashDropInput): FlashDropResult {
  const emptyMetrics = {
    anchorDrawdownPct: 0,
    windowDropPct: 0,
    fillCountInWindow: 0,
    filledBuyCostUsdt: input.filledBuyCostUsdt,
    investmentUsdt: input.investmentUsdt,
  };

  if (!input.cfg.enabled) {
    return { level: 'none', reasons: [], metrics: emptyMetrics };
  }

  const anchorDd = anchorDrawdownPct(input.anchorPrice, input.lastPrice);
  const winDrop = windowDropPctFromCloses(
    input.klineCloses,
    input.lastPrice,
    input.cfg.windowMin,
  );
  const fillCount = countFillsInWindow(
    input.recentFilledBuys,
    input.cfg.fillWindowMin,
    input.nowMs,
  );
  const fillStorm =
    fillCount >= input.cfg.maxFills &&
    fillsWhilePriceFalling(
      input.recentFilledBuys,
      input.cfg.fillWindowMin,
      input.lastPrice,
      input.nowMs,
    );

  const metrics = {
    anchorDrawdownPct: anchorDd,
    windowDropPct: winDrop,
    fillCountInWindow: fillCount,
    filledBuyCostUsdt: input.filledBuyCostUsdt,
    investmentUsdt: input.investmentUsdt,
  };

  const overfill =
    input.investmentUsdt > 0 &&
    input.filledBuyCostUsdt >
      input.investmentUsdt * input.cfg.investmentOverfillMult;

  let level: FlashDropLevel = 'none';
  const reasons: string[] = [];

  if (anchorDd >= input.cfg.warnPct) {
    level = maxLevel(level, 'warn');
    reasons.push(`anchor_drawdown_${anchorDd.toFixed(2)}pct`);
  }
  if (winDrop >= input.cfg.warnPct) {
    level = maxLevel(level, 'warn');
    reasons.push(`window_drop_${winDrop.toFixed(2)}pct`);
  }

  if (
    anchorDd >= input.cfg.pausePct ||
    winDrop >= input.cfg.pausePct ||
    fillStorm
  ) {
    level = maxLevel(level, 'pause');
    if (anchorDd >= input.cfg.pausePct) reasons.push(`anchor_pause_${anchorDd.toFixed(2)}pct`);
    if (winDrop >= input.cfg.pausePct) reasons.push(`window_pause_${winDrop.toFixed(2)}pct`);
    if (fillStorm) reasons.push(`fill_storm_${fillCount}`);
  }

  if (anchorDd >= input.cfg.recoveryPct || overfill) {
    level = 'recovery';
    if (anchorDd >= input.cfg.recoveryPct) {
      reasons.push(`anchor_recovery_${anchorDd.toFixed(2)}pct`);
    }
    if (overfill) {
      reasons.push(
        `overfill_cost_${input.filledBuyCostUsdt.toFixed(2)}_vs_${bn(input.investmentUsdt).times(input.cfg.investmentOverfillMult).toFixed(2)}`,
      );
    }
  }

  return { level, reasons: [...new Set(reasons)], metrics };
}

export function flashDropBlocksBuys(level: FlashDropLevel): boolean {
  return level === 'warn' || level === 'pause' || level === 'recovery';
}

/** Scout / aday uygunluk: yalnızca flash yokken hazır. */
export function scoutFlashAllowsReady(level: FlashDropLevel): boolean {
  return level === 'none';
}

/** Kurulum öncesi flash (envanter yok, anchor = güncel fiyat). */
export function evaluateFlashDropForScout(input: {
  lastPrice: number;
  klineCloses: number[];
  cfg: FlashDropConfig;
  nowMs?: number;
}): FlashDropResult {
  return evaluateFlashDrop({
    anchorPrice: input.lastPrice,
    lastPrice: input.lastPrice,
    klineCloses: input.klineCloses,
    recentFilledBuys: [],
    filledBuyCostUsdt: 0,
    investmentUsdt: 1,
    nowMs: input.nowMs ?? Date.now(),
    cfg: input.cfg,
  });
}

/** Sıralama için yumuşak skor cezası (ready zaten false olabilir). */
export function applyScoutScorePenalty(
  score: number,
  flash: FlashDropResult,
): number {
  let s = score;
  if (flash.metrics.windowDropPct > 0) {
    s = Math.max(0, s - flash.metrics.windowDropPct * 2);
  }
  if (flash.level === 'warn') s *= 0.5;
  return Number(s.toFixed(2));
}

export function flashDropConfigFromGrid(cfg: {
  flashDropEnabled: boolean;
  flashDropWarnPct: number;
  flashDropPausePct: number;
  flashDropRecoveryPct: number;
  flashDropWindowMin: number;
  flashDropMaxFills: number;
  flashDropFillWindowMin: number;
  flashDropOverfillMult: number;
}): FlashDropConfig {
  return {
    enabled: cfg.flashDropEnabled,
    warnPct: cfg.flashDropWarnPct,
    pausePct: cfg.flashDropPausePct,
    recoveryPct: cfg.flashDropRecoveryPct,
    windowMin: cfg.flashDropWindowMin,
    maxFills: cfg.flashDropMaxFills,
    fillWindowMin: cfg.flashDropFillWindowMin,
    investmentOverfillMult: cfg.flashDropOverfillMult,
  };
}

export function gridAnchorPrice(
  grid: { lower_price: string; upper_price: string; anchor_price?: string | null },
  fallbackLastPrice?: number,
): number {
  const stored = grid.anchor_price != null ? Number(grid.anchor_price) : 0;
  if (Number.isFinite(stored) && stored > 0) return stored;
  const lower = Number(grid.lower_price);
  const upper = Number(grid.upper_price);
  if (upper > lower && lower >= 0) return (lower + upper) / 2;
  if (fallbackLastPrice != null && fallbackLastPrice > 0) return fallbackLastPrice;
  return 0;
}
