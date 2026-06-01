import { bn } from '../math/decimal';

export interface FloatingPnlSnapshot {
  symbol: string;
  avgCost: string;
  lastPrice: string;
  /** (sonFiyat − maliyet) / maliyet × 100, işaretli */
  pnlPct: string;
  /** Tahmini yüzen PnL (USDT) */
  pnlUsdt: string;
  /** Güncel pozisyon değeri (USDT) */
  marketValueUsdt: string;
  netBaseQty: string;
  totalUsdtSpent: string;
}

/** Maliyet = harcanan USDT / eldeki net base (Binance Cost Price ile aynı mantık). */
export function effectiveAvgCost(totalUsdtSpent: string, netBaseQty: string): string {
  const qty = bn(netBaseQty);
  if (qty.lte(0)) return '0';
  return bn(totalUsdtSpent).dividedBy(qty).toFixed(8);
}

/**
 * Yüzen PnL — Binance Spot ile uyumlu:
 * - Maliyet: totalUsdtSpent / netBaseQty
 * - PnL USDT: güncelDeğer − harcanan
 * - PnL %: pnlUsdt / harcanan × 100 (uygulamadaki yüzen % ile aynı)
 */
export function computeFloatingPnl(
  symbol: string,
  lastPrice: string,
  netBaseQty: string,
  totalUsdtSpent: string,
): FloatingPnlSnapshot | null {
  const qty = bn(netBaseQty);
  const spent = bn(totalUsdtSpent);
  if (qty.lte(0) || spent.lte(0)) return null;

  const price = bn(lastPrice);
  const avgCost = effectiveAvgCost(totalUsdtSpent, netBaseQty);
  const marketValueUsdt = price.times(qty);
  const pnlUsdt = marketValueUsdt.minus(spent);
  const pnlPct = pnlUsdt.dividedBy(spent).times(100).toFixed(2);

  return {
    symbol,
    avgCost,
    lastPrice: price.toFixed(8),
    pnlPct,
    pnlUsdt: pnlUsdt.toFixed(4),
    marketValueUsdt: marketValueUsdt.toFixed(4),
    netBaseQty: qty.toFixed(8),
    totalUsdtSpent: spent.toFixed(4),
  };
}
