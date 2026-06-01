import type { Kline, OrderBookDepth } from '../exchange/binance';
import { bn } from '../math/decimal';
import {
  atrPctFromKlines,
  closedCandlesOnly,
  ema,
  vwapFromKlines,
} from './technical';
import type { OrderbookMetrics } from '../exchange/market-data-client';

export interface MicroScalpWeights {
  trend1m: number;
  structure5m: number;
  volume: number;
  tradeCount: number;
  aggression: number;
  candle: number;
  orderbookRatio: number;
  orderbookPersistence: number;
}

/** Worker / DO skor hesabı için ortak config */
export function buildMicroScalpScoreConfig(
  micro: Pick<
    MicroScalpConfig,
    | 'entryMinScore'
    | 'volumeRatioMin'
    | 'orderbookRatioMin'
    | 'aggressionMin'
    | 'phase2Enabled'
    | 'trend15mGateMode'
    | 'trend15mPenalty'
  > & { weights?: MicroScalpWeights },
): MicroScalpConfig {
  return {
    entryMinScore: micro.entryMinScore,
    volumeRatioMin: micro.volumeRatioMin,
    orderbookRatioMin: micro.orderbookRatioMin,
    aggressionMin: micro.aggressionMin,
    phase2Enabled: micro.phase2Enabled,
    weights: micro.weights ?? DEFAULT_MICRO_WEIGHTS,
    trend15mGateMode: micro.trend15mGateMode ?? 'penalty',
    trend15mPenalty: micro.trend15mPenalty ?? 0.1,
  };
}

export const DEFAULT_MICRO_WEIGHTS: MicroScalpWeights = {
  trend1m: 0.2,
  structure5m: 0.1,
  volume: 0.2,
  tradeCount: 0.1,
  aggression: 0.15,
  candle: 0.1,
  orderbookRatio: 0.05,
  orderbookPersistence: 0.1,
};

export type Trend15mGateMode = 'hard_veto' | 'penalty';
export type Trend15mTier = 'up' | 'weak_down' | 'strong_down';

export interface MicroScalpConfig {
  entryMinScore: number;
  volumeRatioMin: number;
  orderbookRatioMin: number;
  aggressionMin: number;
  phase2Enabled: boolean;
  weights: MicroScalpWeights;
  /** hard_veto: eski davranış; penalty: hafif 15m → skor cezası, güçlü düşüş → veto */
  trend15mGateMode?: Trend15mGateMode;
  trend15mPenalty?: number;
}

export interface Trend15mEvaluation {
  aligned: boolean;
  tier: Trend15mTier;
  hardVeto: boolean;
}

export interface MicroScalpScoreComponents {
  trend1m: number;
  structure5m: number;
  volume: number;
  tradeCount: number;
  aggression: number;
  candle: number;
  orderbookRatio: number;
  orderbookPersistence: number;
}

export interface MicroScalpGateResult {
  closedCandle: boolean;
  trend15mOk: boolean;
  trend15mTier: Trend15mTier;
  trend15mPenaltyApplied: number;
  failReason: string | null;
}

export interface MicroScalpScoreResult {
  score: string;
  components: MicroScalpScoreComponents;
  gates: MicroScalpGateResult;
  pass: boolean;
  failReason: string | null;
  volumeRatio: string;
  tradeCountRatio: string;
  aggressionRatio: string;
  atrPct1m: string | null;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function ratioScore(ratio: number, threshold: number, cap = 3): number {
  if (ratio < threshold) return clamp01(ratio / threshold) * 0.5;
  return clamp01(1 + (ratio - threshold) / (cap - threshold));
}

function scoreTrend1m(klines1m: Kline[]): number {
  if (klines1m.length < 22) return 0;
  const closes = klines1m.map((k) => k.close);
  const last5 = klines1m.slice(-5);
  const greens = last5.filter((k) => bn(k.close).gte(k.open)).length;
  const greenScore = greens / 5;

  let hh = 0;
  for (let i = last5.length - 1; i >= 1; i--) {
    if (bn(last5[i]!.high).gt(last5[i - 1]!.high)) hh++;
  }
  const hhScore = hh / 4;

  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const lastClose = bn(closes[closes.length - 1]!);
  const emaScore =
    ema9 && ema21 && bn(ema9).gt(ema21) && lastClose.gt(ema9) ? 1 : 0;

  const vwap = vwapFromKlines(klines1m.slice(-30));
  const vwapScore = vwap && lastClose.gt(vwap) ? 1 : 0;

  return (greenScore * 0.25 + hhScore * 0.25 + emaScore * 0.25 + vwapScore * 0.25);
}

function scoreStructure5m(klines5m: Kline[]): number {
  if (klines5m.length < 22) return 0;
  const closed = closedCandlesOnly(klines5m);
  if (closed.length < 21) return 0;
  const closes = closed.map((k) => k.close);
  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const last = bn(closes[closes.length - 1]!);
  if (!ema9 || !ema21 || !last.gt(ema21)) return 0.2;
  const lastC = closed[closed.length - 1]!;
  const body = bn(lastC.close).minus(lastC.open).abs();
  const range = bn(lastC.high).minus(lastC.low);
  const breakout = range.gt(0) && body.dividedBy(range).gt(0.5) && bn(lastC.close).gt(lastC.open);
  return breakout ? 1 : 0.6;
}

/** Tam uyum: EMA9>EMA21, fiyat>EMA9, fiyat>VWAP */
function checkTrend15mAligned(klines15m: Kline[]): boolean {
  return evaluateTrend15m(klines15m).aligned;
}

/** 15m trend: up | zayıf uyumsuzluk (ceza) | güçlü düşüş (veto) */
export function evaluateTrend15m(klines15m: Kline[]): Trend15mEvaluation {
  if (klines15m.length < 22) {
    return { aligned: false, tier: 'strong_down', hardVeto: true };
  }
  const closed = closedCandlesOnly(klines15m);
  if (closed.length < 21) {
    return { aligned: false, tier: 'strong_down', hardVeto: true };
  }
  const closes = closed.map((k) => k.close);
  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const last = bn(closes[closes.length - 1]!);
  const vwap = vwapFromKlines(closed.slice(-20));
  if (!ema9 || !ema21) {
    return { aligned: false, tier: 'strong_down', hardVeto: true };
  }

  const ema9gt21 = bn(ema9).gt(ema21);
  const aboveEma9 = last.gt(ema9);
  const aboveVwap = !vwap || last.gt(vwap);

  if (ema9gt21 && aboveEma9 && aboveVwap) {
    return { aligned: true, tier: 'up', hardVeto: false };
  }

  if (!ema9gt21 && !aboveEma9) {
    return { aligned: false, tier: 'strong_down', hardVeto: true };
  }

  return { aligned: false, tier: 'weak_down', hardVeto: false };
}

function scoreVolume(klines1m: Kline[], minRatio: number): { score: number; ratio: string } {
  const closed = closedCandlesOnly(klines1m);
  if (closed.length < 21) return { score: 0, ratio: '0' };
  const vols = closed.map((k) => bn(k.volume));
  const last = vols[vols.length - 1]!;
  const avg = vols.slice(-21, -1).reduce((a, v) => a.plus(v), bn(0)).dividedBy(20);
  if (avg.isZero()) return { score: 0, ratio: '0' };
  const ratio = last.dividedBy(avg);
  return { score: ratioScore(ratio.toNumber(), minRatio), ratio: ratio.toFixed(4) };
}

function scoreTradeCount(klines1m: Kline[]): { score: number; ratio: string } {
  const closed = closedCandlesOnly(klines1m);
  if (closed.length < 21) return { score: 0, ratio: '0' };
  const trades = closed.map((k) => bn(k.numberOfTrades));
  const last = trades[trades.length - 1]!;
  const avg = trades.slice(-21, -1).reduce((a, v) => a.plus(v), bn(0)).dividedBy(20);
  if (avg.isZero()) return { score: 0, ratio: '0' };
  const ratio = last.dividedBy(avg);
  return { score: ratioScore(ratio.toNumber(), 1.5), ratio: ratio.toFixed(4) };
}

function scoreAggression(klines1m: Kline[], minAgg: number): { score: number; ratio: string } {
  const closed = closedCandlesOnly(klines1m);
  if (closed.length === 0) return { score: 0, ratio: '0' };
  const last = closed[closed.length - 1]!;
  const quoteVol = bn(last.volume).times(bn(last.close));
  if (quoteVol.isZero()) return { score: 0, ratio: '0' };
  const takerQuote = bn(last.takerBuyQuoteVolume);
  const ratio = takerQuote.dividedBy(quoteVol);
  const n = ratio.toNumber();
  if (n >= minAgg) return { score: 1, ratio: ratio.toFixed(4) };
  return { score: clamp01(n / minAgg), ratio: ratio.toFixed(4) };
}

function scoreCandle(klines1m: Kline[]): number {
  const closed = closedCandlesOnly(klines1m);
  if (closed.length === 0) return 0;
  const c = closed[closed.length - 1]!;
  const range = bn(c.high).minus(c.low);
  if (range.isZero()) return 0;
  const body = bn(c.close).minus(c.open).abs();
  const bodyRatio = body.dividedBy(range).toNumber();
  if (bn(c.close).lt(c.open)) return bodyRatio * 0.2;
  return clamp01(bodyRatio);
}

function scoreOrderbook(
  ob: OrderbookMetrics | null,
  depth: OrderBookDepth | null,
  ratioMin: number,
): { ratio: number; persistence: number } {
  if (ob && !ob.stale) {
    return {
      ratio: ratioScore(ob.bidAskRatio, ratioMin),
      persistence: clamp01(ob.persistenceScore),
    };
  }
  if (!depth) return { ratio: 0, persistence: 0 };
  let bidQty = bn(0);
  let askQty = bn(0);
  for (const b of depth.bids.slice(0, 10)) bidQty = bidQty.plus(b.qty);
  for (const a of depth.asks.slice(0, 10)) askQty = askQty.plus(a.qty);
  if (askQty.isZero()) return { ratio: 0, persistence: 0 };
  const ratio = bidQty.dividedBy(askQty).toNumber();
  return { ratio: ratioScore(ratio, ratioMin), persistence: 0 };
}

export function computeMicroScalpScore(input: {
  klines1m: Kline[];
  klines5m?: Kline[];
  klines15m?: Kline[];
  orderbook: OrderbookMetrics | null;
  depth?: OrderBookDepth | null;
  config: MicroScalpConfig;
  nowMs?: number;
  /** DO buffer: son mum kapalı sayılır, open_candle gate atlanır */
  skipOpenCandleGate?: boolean;
}): MicroScalpScoreResult {
  const nowMs = input.nowMs ?? Date.now();
  const k1 = input.klines1m;
  const closedOnly = closedCandlesOnly(k1, nowMs);
  const closedCandle =
    input.skipOpenCandleGate ?? (closedOnly.length > 0 && closedOnly.length === k1.length);

  const trend15m = input.config.phase2Enabled
    ? input.klines15m
      ? evaluateTrend15m(input.klines15m)
      : { aligned: false, tier: 'strong_down' as const, hardVeto: true }
    : { aligned: true, tier: 'up' as const, hardVeto: false };

  const gateMode: Trend15mGateMode = input.config.trend15mGateMode ?? 'penalty';
  const penaltyPts = input.config.trend15mPenalty ?? 0.1;

  const gates: MicroScalpGateResult = {
    closedCandle: input.skipOpenCandleGate ? true : closedCandle,
    trend15mOk: trend15m.aligned,
    trend15mTier: trend15m.tier,
    trend15mPenaltyApplied: 0,
    failReason: null,
  };

  if (!input.skipOpenCandleGate && !closedCandle) {
    gates.failReason = 'open_candle';
    return emptyResult(gates, 'open_candle');
  }

  if (closedOnly.length < 10 && k1.length < 10) {
    gates.failReason = 'insufficient_klines';
    return emptyResult(gates, 'insufficient_klines');
  }

  const k1ForScore = closedOnly.length >= 10 ? closedOnly : k1;

  const vol = scoreVolume(k1ForScore, input.config.volumeRatioMin);
  const tc = input.config.phase2Enabled
    ? scoreTradeCount(k1ForScore)
    : { score: 0, ratio: '0' };
  const agg = input.config.phase2Enabled
    ? scoreAggression(k1ForScore, input.config.aggressionMin)
    : { score: 0, ratio: '0' };

  if (input.config.phase2Enabled && vol.score > 0.5 && tc.score < 0.35) {
    vol.score *= 0.5;
  }

  const ob = scoreOrderbook(
    input.orderbook,
    input.depth ?? null,
    input.config.orderbookRatioMin,
  );

  const w = input.config.weights;
  const trend1m = scoreTrend1m(k1ForScore);
  const structure5m =
    input.config.phase2Enabled && input.klines5m
      ? scoreStructure5m(input.klines5m)
      : 0;

  const components: MicroScalpScoreComponents = {
    trend1m,
    structure5m,
    volume: vol.score,
    tradeCount: tc.score,
    aggression: agg.score,
    candle: scoreCandle(k1ForScore),
    orderbookRatio: ob.ratio,
    orderbookPersistence: input.config.phase2Enabled ? ob.persistence : 0,
  };

  let weightSum = w.trend1m + w.volume + w.candle + w.orderbookRatio;
  let weighted =
    trend1m * w.trend1m +
    vol.score * w.volume +
    components.candle * w.candle +
    ob.ratio * w.orderbookRatio;

  if (input.config.phase2Enabled) {
    weightSum += w.structure5m + w.tradeCount + w.aggression + w.orderbookPersistence;
    weighted +=
      structure5m * w.structure5m +
      tc.score * w.tradeCount +
      agg.score * w.aggression +
      ob.persistence * w.orderbookPersistence;
  }

  let scoreNum = weightSum > 0 ? weighted / weightSum : 0;
  let pass = false;
  let failReason: string | null = null;

  if (gateMode === 'penalty' && input.config.phase2Enabled) {
    if (trend15m.hardVeto) {
      gates.failReason = 'trend_15m_down';
      pass = false;
      failReason = 'trend_15m_down';
    } else if (!trend15m.aligned) {
      gates.trend15mPenaltyApplied = penaltyPts;
      scoreNum = Math.max(0, scoreNum - penaltyPts);
      pass = scoreNum >= input.config.entryMinScore;
      failReason = pass ? null : 'trend_15m_penalty';
      if (!pass) gates.failReason = 'trend_15m_penalty';
    } else {
      pass = scoreNum >= input.config.entryMinScore;
      failReason = pass ? null : 'score_below_threshold';
      if (!pass) gates.failReason = 'score_below_threshold';
    }
  } else {
    if (!trend15m.aligned) {
      gates.failReason = 'trend_15m_down';
      pass = false;
      failReason = 'trend_15m_down';
    } else {
      pass = scoreNum >= input.config.entryMinScore;
      failReason = pass ? null : 'score_below_threshold';
      if (!pass) gates.failReason = 'score_below_threshold';
    }
  }

  const score = scoreNum.toFixed(4);

  const closed1m = closedCandlesOnly(k1ForScore, nowMs);
  const atrPct1m = atrPctFromKlines(closed1m, 14);

  return {
    score,
    components,
    gates,
    pass,
    failReason,
    volumeRatio: vol.ratio,
    tradeCountRatio: tc.ratio,
    aggressionRatio: agg.ratio,
    atrPct1m,
  };
}

function emptyResult(gates: Partial<MicroScalpGateResult>, reason: string): MicroScalpScoreResult {
  const base: MicroScalpGateResult = {
    closedCandle: gates.closedCandle ?? false,
    trend15mOk: gates.trend15mOk ?? false,
    trend15mTier: gates.trend15mTier ?? 'strong_down',
    trend15mPenaltyApplied: gates.trend15mPenaltyApplied ?? 0,
    failReason: reason,
  };
  return {
    score: '0',
    components: {
      trend1m: 0,
      structure5m: 0,
      volume: 0,
      tradeCount: 0,
      aggression: 0,
      candle: 0,
      orderbookRatio: 0,
      orderbookPersistence: 0,
    },
    gates: base,
    pass: false,
    failReason: reason,
    volumeRatio: '0',
    tradeCountRatio: '0',
    aggressionRatio: '0',
    atrPct1m: null,
  };
}
