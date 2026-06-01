import type { Kline } from '../exchange/binance';
import { bn, BigNumber } from '../math/decimal';

export function ema(closes: string[], period: number): string | null {
  if (closes.length < period) return null;
  const k = bn(2).dividedBy(period + 1);
  let prev = bn(closes[closes.length - period]!);
  for (let i = closes.length - period + 1; i < closes.length; i++) {
    const price = bn(closes[i]!);
    prev = price.times(k).plus(prev.times(bn(1).minus(k)));
  }
  return prev.toFixed(8);
}

/** Wilder ATR%: ATR / son kapanış * 100 */
export function atrPctFromKlines(klines: Kline[], period = 14): string | null {
  if (klines.length < period + 1) return null;
  const trs: BigNumber[] = [];
  for (let i = 1; i < klines.length; i++) {
    const cur = klines[i]!;
    const prev = klines[i - 1]!;
    const high = bn(cur.high);
    const low = bn(cur.low);
    const prevClose = bn(prev.close);
    const tr = BigNumber.max(
      high.minus(low),
      high.minus(prevClose).abs(),
      low.minus(prevClose).abs(),
    );
    trs.push(tr);
  }
  const slice = trs.slice(-period);
  const atr = slice.reduce((a, v) => a.plus(v), bn(0)).dividedBy(period);
  const lastClose = bn(klines[klines.length - 1]!.close);
  if (lastClose.isZero()) return null;
  return atr.dividedBy(lastClose).times(100).toFixed(4);
}

export function vwapFromKlines(klines: Kline[]): string | null {
  if (klines.length === 0) return null;
  let pv = bn(0);
  let vol = bn(0);
  for (const c of klines) {
    const typical = bn(c.high).plus(c.low).plus(c.close).dividedBy(3);
    const v = bn(c.volume);
    pv = pv.plus(typical.times(v));
    vol = vol.plus(v);
  }
  if (vol.isZero()) return null;
  return pv.dividedBy(vol).toFixed(8);
}

/** Son mum hâlâ açıksa çıkar; yalnızca kapalı mumlar. */
export function closedCandlesOnly(klines: Kline[], nowMs = Date.now()): Kline[] {
  if (klines.length === 0) return [];
  const last = klines[klines.length - 1]!;
  if (last.closeTime < nowMs - 1000) return klines;
  return klines.slice(0, -1);
}

export function sma(closes: string[], period: number): string | null {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const total = slice.reduce((acc, c) => acc.plus(c), bn(0));
  return total.dividedBy(period).toFixed(8);
}

export interface BollingerBands {
  upper: string;
  middle: string;
  lower: string;
}

export function bollinger(closes: string[], period: number, stdDevMult: number): BollingerBands | null {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const values = slice.map((c) => bn(c));
  const middle = values.reduce((a, v) => a.plus(v), bn(0)).dividedBy(period);

  const variance = values
    .reduce((acc, v) => {
      const diff = v.minus(middle);
      return acc.plus(diff.times(diff));
    }, bn(0))
    .dividedBy(period);

  const std = variance.sqrt();
  const mult = bn(stdDevMult);

  return {
    middle: middle.toFixed(8),
    upper: middle.plus(std.times(mult)).toFixed(8),
    lower: middle.minus(std.times(mult)).toFixed(8),
  };
}

export function isPullbackNearSma(
  price: string,
  smaValue: string,
  tolerancePct: string,
): boolean {
  const base = bn(smaValue);
  if (base.isZero()) return false;
  const diffPct = bn(price).minus(base).abs().dividedBy(base).times(100);
  return diffPct.lte(tolerancePct);
}
