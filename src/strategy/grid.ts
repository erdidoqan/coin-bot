/**
 * Spot Grid — saf çekirdek mantık (infra'dan bağımsız, test edilebilir).
 *
 * Strateji: [lower, upper] aralığında gridCount eşit aralıklı seviye. Fiyatın
 * altındaki seviyelere resting LIMIT alım; bir alım dolunca bir üst seviyeye
 * satım armlanır (maker tiny kâr = spacing). Bir satım dolunca tekrar bir alt
 * seviyeye alım armlanır. Kâr döngü başına ~spacing − fee.
 *
 * Faz 1/backtest dersi: spacing fee duvarını (>~2x roundtrip) geçmeli; trend
 * koruması (range-reset/stop-out) engine katmanında zorunlu.
 */
import { bn } from '../math/decimal';

export type GridSide = 'BUY' | 'SELL';
export type RangeStatus = 'in' | 'below' | 'above';
export type GridLadderMode = 'classic' | 'breakeven_dip';

/** Floor çıkış satışı — recenter geçici index (100_000) ile çakışmaz. */
export const GRID_FLOOR_EXIT_LEVEL_INDEX = 200_001;
export const FLOOR_EXIT_BUY_COST_TAG = '__FLOOR_EXIT__';

export function isFloorExitOrder(order: {
  level_index: number;
  side: GridSide;
  buy_cost?: string | null;
}): boolean {
  return (
    order.side === 'SELL' &&
    (order.level_index === GRID_FLOOR_EXIT_LEVEL_INDEX ||
      order.buy_cost === FLOOR_EXIT_BUY_COST_TAG)
  );
}

export interface GridParams {
  lower: number;
  upper: number;
  gridCount: number;
  /** Toplam yatırım (USDT); seviye başına = investment / gridCount */
  investmentUsdt: number;
}

export interface GridPlanOrder {
  levelIndex: number;
  side: GridSide;
  price: number;
  /** base qty (quotePerGrid / price) */
  qty: number;
}

/** Aritmetik grid seviyeleri: lower..upper, gridCount aralık (gridCount+1 nokta). */
export function computeGridLevels(lower: number, upper: number, gridCount: number): number[] {
  if (!(upper > lower) || gridCount < 1) return [];
  const step = (upper - lower) / gridCount;
  return Array.from({ length: gridCount + 1 }, (_, i) => lower + i * step);
}

/** Ortalama fiyata göre grid aralığı yüzdesi. */
export function gridSpacingPct(lower: number, upper: number, gridCount: number): number {
  if (!(upper > lower) || gridCount < 1) return 0;
  const step = (upper - lower) / gridCount;
  const mid = (lower + upper) / 2;
  return mid > 0 ? (step / mid) * 100 : 0;
}

/**
 * Grid aralığı, roundtrip fee'yi yeterli marjla (varsayılan 2x) geçiyor mu?
 * spacing >= feeRoundtripPct * multiple
 */
export function meetsFeeWall(
  spacingPct: number,
  feeRoundtripPct: number,
  multiple = 2,
): boolean {
  return spacingPct >= feeRoundtripPct * multiple;
}

/**
 * Fee duvarını sağlayan maksimum grid sayısı (spacing >= feeRoundtrip*multiple).
 * gridCount <= (upper-lower)/(mid * feeRoundtrip*multiple/100)
 */
export function maxGridCountForFeeWall(
  lower: number,
  upper: number,
  feeRoundtripPct: number,
  multiple = 2,
): number {
  if (!(upper > lower)) return 0;
  const mid = (lower + upper) / 2;
  const minSpacingFrac = (feeRoundtripPct * multiple) / 100;
  const minStep = mid * minSpacingFrac;
  if (minStep <= 0) return 0;
  return Math.max(1, Math.floor((upper - lower) / minStep));
}

/** Başlangıç: fiyatın ALTINDAki her seviyeye resting BUY. */
/** grid_orders satırı (çift alış koruması için minimum alanlar). */
export interface GridOrderBuyGuard {
  level_index: number;
  side: GridSide;
  status: 'OPEN' | 'FILLED' | 'CANCELED';
  qty: string;
}

/**
 * Yeni ALIŞ konulmamalı seviyeler (heal / recenter / re-arm).
 * - Açık alış veya üstte açık satış (döngü devam ediyor)
 * - Dolu alış toplamı > (L+1) satış toplamı (tamamlanmamış döngü / çift fill)
 */
export function levelsBlockingNewBuy(orders: GridOrderBuyGuard[]): Set<number> {
  const blocked = new Set<number>();

  for (const o of orders) {
    if (o.status === 'CANCELED') continue;
    if (o.side === 'BUY' && o.status === 'OPEN') blocked.add(o.level_index);
  }

  for (const o of orders) {
    if (o.status === 'CANCELED') continue;
    if (o.side === 'SELL' && o.status === 'OPEN') {
      const buyLevel = o.level_index - 1;
      if (buyLevel >= 0) blocked.add(buyLevel);
    }
  }

  const boughtByLevel = new Map<number, ReturnType<typeof bn>>();
  const soldFromLevel = new Map<number, ReturnType<typeof bn>>();

  for (const o of orders) {
    if (o.status === 'CANCELED') continue;
    const qty = bn(o.qty);
    if (o.side === 'BUY' && o.status === 'FILLED') {
      const prev = boughtByLevel.get(o.level_index) ?? bn(0);
      boughtByLevel.set(o.level_index, prev.plus(qty));
    }
    if (o.side === 'SELL' && (o.status === 'FILLED' || o.status === 'OPEN')) {
      const buyLevel = o.level_index - 1;
      if (buyLevel >= 0) {
        const prev = soldFromLevel.get(buyLevel) ?? bn(0);
        soldFromLevel.set(buyLevel, prev.plus(qty));
      }
    }
  }

  for (const [level, bought] of boughtByLevel) {
    const sold = soldFromLevel.get(level) ?? bn(0);
    if (bought.gt(sold)) blocked.add(level);
  }

  return blocked;
}

/** Grid yaşam döngüsünde en az bir dolu alış var mı? (recenter bu durumda yapılmaz). */
export function gridHasFilledBuy(orders: GridOrderBuyGuard[]): boolean {
  return orders.some((o) => o.side === 'BUY' && o.status === 'FILLED');
}

/** Son dolu emirden geriye: ardışık kaç BUY fill (araya SELL girince sıfırlanır). */
export function consecutiveFilledBuysSinceLastSell(
  orders: Array<{ id: number; side: GridSide; status: string }>,
): number {
  const filled = orders
    .filter((o) => o.status === 'FILLED')
    .sort((a, b) => a.id - b.id);
  let n = 0;
  for (let i = filled.length - 1; i >= 0; i--) {
    const o = filled[i]!;
    if (o.side === 'SELL') break;
    if (o.side === 'BUY') n++;
  }
  return n;
}

export function openBuyOrderCount(orders: Array<{ side: GridSide; status: string }>): number {
  return orders.filter((o) => o.side === 'BUY' && o.status === 'OPEN').length;
}

/** Açık alış + son satıştan bu yana ardışık dolu alışlar (tavan: maxConsecutive). */
export function buySlotsUsed(
  orders: Array<{ id: number; side: GridSide; status: string }>,
): number {
  return openBuyOrderCount(orders) + consecutiveFilledBuysSinceLastSell(orders);
}

export function canPlaceNewBuyOrder(
  orders: Array<{ id: number; side: GridSide; status: string }>,
  maxConsecutive = 2,
): boolean {
  if (maxConsecutive < 1) return true;
  return buySlotsUsed(orders) < maxConsecutive;
}

/** breakeven_dip: yalnızca açık alış sayısı (dolu alış geçmişi slot tüketmez). */
export function canPlaceBreakevenDipBuy(
  orders: Array<{ side: GridSide; status: string }>,
): boolean {
  return openBuyOrderCount(orders) < 1;
}

/** Alış planını fiyata yakından uzağa sırala (kurulum / recenter / heal). */
export function sortBuyPlanNearestFirst(plan: GridPlanOrder[]): GridPlanOrder[] {
  return [...plan].sort((a, b) => b.price - a.price);
}

/**
 * Fiyat altındaki seviyelerden en yakın maxConsecutive alış hedefi.
 * blocked: açık satış / dolu alış vb.; occupied: recenter'da satış remap seviyeleri.
 */
export function selectNearestBuyPlan(
  plan: GridPlanOrder[],
  blockedLevelIndices: Set<number>,
  maxConsecutive: number,
  occupiedLevels?: Set<number>,
): GridPlanOrder[] {
  const out: GridPlanOrder[] = [];
  for (const o of sortBuyPlanNearestFirst(plan)) {
    if (occupiedLevels?.has(o.levelIndex)) continue;
    if (blockedLevelIndices.has(o.levelIndex)) continue;
    out.push(o);
    if (out.length >= maxConsecutive) break;
  }
  return out;
}

/**
 * breakeven_dip: tek açık alış hedefi.
 * Flat → fiyata en yakın alt seviye; bag → planın en dip (en düşük fiyat) seviyesi.
 */
export function selectLadderBuyTarget(
  plan: GridPlanOrder[],
  netQtyPositive: boolean,
  blockedLevelIndices: Set<number>,
  occupiedLevels?: Set<number>,
): GridPlanOrder | null {
  const sorted = sortBuyPlanNearestFirst(plan);
  const candidates = sorted.filter(
    (o) => !occupiedLevels?.has(o.levelIndex) && !blockedLevelIndices.has(o.levelIndex),
  );
  if (candidates.length === 0) return null;
  return netQtyPositive ? candidates[candidates.length - 1]! : candidates[0]!;
}

/** deferSteps=0 → hemen emir; aksi halde hedefin deferSteps basamak ÜSTÜ fiyatı tetik. */
export function dipBuyDeferTriggerPrice(
  levels: number[],
  targetLevelIndex: number,
  deferSteps: number,
): number {
  const idx = Math.min(targetLevelIndex + Math.max(1, deferSteps), levels.length - 1);
  return levels[idx]!;
}

/** Tetik + releaseExtraSteps basamak üstü: fiyat buraya çıkınca açık dip alış iptal (USDT serbest). */
export function dipBuyDeferReleasePrice(
  levels: number[],
  targetLevelIndex: number,
  deferSteps: number,
  releaseExtraSteps = 1,
): number {
  let triggerIdx = Math.min(targetLevelIndex + Math.max(1, deferSteps), levels.length - 1);
  let releaseIdx = Math.min(
    targetLevelIndex + Math.max(1, deferSteps) + Math.max(1, releaseExtraSteps),
    levels.length - 1,
  );
  if (releaseIdx <= triggerIdx && releaseIdx < levels.length - 1) releaseIdx++;
  return levels[releaseIdx]!;
}

/** Fiyat tetik seviyesine indi/geçti → limit alış konabilir. */
export function isDipBuyDeferArmed(
  lastPrice: number,
  levels: number[],
  targetLevelIndex: number,
  deferSteps: number,
): boolean {
  if (deferSteps <= 0 || !Number.isFinite(lastPrice) || lastPrice <= 0) return true;
  return lastPrice <= dipBuyDeferTriggerPrice(levels, targetLevelIndex, deferSteps);
}

/** Histerezis: fiyat serbest bırakma eşiğinin üstüne çıktı → açık alışı iptal et. */
export function shouldCancelDeferredDipBuy(
  lastPrice: number,
  levels: number[],
  targetLevelIndex: number,
  deferSteps: number,
  releaseExtraSteps = 1,
): boolean {
  if (deferSteps <= 0 || !Number.isFinite(lastPrice) || lastPrice <= 0) return false;
  return lastPrice > dipBuyDeferReleasePrice(levels, targetLevelIndex, deferSteps, releaseExtraSteps);
}

/** Ortalama maliyet üstü ham çıkış fiyatı (tick yuvarlama engine'de). */
export function computeFloorExitPrice(avgCost: number, marginPct: number): number {
  if (!(avgCost > 0) || marginPct < 0) return 0;
  return avgCost * (1 + marginPct / 100);
}

/** Floor satış miktarı: net bag eksi açık (grid) satışlarla hedge edilmiş kısım. */
export function computeFloorSellQty(netQty: number, openNonFloorSellQty: number): number {
  const n = Number(netQty);
  const h = Number(openNonFloorSellQty);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(0, n - (Number.isFinite(h) && h > 0 ? h : 0));
}

/** Açık alış seviyeleri hedef planla aynı mı? */
export function openBuyLevelsMatchTarget(
  openBuyLevelIndices: number[],
  targetPlan: GridPlanOrder[],
): boolean {
  const open = new Set(openBuyLevelIndices);
  const target = new Set(targetPlan.map((o) => o.levelIndex));
  if (open.size !== target.size) return false;
  for (const i of open) {
    if (!target.has(i)) return false;
  }
  return true;
}

/**
 * Heal reposition gerekli mi? Küçük fiyat oynamalarında hedef seviye [5,4]↔[4,3]
 * flip'inde gereksiz iptal/yeniden kurmayı engeller.
 */
export function shouldRepositionOpenBuys(
  openLevelIndices: number[],
  targetPlan: GridPlanOrder[],
  levels: number[],
): boolean {
  if (targetPlan.length === 0) return false;
  if (openLevelIndices.length === 0) return true;
  if (openBuyLevelsMatchTarget(openLevelIndices, targetPlan)) return false;

  const targetLevels = targetPlan.map((o) => o.levelIndex).sort((a, b) => b - a);
  const openLevels = [...openLevelIndices].sort((a, b) => b - a);
  const maxTarget = targetLevels[0]!;
  const maxOpen = openLevels[0]!;
  const targetSet = new Set(targetLevels);
  const overlap = openLevels.filter((i) => targetSet.has(i)).length;

  const step =
    levels.length > 1 ? (levels[levels.length - 1]! - levels[0]!) / (levels.length - 1) : 0;
  const maxTargetPrice = levels[maxTarget] ?? 0;
  const maxOpenPrice = levels[maxOpen] ?? 0;

  // En az bir ortak seviye ve açık emir fiyata en fazla ~1 grid adımı geride → yeterli
  if (overlap > 0 && step > 0 && maxOpenPrice >= maxTargetPrice - step * 1.05) {
    return false;
  }

  // Fiyat yükseldi: açık emirler belirgin şekilde aşağıda (≥2 adım geride)
  if (maxTarget - maxOpen >= 2) return true;

  // Fiyat düştü: açık emirler hedefin üstünde kaldı
  if (maxOpen - maxTarget >= 2) return true;

  // Tek adım kayma + yüksek örtüşme → churn yok
  if (
    Math.abs(maxTarget - maxOpen) <= 1 &&
    overlap >= Math.min(openLevels.length, targetLevels.length) - 1
  ) {
    return false;
  }

  return true;
}

export function planInitialBuyOrders(
  levels: number[],
  currentPrice: number,
  investmentUsdt: number,
): GridPlanOrder[] {
  if (levels.length < 2) return [];
  const gridCount = levels.length - 1;
  const quotePerGrid = investmentUsdt / gridCount;
  const orders: GridPlanOrder[] = [];
  for (let i = 0; i < levels.length; i++) {
    const price = levels[i]!;
    if (price < currentPrice && price > 0) {
      orders.push({ levelIndex: i, side: 'BUY', price, qty: quotePerGrid / price });
    }
  }
  return orders;
}

/**
 * Bir emir dolduğunda armlanacak karşı emir:
 * - BUY (i) dolarsa  -> SELL (i+1)  (bir üst seviye, kâr al)
 * - SELL (i) dolarsa -> BUY (i-1)   (bir alt seviye, tekrar al)
 * Aralık dışına taşarsa null (re-arm yok).
 */
export function nextOrderAfterFill(
  filledLevelIndex: number,
  filledSide: GridSide,
  levels: number[],
  investmentUsdt: number,
): GridPlanOrder | null {
  const gridCount = levels.length - 1;
  if (gridCount < 1) return null;
  const quotePerGrid = investmentUsdt / gridCount;
  if (filledSide === 'BUY') {
    const i = filledLevelIndex + 1;
    if (i >= levels.length) return null;
    const price = levels[i]!;
    return { levelIndex: i, side: 'SELL', price, qty: quotePerGrid / levels[filledLevelIndex]! };
  }
  const i = filledLevelIndex - 1;
  if (i < 0) return null;
  const price = levels[i]!;
  return { levelIndex: i, side: 'BUY', price, qty: quotePerGrid / price };
}

/** Fiyatın aralığa göre durumu. */
export function rangeStatus(price: number, lower: number, upper: number): RangeStatus {
  if (price < lower) return 'below';
  if (price > upper) return 'above';
  return 'in';
}

/** Tarihsel kapanışlardan otomatik aralık (percentile bantı). */
export function autoRangeFromCloses(
  closes: number[],
  lowerPctl = 10,
  upperPctl = 90,
): { lower: number; upper: number } | null {
  const sorted = closes.filter((c) => Number.isFinite(c) && c > 0).sort((a, b) => a - b);
  if (sorted.length < 10) return null;
  const at = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)))]!;
  const lower = at(lowerPctl);
  const upper = at(upperPctl);
  return upper > lower ? { lower, upper } : null;
}

/** Bir döngünün (alım i → satım i+1) net kâr yüzdesi (fee dahil). */
export function cycleNetPct(
  levels: number[],
  buyLevelIndex: number,
  feeRoundtripPct: number,
): number {
  const buy = levels[buyLevelIndex];
  const sell = levels[buyLevelIndex + 1];
  if (buy == null || sell == null || buy <= 0) return 0;
  const grossPct = ((sell - buy) / buy) * 100;
  return grossPct - feeRoundtripPct;
}

/** Quote bazlı qty hesabı + güvenli kontrol. */
export function gridQty(investmentUsdt: number, gridCount: number, price: number): string {
  if (gridCount < 1 || price <= 0) return '0';
  return bn(investmentUsdt).dividedBy(gridCount).dividedBy(price).toFixed(8);
}

/**
 * Aralığı güncel fiyat etrafında yeniden ortala: genişlik (upper-lower) sabit,
 * merkez = lastPrice. Fiyat yukarı kayınca grid takip etsin (stale düşük alışlar
 * yerine güncel seviyelere alış). lower 0'ın altına inmez.
 */
export function recenterRange(
  lastPrice: number,
  lower: number,
  upper: number,
): { lower: number; upper: number } | null {
  if (!(upper > lower) || !(lastPrice > 0)) return null;
  const half = (upper - lower) / 2;
  const newLower = Math.max(0, lastPrice - half);
  const newUpper = lastPrice + half;
  return newUpper > newLower ? { lower: newLower, upper: newUpper } : null;
}

/** Bir fiyatın en yakın grid level index'i (korunan emirlerin remap'i için). [0, gridCount] clamp. */
export function nearestLevelIndex(price: number, levels: number[]): number {
  if (levels.length === 0) return 0;
  let best = 0;
  let bestDist = Math.abs(price - levels[0]!);
  for (let i = 1; i < levels.length; i++) {
    const d = Math.abs(price - levels[i]!);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}
