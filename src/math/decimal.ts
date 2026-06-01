import BigNumber from 'bignumber.js';

BigNumber.config({
  DECIMAL_PLACES: 18,
  ROUNDING_MODE: BigNumber.ROUND_DOWN,
});

export { BigNumber };

export function bn(value: string | number | BigNumber): BigNumber {
  return new BigNumber(value);
}

type NumLike = string | number | BigNumber;

export function floorToStep(value: NumLike, stepSize: string): string {
  const v = bn(value);
  const step = bn(stepSize);
  if (step.isZero()) return v.toFixed();
  const floored = v.dividedBy(step).integerValue(BigNumber.ROUND_DOWN).times(step);
  const dp = step.decimalPlaces() ?? 0;
  return floored.toFixed(dp);
}

export function formatQuantity(qty: NumLike, stepSize: string): string {
  return floorToStep(qty, stepSize);
}

export function formatPrice(price: NumLike, tickSize: string): string {
  return floorToStep(price, tickSize);
}

export function pctDiff(a: NumLike, b: NumLike): BigNumber {
  const base = bn(b);
  if (base.isZero()) return bn(0);
  return bn(a).minus(base).abs().dividedBy(base).times(100);
}

export function sum(values: BigNumber[]): string {
  return values.reduce((acc, v) => acc.plus(v), bn(0)).toFixed();
}

export function subtract(a: string, b: string): string {
  return bn(a).minus(b).toFixed();
}

export function isGte(a: string, b: string): boolean {
  return bn(a).gte(b);
}

export function isLt(a: string, b: string): boolean {
  return bn(a).lt(b);
}

export function isGt(a: string, b: string): boolean {
  return bn(a).gt(b);
}
