import { bn } from '../math/decimal';

export interface DynamicScalpTargets {
  tpGrossPct: string;
  slGrossPct: string;
  atrPct: string;
  band: 'low' | 'mid' | 'high';
}

/** ATR% bandına göre brüt TP/SL (plan v2). */
export function computeDynamicScalpTargets(atrPct: string): DynamicScalpTargets {
  const atr = bn(atrPct);
  if (atr.lt(0.3)) {
    return { tpGrossPct: '0.4', slGrossPct: '0.20', atrPct, band: 'low' };
  }
  if (atr.lte(0.8)) {
    return { tpGrossPct: '0.7', slGrossPct: '0.30', atrPct, band: 'mid' };
  }
  return { tpGrossPct: '1.0', slGrossPct: '0.40', atrPct, band: 'high' };
}

export function passesMinNetTpGate(
  tpGrossPct: string,
  feeRoundtripPct: string,
  minNetTpPct: string,
): boolean {
  const net = bn(tpGrossPct).minus(feeRoundtripPct);
  return net.gte(minNetTpPct);
}
