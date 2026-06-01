/**
 * Grid uygunluk (readiness) — bir sembol şu an grid kurmaya uygun mu?
 *
 * Backtest dersi: grid trendde kaybeder (envanter/bag), ranging'de kazanır.
 * Bu yüzden "körü körüne" gride girmeyiz; aşağıdaki kapılar (gates) geçerse gireriz:
 *   1. Ranging: Kaufman Efficiency Ratio düşük (trend yok, salınım var).
 *   2. Aralık genişliği: fee duvarına yetecek kadar geniş, ama trend kadar geniş değil.
 *   3. Volatilite: yeterli salınım (grid'i dolduracak hareket).
 *   4. Spread: dar (maker dostu).
 *   5. Fiyat aralık içinde (kenarda değil).
 *
 * Saf/test edilebilir; gate listesi readiness UI'ına beslenebilir.
 */
import { autoRangeFromCloses } from './grid';
import {
  evaluateFlashDropForScout,
  scoutFlashAllowsReady,
  applyScoutScorePenalty,
  type FlashDropConfig,
  type FlashDropLevel,
  type FlashDropResult,
} from './grid-flash-drop';

export interface GridReadinessConfig {
  maxEfficiencyRatio: number; // <= ranging (örn. 0.35)
  minRangeWidthPct: number; // (max-min)/mean*100 alt sınır (fee duvarı için)
  maxRangeWidthPct: number; // üst sınır (çok genişse trend riski)
  minAtrPct: number; // ortalama (high-low)/close*100 alt sınır
  maxSpreadPct: number;
  rangePctl: number; // auto-range alt percentile (üst = 100-bu)
  /** 0 = kapalı. path/range > bu → ALLO tipi testere (çok fazla geri-ileri). */
  maxPathRangeRatio: number;
  /** 0 = kapalı. Σ(bar range)/close span — fitilli mumlar. */
  maxBarRangePathRatio: number;
  /** 0 = kapalı. stabilite penceresinde (high-low)/mid % üst sınır. */
  maxStabilityRangePct: number;
  /** path/range hesabı için son N adet 5m bar (288 ≈ 24s). */
  stabilityBars: number;
}

export interface GridReadinessGate {
  id: string;
  label: string;
  pass: boolean;
  actual: number | null;
  threshold: string;
}

export interface GridReadinessResult {
  ready: boolean;
  score: number;
  efficiencyRatio: number | null;
  rangeWidthPct: number | null;
  atrPct: number | null;
  spreadPct: number | null;
  pathRangeRatio: number | null;
  priceInRange: boolean;
  range: { lower: number; upper: number } | null;
  gates: GridReadinessGate[];
  primaryBlocker: string | null;
}

export function defaultGridReadinessConfig(): GridReadinessConfig {
  return {
    maxEfficiencyRatio: 0.35,
    minRangeWidthPct: 2.0,
    maxRangeWidthPct: 18,
    minAtrPct: 0.15,
    maxSpreadPct: 0.10,
    rangePctl: 8,
    maxPathRangeRatio: 12,
    maxBarRangePathRatio: 18,
    maxStabilityRangePct: 28,
    stabilityBars: 288,
  };
}

/** Grid kapanıp düşüşe geçen semboller: ranging/bant kapıları gevşetilir. */
export function relaxedReadinessConfig(cfg: GridReadinessConfig): GridReadinessConfig {
  return {
    ...cfg,
    maxEfficiencyRatio: Math.min(cfg.maxEfficiencyRatio + 0.15, 0.55),
    maxRangeWidthPct: cfg.maxRangeWidthPct + 5,
    rangePctl: Math.max(4, cfg.rangePctl - 4),
    maxPathRangeRatio:
      cfg.maxPathRangeRatio > 0 ? Math.round(cfg.maxPathRangeRatio * 1.35) : 0,
    maxBarRangePathRatio:
      cfg.maxBarRangePathRatio > 0 ? Math.round(cfg.maxBarRangePathRatio * 1.25) : 0,
    maxStabilityRangePct:
      cfg.maxStabilityRangePct > 0 ? cfg.maxStabilityRangePct + 8 : 0,
  };
}

function closeSpan(closes: number[]): number | null {
  if (closes.length < 2) return null;
  const maxC = Math.max(...closes);
  const minC = Math.min(...closes);
  const span = maxC - minC;
  return span > 0 ? span : null;
}

/**
 * Kapanış yolu / kapanış span. Wick'ler span'ı şişirip oranı yapay düşürmez (HL span yerine).
 */
export function pathRangeRatio(klines: { high: number; low: number; close: number }[]): number | null {
  if (klines.length < 5) return null;
  const closes = klines.map((k) => k.close).filter((c) => c > 0);
  if (closes.length < 5) return null;
  let pathSum = 0;
  for (let i = 1; i < closes.length; i++) pathSum += Math.abs(closes[i]! - closes[i - 1]!);
  const span = closeSpan(closes);
  if (span == null) return null;
  return pathSum / span;
}

/** Her mumun (H−L) toplamı / kapanış span — ani fitil ve testere. */
export function barRangePathRatio(klines: { high: number; low: number; close: number }[]): number | null {
  if (klines.length < 5) return null;
  const closes = klines.map((k) => k.close).filter((c) => c > 0);
  const span = closeSpan(closes);
  if (span == null) return null;
  let barSum = 0;
  for (const k of klines) {
    if (k.high >= k.low) barSum += k.high - k.low;
  }
  return barSum / span;
}

/** Kaufman Efficiency Ratio: |net| / Σ|adım|. 0=ranging, 1=trend. */
export function efficiencyRatio(closes: number[]): number | null {
  if (closes.length < 5) return null;
  let pathSum = 0;
  for (let i = 1; i < closes.length; i++) pathSum += Math.abs(closes[i]! - closes[i - 1]!);
  if (pathSum <= 0) return null;
  const net = Math.abs(closes[closes.length - 1]! - closes[0]!);
  return net / pathSum;
}

export function rangeWidthPct(highs: number[], lows: number[]): number | null {
  if (highs.length === 0) return null;
  const max = Math.max(...highs);
  const min = Math.min(...lows);
  const mid = (max + min) / 2;
  if (mid <= 0) return null;
  return ((max - min) / mid) * 100;
}

export function meanAtrPct(klines: { high: number; low: number; close: number }[]): number | null {
  if (klines.length === 0) return null;
  let sum = 0;
  let n = 0;
  for (const k of klines) {
    if (k.close > 0) {
      sum += ((k.high - k.low) / k.close) * 100;
      n++;
    }
  }
  return n > 0 ? sum / n : null;
}

export function evaluateGridReadiness(input: {
  klines: { high: number; low: number; close: number }[];
  lastPrice: number;
  spreadPct: number | null;
  config: GridReadinessConfig;
}): GridReadinessResult {
  const cfg = input.config;
  const closes = input.klines.map((k) => k.close).filter((c) => c > 0);
  const highs = input.klines.map((k) => k.high);
  const lows = input.klines.map((k) => k.low);

  const er = efficiencyRatio(closes);
  const rw = rangeWidthPct(highs, lows);
  const atr = meanAtrPct(input.klines);
  const range = autoRangeFromCloses(closes, cfg.rangePctl, 100 - cfg.rangePctl);
  const priceInRange =
    range != null && input.lastPrice >= range.lower && input.lastPrice <= range.upper;

  const stabN =
    cfg.maxPathRangeRatio > 0 && cfg.stabilityBars > 0
      ? Math.min(input.klines.length, cfg.stabilityBars)
      : 0;
  const stabKlines = stabN >= 5 ? input.klines.slice(-stabN) : input.klines;
  const prr = cfg.maxPathRangeRatio > 0 ? pathRangeRatio(stabKlines) : null;
  const brr = cfg.maxBarRangePathRatio > 0 ? barRangePathRatio(stabKlines) : null;
  const stabRw =
    cfg.maxStabilityRangePct > 0
      ? rangeWidthPct(
          stabKlines.map((k) => k.high),
          stabKlines.map((k) => k.low),
        )
      : null;

  const gates: GridReadinessGate[] = [
    {
      id: 'ranging',
      label: 'Ranging (trend yok)',
      pass: er != null && er <= cfg.maxEfficiencyRatio,
      actual: er,
      threshold: `ER <= ${cfg.maxEfficiencyRatio}`,
    },
    {
      id: 'range_width_min',
      label: 'Aralık yeterince geniş',
      pass: rw != null && rw >= cfg.minRangeWidthPct,
      actual: rw,
      threshold: `>= ${cfg.minRangeWidthPct}%`,
    },
    {
      id: 'range_width_max',
      label: 'Aralık aşırı geniş değil',
      pass: rw != null && rw <= cfg.maxRangeWidthPct,
      actual: rw,
      threshold: `<= ${cfg.maxRangeWidthPct}%`,
    },
    {
      id: 'volatility',
      label: 'Yeterli volatilite',
      pass: atr != null && atr >= cfg.minAtrPct,
      actual: atr,
      threshold: `ATR% >= ${cfg.minAtrPct}`,
    },
    {
      id: 'spread',
      label: 'Spread dar',
      pass: input.spreadPct == null || input.spreadPct <= cfg.maxSpreadPct,
      actual: input.spreadPct,
      threshold: `<= ${cfg.maxSpreadPct}%`,
    },
    {
      id: 'price_in_range',
      label: 'Fiyat aralık içinde',
      pass: priceInRange,
      actual: input.lastPrice,
      threshold: range ? `${range.lower.toFixed(4)}..${range.upper.toFixed(4)}` : 'n/a',
    },
  ];

  if (cfg.maxPathRangeRatio > 0) {
    gates.push({
      id: 'path_stability',
      label: 'Testere / whipsaw yok',
      pass: prr != null && prr <= cfg.maxPathRangeRatio,
      actual: prr,
      threshold: `path/range <= ${cfg.maxPathRangeRatio} (${stabN} bar)`,
    });
  }

  if (cfg.maxBarRangePathRatio > 0) {
    gates.push({
      id: 'bar_volatility',
      label: 'Aşırı mum fitili yok',
      pass: brr != null && brr <= cfg.maxBarRangePathRatio,
      actual: brr,
      threshold: `bar path <= ${cfg.maxBarRangePathRatio}`,
    });
  }

  if (cfg.maxStabilityRangePct > 0) {
    gates.push({
      id: 'stability_range',
      label: '24s aralık aşırı geniş değil',
      pass: stabRw != null && stabRw <= cfg.maxStabilityRangePct,
      actual: stabRw,
      threshold: `<= ${cfg.maxStabilityRangePct}% (${stabN} bar)`,
    });
  }

  const ready = gates.every((g) => g.pass) && range != null;
  // skor: ranging ne kadar güçlüyse (düşük ER) ve volatilite varsa o kadar iyi
  const score = er != null && atr != null ? (1 - Math.min(er, 1)) * 100 + atr * 5 : 0;
  const primaryBlocker = gates.find((g) => !g.pass)?.id ?? null;

  return {
    ready,
    score,
    efficiencyRatio: er,
    rangeWidthPct: rw,
    atrPct: atr,
    spreadPct: input.spreadPct,
    pathRangeRatio: prr,
    priceInRange,
    range,
    gates,
    primaryBlocker,
  };
}

/** Son n kapanış üst üste düşüyor mu? */
export function consecutiveLowerCloses(closes: number[], n: number): boolean {
  if (n < 2 || closes.length < n) return false;
  const tail = closes.slice(-n);
  for (let i = 1; i < tail.length; i++) {
    if (tail[i]! >= tail[i - 1]!) return false;
  }
  return true;
}

/** Fiyatın auto-range içindeki konumu: 0=alt, 100=üst. */
export function rangePositionPct(
  lastPrice: number,
  range: { lower: number; upper: number },
): number | null {
  const span = range.upper - range.lower;
  if (!(span > 0) || !(lastPrice > 0)) return null;
  return ((lastPrice - range.lower) / span) * 100;
}

/** Kurulum bandının üst yarısında mı? (breakeven_dip üstten alış riski) */
export function entryBandTooHigh(
  lastPrice: number,
  range: { lower: number; upper: number } | null,
  maxEntryBandPct: number,
): boolean {
  if (maxEntryBandPct <= 0 || range == null) return false;
  const pos = rangePositionPct(lastPrice, range);
  return pos != null && pos > maxEntryBandPct;
}

/**
 * Son N×5m kapanış üst üste düşüyor (örn. 12 bar = 1 saat sürekli düşüş).
 * Watchlist / aday listesine alınmaması için scout + readiness'te kullanılır.
 */
export function hourContinuousDeclineBlocked(closes: number[], bars: number): boolean {
  if (bars < 2) return false;
  return consecutiveLowerCloses(closes, bars);
}

/** Orta vadeli net düşüş (örn. 36×5m ≈ 3s). */
export function mediumDownsideBlocked(
  closes: number[],
  mediumReturnBars: number,
  warnPct: number,
): boolean {
  if (mediumReturnBars < 1 || warnPct <= 0) return false;
  const ret = shortNetReturnPct(closes, mediumReturnBars);
  return ret != null && ret < -warnPct;
}

/** SQLite UTC datetime → dakika önce. */
export function minutesSinceSqliteUtc(at: string, nowMs = Date.now()): number | null {
  const normalized = at.includes('T') ? at : `${at.replace(' ', 'T')}Z`;
  const t = Date.parse(normalized);
  if (!Number.isFinite(t)) return null;
  return (nowMs - t) / 60000;
}

export function isPostExitCooldownActive(
  enabled: boolean,
  cooldownMin: number,
  recentStop: { stoppedAt: string } | undefined,
  recentFloor: { cycledAt: string } | undefined,
  nowMs = Date.now(),
): boolean {
  if (!enabled || cooldownMin <= 0) return false;
  if (recentStop) {
    const m = minutesSinceSqliteUtc(recentStop.stoppedAt, nowMs);
    if (m != null && m < cooldownMin) return true;
  }
  if (recentFloor) {
    const m = minutesSinceSqliteUtc(recentFloor.cycledAt, nowMs);
    if (m != null && m < cooldownMin) return true;
  }
  return false;
}

/** Son bars bar net getiri % (5m kapanışlar). */
export function shortNetReturnPct(closes: number[], bars: number): number | null {
  if (bars < 1 || closes.length < bars + 1) return null;
  const start = closes[closes.length - bars - 1]!;
  const end = closes[closes.length - 1]!;
  if (!(start > 0)) return null;
  return ((end - start) / start) * 100;
}

/** Kısa pencerede net getiri eşiğinin altında mı? */
export function downsideShortReturnBlocked(
  closes: number[],
  shortReturnBars: number,
  warnPct: number,
): boolean {
  const ret = shortNetReturnPct(closes, shortReturnBars);
  return ret != null && ret < -warnPct;
}

/** Üst üste düşen kapanış veya kısa net getiri eşiği. */
export function downsideMomentumBlocked(
  closes: number[],
  downsideBars: number,
  shortReturnBars: number,
  warnPct: number,
): boolean {
  if (downsideBars >= 2 && consecutiveLowerCloses(closes, downsideBars)) return true;
  return downsideShortReturnBlocked(closes, shortReturnBars, warnPct);
}

/** Çıkış sonrası: yalnızca kısa getiri eşiği gevşek (üst üste kırmızı ayrı kontrol edilir). */
export function downsideMomentumBlockedRelaxed(
  closes: number[],
  shortReturnBars: number,
  warnPct: number,
): boolean {
  return downsideShortReturnBlocked(closes, shortReturnBars, warnPct);
}

export interface FinalizeCandidateInput {
  base: GridReadinessResult;
  closes: number[];
  lastPrice: number;
  flashCfg: FlashDropConfig;
  flashEnabled: boolean;
  downsideBars: number;
  shortReturnBars: number;
  momentumWarnPct: number;
  flashCooldown?: boolean;
  /** Yakın zamanda grid kapanmış + düşüş: momentum/ranging gevşek */
  postExitRelax?: boolean;
  postExitMomentumWarnPct?: number;
  /** 0 = kapalı. Fiyat auto-range üst %X üstündeyse kurulum yok. */
  maxEntryBandPct?: number;
  mediumReturnBars?: number;
  mediumReturnWarnPct?: number;
  /** Floor/stop sonrası yeniden kurulum bekleme */
  postExitCooldown?: boolean;
  postExitCooldownMin?: number;
  /** 0 = kapalı. Son N×5m üst üste kırmızı (sürekli 1s düşüş). */
  hourDeclineBars?: number;
}

export interface FinalizeCandidateResult {
  readiness: GridReadinessResult;
  flashLevel: FlashDropLevel;
  windowDropPct: number;
  downsideBlocked: boolean;
}

/** Readiness + flash + momentum kapıları; aday hazırlığı (scout ile aynı). */
export function finalizeCandidateReadiness(input: FinalizeCandidateInput): FinalizeCandidateResult {
  const flash: FlashDropResult = input.flashEnabled
    ? evaluateFlashDropForScout({
        lastPrice: input.lastPrice,
        klineCloses: input.closes,
        cfg: input.flashCfg,
      })
    : {
        level: 'none',
        reasons: [],
        metrics: {
          anchorDrawdownPct: 0,
          windowDropPct: 0,
          fillCountInWindow: 0,
          filledBuyCostUsdt: 0,
          investmentUsdt: 0,
        },
      };

  const postExitRelax =
    input.postExitRelax === true && input.postExitCooldown !== true;

  const momentumWarn =
    postExitRelax && input.postExitMomentumWarnPct != null
      ? input.postExitMomentumWarnPct
      : input.momentumWarnPct;

  const consecutiveRedBlock =
    input.downsideBars >= 2 && consecutiveLowerCloses(input.closes, input.downsideBars);

  const shortReturnBlock =
    input.downsideBars > 0 &&
    (postExitRelax
      ? downsideMomentumBlockedRelaxed(input.closes, input.shortReturnBars, momentumWarn)
      : downsideShortReturnBlocked(input.closes, input.shortReturnBars, input.momentumWarnPct));

  const downsideBlocked = consecutiveRedBlock || shortReturnBlock;

  const maxBand = input.maxEntryBandPct ?? 0;
  const bandPos =
    input.base.range != null
      ? rangePositionPct(input.lastPrice, input.base.range)
      : null;
  const entryBandBlocked =
    maxBand > 0 &&
    input.base.range != null &&
    entryBandTooHigh(input.lastPrice, input.base.range, maxBand);

  const medBars = input.mediumReturnBars ?? 0;
  const medWarn = input.mediumReturnWarnPct ?? 0;
  const mediumBlocked = mediumDownsideBlocked(input.closes, medBars, medWarn);
  const medRet = medBars > 0 ? shortNetReturnPct(input.closes, medBars) : null;

  const postExitCooldownBlocked = input.postExitCooldown === true;

  const hourBars = input.hourDeclineBars ?? 0;
  const hourDeclineBlocked =
    hourBars >= 2 && hourContinuousDeclineBlocked(input.closes, hourBars);
  const hourRet = hourBars > 0 ? shortNetReturnPct(input.closes, hourBars) : null;

  const gates = [...input.base.gates];

  if (input.flashEnabled) {
    gates.push({
      id: 'no_flash_drop',
      label: 'Son dk ani düşüş yok',
      pass: scoutFlashAllowsReady(flash.level),
      actual: flash.metrics.windowDropPct,
      threshold: `flash=none (şu an ${flash.level})`,
    });
  }

  if (postExitRelax || input.downsideBars > 0) {
    const ret = shortNetReturnPct(input.closes, input.shortReturnBars);
    gates.push({
      id: 'downside_momentum',
      label: postExitRelax ? 'Aşağı momentum' : 'Aşağı momentum yok',
      pass: !downsideBlocked,
      actual: ret,
      threshold: postExitRelax
        ? `${input.downsideBars}× kırmızı 5m yok · kısa getiri >= -${momentumWarn}%`
        : `${input.downsideBars}× kırmızı 5m yok · kısa getiri >= -${input.momentumWarnPct}%`,
    });
  }

  if (maxBand > 0) {
    gates.push({
      id: 'entry_band_position',
      label: 'Giriş band alt yarıda',
      pass: !entryBandBlocked,
      actual: bandPos,
      threshold: `band konumu <= ${maxBand}%`,
    });
  }

  if (medBars > 0 && medWarn > 0) {
    gates.push({
      id: 'medium_downside',
      label: 'Orta vadeli düşüş yok',
      pass: !mediumBlocked,
      actual: medRet,
      threshold: `${medBars}×5m getiri >= -${medWarn}%`,
    });
  }

  if (postExitCooldownBlocked) {
    const cd = input.postExitCooldownMin ?? 0;
    gates.push({
      id: 'post_exit_cooldown',
      label: 'Çıkış sonrası bekleme',
      pass: false,
      actual: null,
      threshold: `son floor/stop < ${cd} dk`,
    });
  }

  if (hourBars >= 2) {
    gates.push({
      id: 'hour_decline',
      label: 'Son 1s sürekli düşüş yok',
      pass: !hourDeclineBlocked,
      actual: hourRet,
      threshold: `${hourBars}×5m üst üste kırmızı yok`,
    });
  }

  let ready = gates.every((g) => g.pass) && input.base.range != null;
  if (input.flashCooldown) ready = false;

  let primaryBlocker: string | null = null;
  if (input.flashCooldown) primaryBlocker = 'flash_cooldown';
  else if (postExitCooldownBlocked) primaryBlocker = 'post_exit_cooldown';
  else if (!scoutFlashAllowsReady(flash.level)) primaryBlocker = 'flash_drop';
  else if (hourDeclineBlocked) primaryBlocker = 'hour_decline';
  else if (entryBandBlocked) primaryBlocker = 'entry_band_position';
  else if (mediumBlocked) primaryBlocker = 'medium_downside';
  else if (downsideBlocked) primaryBlocker = 'downside_momentum';
  else primaryBlocker = input.base.primaryBlocker;

  const score = applyScoutScorePenalty(input.base.score, flash);

  return {
    readiness: {
      ...input.base,
      ready,
      score,
      gates,
      primaryBlocker,
    },
    flashLevel: flash.level,
    windowDropPct: flash.metrics.windowDropPct,
    downsideBlocked,
  };
}
