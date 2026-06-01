import type { Kline } from '../exchange/binance';
import { bn } from '../math/decimal';
import { closedCandlesOnly, ema } from './technical';

export interface TickOrderbookSnapshot {
  bidAskRatio: number;
  spreadPct: number;
  updatedAt: number;
  stale: boolean;
}

export interface TickActiveCandle {
  candle: Kline;
  isClosed: boolean;
}

export interface TickEntryConfig {
  /** Mum low'dan min yükseliş (çıkış başladı) */
  minGainPct: string;
  /** Bu üstü = geç kalındı, alım yok */
  maxGainPct: string;
  minOrderbookRatio: number;
  maxSpreadPct: string;
  maxObAgeMs: number;
  /** Yalnızca oluşmakta olan 1m mumda giriş */
  requireOpenCandle: boolean;
  /** 5m EMA + aktif 5m mum yönü */
  require5mAlignment: boolean;
  /** Hafif 5m: EMA9 veya hammer */
  require5mLight: boolean;
  /** true = gain band WS window low üzerinden (1m mum low değil) */
  useWsLowForGainBand?: boolean;
}

export interface Tick5mGateResult {
  aligned: boolean;
  failReason: string | null;
  ema9Above21: boolean;
  midAboveEma21: boolean;
  midAbove5mOpen: boolean;
}

export interface TickEntryEvaluation {
  pass: boolean;
  failReason: string | null;
  mid: string;
  candleLow: string;
  candleOpen: string;
  candleHigh: string;
  candleClose: string;
  candleOpenTime: number;
  candleIsClosed: boolean;
  gainFromCandleLowPct: string | null;
  bidAskRatio: number;
  spreadPct: number;
  orderbookStale: boolean;
  trend5mOk: boolean;
  trend5mFailReason: string | null;
}

/** (mid − ref) / ref × 100 */
export function gainFromRefPct(refPrice: string, mid: string): string | null {
  const ref = bn(refPrice);
  if (ref.lte(0)) return null;
  const m = bn(mid);
  if (!m.isFinite() || m.lte(0)) return null;
  return m.minus(ref).dividedBy(ref).times(100).toFixed(4);
}

/** min ≤ gain ≤ max — giriş penceresi (ör. %0.01–%0.05) */
export function passesTickGainBand(
  gainPct: string | null,
  minGainPct: string,
  maxGainPct: string,
): boolean {
  if (!gainPct) return false;
  const g = bn(gainPct);
  return g.gte(minGainPct) && g.lte(maxGainPct);
}

/** 5m: EMA9>EMA21, mid>EMA21, mid>=aktif 5m open */
export function evaluateTick5mGate(
  klines5m: Kline[],
  mid: string,
  active5m: TickActiveCandle | null,
): Tick5mGateResult {
  const fail = (
    failReason: string,
    partial: Partial<Tick5mGateResult> = {},
  ): Tick5mGateResult => ({
    aligned: false,
    failReason,
    ema9Above21: false,
    midAboveEma21: false,
    midAbove5mOpen: false,
    ...partial,
  });

  const closed = closedCandlesOnly(klines5m);
  if (closed.length < 21) {
    return fail('insufficient_5m_klines');
  }

  const closes = closed.map((k) => k.close);
  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  if (!ema9 || !ema21) {
    return fail('ema_5m_unavailable');
  }

  const m = bn(mid);
  const ema9Above21 = bn(ema9).gt(ema21);
  const midAboveEma21 = m.gt(ema21);

  if (!ema9Above21) {
    return fail('5m_ema_downtrend', { ema9Above21, midAboveEma21 });
  }
  if (!midAboveEma21) {
    return fail('mid_below_5m_ema21', { ema9Above21, midAboveEma21 });
  }

  const c5 =
    active5m ??
    (closed.length > 0
      ? { candle: closed[closed.length - 1]!, isClosed: true }
      : null);
  if (!c5) {
    return fail('no_5m_candle');
  }

  const midAbove5mOpen = m.gte(c5.candle.open);
  if (!midAbove5mOpen) {
    return fail('mid_below_5m_open', { ema9Above21, midAboveEma21, midAbove5mOpen });
  }

  return {
    aligned: true,
    failReason: null,
    ema9Above21,
    midAboveEma21,
    midAbove5mOpen,
  };
}

/** Hafif 5m: mid >= EMA9 veya aktif 5m hammer (close>=open, alt fitil) */
export function evaluateTick5mLight(
  klines5m: Kline[],
  mid: string,
  active5m: TickActiveCandle | null,
): Tick5mGateResult {
  const fail = (
    failReason: string,
    partial: Partial<Tick5mGateResult> = {},
  ): Tick5mGateResult => ({
    aligned: false,
    failReason,
    ema9Above21: false,
    midAboveEma21: false,
    midAbove5mOpen: false,
    ...partial,
  });

  const closed = closedCandlesOnly(klines5m);
  if (closed.length < 9) {
    return fail('insufficient_5m_klines');
  }

  const closes = closed.map((k) => k.close);
  const ema9 = ema(closes, 9);
  if (!ema9) {
    return fail('ema9_5m_unavailable');
  }

  const m = bn(mid);
  const midAboveEma9 = m.gte(ema9);
  if (midAboveEma9) {
    return {
      aligned: true,
      failReason: null,
      ema9Above21: true,
      midAboveEma21: true,
      midAbove5mOpen: true,
    };
  }

  const c5 =
    active5m ??
    (closed.length > 0
      ? { candle: closed[closed.length - 1]!, isClosed: true }
      : null);
  if (!c5) {
    return fail('no_5m_candle');
  }

  const { open, high, low, close } = c5.candle;
  const range = bn(high).minus(low);
  const bullish = bn(close).gte(open);
  let hammer = false;
  if (range.gt(0) && bullish) {
    const lowerWick = bn(close).minus(low).dividedBy(range);
    hammer = lowerWick.gte(0.5);
  }

  if (hammer) {
    return {
      aligned: true,
      failReason: null,
      ema9Above21: false,
      midAboveEma21: m.gte(ema9),
      midAbove5mOpen: m.gte(open),
    };
  }

  return fail('5m_light_not_met', { midAboveEma21: m.gte(ema9) });
}

export function evaluateTickEntry(input: {
  candle: Kline;
  candleIsClosed: boolean;
  candle5m?: TickActiveCandle | null;
  klines5m?: Kline[];
  mid: string | null;
  orderbook: TickOrderbookSnapshot | null;
  config: TickEntryConfig;
  /** WS decline window low — useWsLowForGainBand ile gain band */
  wsWindowLow?: string | null;
  nowMs?: number;
}): TickEntryEvaluation {
  const nowMs = input.nowMs ?? Date.now();
  const candle = input.candle;
  const emptyOb: TickOrderbookSnapshot = {
    bidAskRatio: 0,
    spreadPct: 0,
    updatedAt: 0,
    stale: true,
  };
  const ob = input.orderbook ?? emptyOb;

  const base: TickEntryEvaluation = {
    pass: false,
    failReason: null,
    mid: input.mid ?? '',
    candleLow: candle.low,
    candleOpen: candle.open,
    candleHigh: candle.high,
    candleClose: candle.close,
    candleOpenTime: candle.openTime,
    candleIsClosed: input.candleIsClosed,
    gainFromCandleLowPct: null,
    bidAskRatio: ob.bidAskRatio,
    spreadPct: ob.spreadPct,
    orderbookStale: ob.stale,
    trend5mOk: false,
    trend5mFailReason: null,
  };

  const candleNotOpen = input.config.requireOpenCandle && input.candleIsClosed;

  if (!input.mid || bn(input.mid).lte(0)) {
    return { ...base, failReason: 'no_mid' };
  }

  const gainRef =
    input.config.useWsLowForGainBand && input.wsWindowLow
      ? input.wsWindowLow
      : candle.low;
  const gain = gainFromRefPct(gainRef, input.mid);
  base.mid = input.mid;
  base.gainFromCandleLowPct = gain;

  if (candleNotOpen) {
    return { ...base, failReason: 'candle_not_open' };
  }

  if (ob.stale || nowMs - ob.updatedAt > input.config.maxObAgeMs) {
    return { ...base, failReason: 'orderbook_stale', orderbookStale: true };
  }

  if (bn(ob.spreadPct).gt(input.config.maxSpreadPct)) {
    return { ...base, failReason: 'spread_too_wide' };
  }

  if (ob.bidAskRatio < input.config.minOrderbookRatio) {
    return { ...base, failReason: 'orderbook_ratio_low' };
  }

  const k5 = input.klines5m ?? [];
  const candle5m = input.candle5m ?? null;
  if (input.config.require5mAlignment) {
    const gate5m = evaluateTick5mGate(k5, input.mid, candle5m);
    base.trend5mOk = gate5m.aligned;
    base.trend5mFailReason = gate5m.failReason;
    if (!gate5m.aligned) {
      return { ...base, failReason: gate5m.failReason ?? '5m_not_aligned' };
    }
  } else if (input.config.require5mLight) {
    const gate5m = evaluateTick5mLight(k5, input.mid, candle5m);
    base.trend5mOk = gate5m.aligned;
    base.trend5mFailReason = gate5m.failReason;
    if (!gate5m.aligned) {
      return { ...base, failReason: gate5m.failReason ?? '5m_light_not_met' };
    }
  } else {
    base.trend5mOk = true;
  }

  if (!gain || bn(gain).lt(input.config.minGainPct)) {
    return { ...base, failReason: 'gain_below_threshold' };
  }

  if (bn(gain).gt(input.config.maxGainPct)) {
    return { ...base, failReason: 'gain_above_max_opportunity_missed' };
  }

  if (bn(input.mid).lt(candle.open)) {
    return { ...base, failReason: 'mid_below_candle_open' };
  }

  return { ...base, pass: true, failReason: null, trend5mOk: true };
}
