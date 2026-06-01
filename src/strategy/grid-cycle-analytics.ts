/**
 * Grid cycle excursion — alım fiyatından satış dolana kadar tepe/çukur.
 * Yüzde tanımı trade-analytics pctFromBase ile aynı: (price − base) / base × 100.
 */
import { bn } from '../math/decimal';

function pctFromBase(base: string, price: string): string {
  const b = bn(base);
  if (b.lte(0)) return '0';
  return bn(price).minus(b).dividedBy(b).times(100).toFixed(4);
}

export interface GridCycleExcursionUpdate {
  peak: string;
  trough: string;
  changed: boolean;
}

/** Açık satış emri için son fiyatla tepe/çukur güncelle. */
export function computeGridCycleExcursionUpdate(
  lastPrice: string,
  entry: string,
  peak: string | null,
  trough: string | null,
): GridCycleExcursionUpdate {
  let p = peak && bn(peak).gt(0) ? peak : entry;
  let t = trough && bn(trough).gt(0) ? trough : entry;
  let changed = false;

  if (bn(lastPrice).gt(p)) {
    p = lastPrice;
    changed = true;
  }
  if (bn(lastPrice).lt(t)) {
    t = lastPrice;
    changed = true;
  }

  return { peak: p, trough: t, changed };
}

/** buy_cost (USDT) / qty → birim giriş fiyatı. */
export function gridCycleEntryFromBuyCost(buyCost: string, qty: string): string | null {
  const q = bn(qty);
  const cost = bn(buyCost);
  if (q.lte(0) || cost.lte(0)) return null;
  return cost.dividedBy(q).toFixed(8);
}

export interface GridCycleAnalyticsPayload {
  entry_price: string;
  exit_price: string;
  trough_price: string;
  peak_price: string;
  /** Maliyete göre en kötü düşüş (%) — negatif. */
  max_adverse_pct: string;
  /** Maliyete göre en iyi yükseliş (%) — pozitif olabilir. */
  max_favorable_pct: string;
  /** Satış doluş − eşleşen alış doluş (dakika), bilinmiyorsa null. */
  hold_minutes: number | null;
  floor_exit: boolean;
}

export function buildGridCycleAnalytics(input: {
  entryPrice: string;
  exitPrice: string;
  troughPrice: string;
  peakPrice: string;
  holdMinutes: number | null;
  floorExit: boolean;
}): GridCycleAnalyticsPayload {
  return {
    entry_price: input.entryPrice,
    exit_price: input.exitPrice,
    trough_price: input.troughPrice,
    peak_price: input.peakPrice,
    max_adverse_pct: pctFromBase(input.entryPrice, input.troughPrice),
    max_favorable_pct: pctFromBase(input.entryPrice, input.peakPrice),
    hold_minutes: input.holdMinutes,
    floor_exit: input.floorExit,
  };
}

/** GRID_CYCLE logunda yoksa çıkış fiyatından türet. */
export function resolveGridCycleExcursionPrices(
  order: {
    price: string;
    cycle_entry_price?: string | null;
    cycle_trough_price?: string | null;
    cycle_peak_price?: string | null;
  },
  buyCost: string | null,
  qty: string,
): { entry: string; trough: string; peak: string } {
  const entry =
    order.cycle_entry_price && bn(order.cycle_entry_price).gt(0)
      ? order.cycle_entry_price
      : buyCost
        ? gridCycleEntryFromBuyCost(buyCost, qty)
        : null;
  const e = entry ?? order.price;
  const trough =
    order.cycle_trough_price && bn(order.cycle_trough_price).gt(0)
      ? order.cycle_trough_price
      : e;
  const peak =
    order.cycle_peak_price && bn(order.cycle_peak_price).gt(0) ? order.cycle_peak_price : e;
  return { entry: e, trough, peak };
}
