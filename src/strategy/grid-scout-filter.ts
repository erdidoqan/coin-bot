/**
 * Grid scout ön filtresi — watchlist'e yazmadan önce aşırı volatil / flash adayları eler.
 */
import {
  evaluateFlashDropForScout,
  flashDropConfigFromGrid,
  scoutFlashAllowsReady,
  type FlashDropConfig,
} from './grid-flash-drop';
import { hourContinuousDeclineBlocked } from './grid-readiness';

export interface ScoutTickerRow {
  symbol: string;
  quoteVolume: number;
  priceChangePercent: number;
  highPrice: number;
  lowPrice: number;
  lastPrice: number;
}

export interface ScoutRiskFilterConfig {
  enabled: boolean;
  maxAbsChangePct: number;
  /** 24s tepe–dip % alt sınır (readiness range_width_min ile aynı). */
  minRange24hPct: number;
  /** 24s tepe–dip % üst sınır (readiness range_width_max ile aynı). */
  maxRange24hPct: number;
  flashEnabled: boolean;
  flashCfg: FlashDropConfig;
  /** Piyasa düşüş modu aktifken zayıf 24s coinleri eler. */
  downturnActive?: boolean;
  minChangePctInDownturn?: number;
  /** Son N×5m üst üste düşüş — watchlist dışı (0=kapalı). */
  hourDeclineEnabled?: boolean;
  hourDeclineBars?: number;
}

export function ticker24hRangePct(high: number, low: number): number | null {
  if (!(high > 0) || !(low > 0) || high < low) return null;
  const mid = (high + low) / 2;
  return mid > 0 ? ((high - low) / mid) * 100 : null;
}

export function passesScoutTickerRisk(
  t: ScoutTickerRow,
  cfg: ScoutRiskFilterConfig,
): { pass: boolean; reason: string | null } {
  if (!cfg.enabled) return { pass: true, reason: null };

  if (
    cfg.downturnActive &&
    cfg.minChangePctInDownturn != null &&
    t.priceChangePercent < cfg.minChangePctInDownturn
  ) {
    return { pass: false, reason: 'market_downturn_weak_symbol' };
  }

  if (cfg.maxAbsChangePct > 0) {
    const absCh = Math.abs(t.priceChangePercent);
    if (absCh > cfg.maxAbsChangePct) {
      return { pass: false, reason: `change_${absCh.toFixed(1)}pct` };
    }
  }

  if (cfg.minRange24hPct > 0 || cfg.maxRange24hPct > 0) {
    const rw = ticker24hRangePct(t.highPrice, t.lowPrice);
    if (rw == null) {
      return { pass: false, reason: 'range24h_missing' };
    }
    if (cfg.minRange24hPct > 0 && rw < cfg.minRange24hPct) {
      return { pass: false, reason: `range24h_narrow_${rw.toFixed(1)}pct` };
    }
    if (cfg.maxRange24hPct > 0 && rw > cfg.maxRange24hPct) {
      return { pass: false, reason: `range24h_wide_${rw.toFixed(1)}pct` };
    }
  }

  return { pass: true, reason: null };
}

export function passesScoutHourDeclineKlines(
  closes: number[],
  cfg: ScoutRiskFilterConfig,
): { pass: boolean; reason: string | null } {
  const bars = cfg.hourDeclineBars ?? 0;
  if (!cfg.enabled || !cfg.hourDeclineEnabled || bars < 2) {
    return { pass: true, reason: null };
  }
  if (closes.length < bars) {
    return { pass: true, reason: null };
  }
  if (hourContinuousDeclineBlocked(closes, bars)) {
    return { pass: false, reason: 'hour_decline' };
  }
  return { pass: true, reason: null };
}

export function passesScoutFlashKlines(
  closes: number[],
  lastPrice: number,
  cfg: ScoutRiskFilterConfig,
): { pass: boolean; reason: string | null; level: string } {
  if (!cfg.enabled || !cfg.flashEnabled) {
    return { pass: true, reason: null, level: 'none' };
  }
  const flash = evaluateFlashDropForScout({
    lastPrice,
    klineCloses: closes,
    cfg: cfg.flashCfg,
  });
  if (!scoutFlashAllowsReady(flash.level)) {
    return {
      pass: false,
      reason: `flash_${flash.level}`,
      level: flash.level,
    };
  }
  return { pass: true, reason: null, level: flash.level };
}

export function scoutRiskConfigFromGrid(cfg: {
  scoutRiskFilterEnabled: boolean;
  scoutMaxAbsChangePct: number;
  minRangeWidthPct: number;
  maxRangeWidthPct: number;
  flashDropEnabled: boolean;
  flashDropWarnPct: number;
  flashDropPausePct: number;
  flashDropRecoveryPct: number;
  flashDropWindowMin: number;
  flashDropMaxFills: number;
  flashDropFillWindowMin: number;
  flashDropOverfillMult: number;
  readinessHourDeclineEnabled: boolean;
  readinessHourDeclineBars: number;
}): ScoutRiskFilterConfig {
  return {
    enabled: cfg.scoutRiskFilterEnabled,
    maxAbsChangePct: cfg.scoutMaxAbsChangePct,
    minRange24hPct: cfg.minRangeWidthPct,
    maxRange24hPct: cfg.maxRangeWidthPct,
    flashEnabled: cfg.flashDropEnabled,
    flashCfg: flashDropConfigFromGrid(cfg),
    hourDeclineEnabled: cfg.readinessHourDeclineEnabled,
    hourDeclineBars: cfg.readinessHourDeclineBars,
  };
}
