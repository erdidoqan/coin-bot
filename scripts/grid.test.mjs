import assert from 'node:assert';
import {
  computeGridLevels,
  gridSpacingPct,
  meetsFeeWall,
  maxGridCountForFeeWall,
  planInitialBuyOrders,
  nextOrderAfterFill,
  rangeStatus,
  autoRangeFromCloses,
  cycleNetPct,
  recenterRange,
  nearestLevelIndex,
  levelsBlockingNewBuy,
  gridHasFilledBuy,
  consecutiveFilledBuysSinceLastSell,
  canPlaceNewBuyOrder,
  canPlaceBreakevenDipBuy,
  openBuyOrderCount,
  buySlotsUsed,
  sortBuyPlanNearestFirst,
  selectNearestBuyPlan,
  selectLadderBuyTarget,
  dipBuyDeferTriggerPrice,
  dipBuyDeferReleasePrice,
  isDipBuyDeferArmed,
  shouldCancelDeferredDipBuy,
  computeFloorExitPrice,
  computeFloorSellQty,
  isFloorExitOrder,
  FLOOR_EXIT_BUY_COST_TAG,
  GRID_FLOOR_EXIT_LEVEL_INDEX,
  openBuyLevelsMatchTarget,
  shouldRepositionOpenBuys,
} from '../src/strategy/grid.ts';

let passed = 0;
function t(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

t('computeGridLevels: eşit aralık', () => {
  const lv = computeGridLevels(100, 110, 10);
  assert.equal(lv.length, 11);
  assert.equal(lv[0], 100);
  assert.equal(lv[10], 110);
  assert.ok(Math.abs(lv[1] - 101) < 1e-9);
});

t('gridSpacingPct', () => {
  const s = gridSpacingPct(100, 110, 10); // step=1, mid=105 -> 0.952%
  assert.ok(Math.abs(s - 0.952) < 0.01);
});

t('meetsFeeWall', () => {
  assert.equal(meetsFeeWall(0.4, 0.15, 2), true); // 0.4 >= 0.30
  assert.equal(meetsFeeWall(0.2, 0.15, 2), false); // 0.2 < 0.30
});

t('maxGridCountForFeeWall: spacing fee duvarını geçer', () => {
  const maxN = maxGridCountForFeeWall(100, 110, 0.15, 2);
  const sp = gridSpacingPct(100, 110, maxN);
  assert.ok(meetsFeeWall(sp, 0.15, 2), `spacing ${sp} fee duvarını geçmeli`);
  // bir fazlası geçmemeli
  const sp2 = gridSpacingPct(100, 110, maxN + 1);
  assert.ok(!meetsFeeWall(sp2, 0.15, 2));
});

t('planInitialBuyOrders: sadece fiyat altı seviyelere BUY', () => {
  const lv = computeGridLevels(100, 110, 10);
  const orders = planInitialBuyOrders(lv, 105, 1000);
  // 100,101,102,103,104 < 105 -> 5 buy
  assert.equal(orders.length, 5);
  assert.ok(orders.every((o) => o.side === 'BUY' && o.price < 105));
  // qty = quotePerGrid(100) / price
  assert.ok(Math.abs(orders[0].qty - 100 / 100) < 1e-9);
});

t('nextOrderAfterFill: BUY->SELL üst, SELL->BUY alt', () => {
  const lv = computeGridLevels(100, 110, 10);
  const afterBuy = nextOrderAfterFill(3, 'BUY', lv, 1000);
  assert.equal(afterBuy.side, 'SELL');
  assert.equal(afterBuy.levelIndex, 4);
  const afterSell = nextOrderAfterFill(4, 'SELL', lv, 1000);
  assert.equal(afterSell.side, 'BUY');
  assert.equal(afterSell.levelIndex, 3);
});

t('nextOrderAfterFill: aralık dışı null', () => {
  const lv = computeGridLevels(100, 110, 10);
  assert.equal(nextOrderAfterFill(10, 'BUY', lv, 1000), null); // üst sınır
  assert.equal(nextOrderAfterFill(0, 'SELL', lv, 1000), null); // alt sınır
});

t('rangeStatus', () => {
  assert.equal(rangeStatus(105, 100, 110), 'in');
  assert.equal(rangeStatus(99, 100, 110), 'below');
  assert.equal(rangeStatus(111, 100, 110), 'above');
});

t('autoRangeFromCloses', () => {
  const closes = Array.from({ length: 100 }, (_, i) => 100 + i); // 100..199
  const r = autoRangeFromCloses(closes, 10, 90);
  assert.ok(r.lower >= 100 && r.lower <= 115);
  assert.ok(r.upper >= 185 && r.upper <= 199);
});

t('cycleNetPct: spacing - fee', () => {
  const lv = computeGridLevels(100, 110, 10); // step 1, buy@100 sell@101 -> 1% gross
  const net = cycleNetPct(lv, 0, 0.15);
  assert.ok(Math.abs(net - 0.85) < 0.01); // 1.00 - 0.15
});

t('recenterRange: genişlik korunur, merkez=last', () => {
  const r = recenterRange(108, 100, 110); // half=5, merkez 108 -> 103..113
  assert.ok(Math.abs(r.lower - 103) < 1e-9);
  assert.ok(Math.abs(r.upper - 113) < 1e-9);
  assert.ok(Math.abs(r.upper - r.lower - 10) < 1e-9); // genişlik sabit
});

t('recenterRange: lower 0 altına inmez', () => {
  const r = recenterRange(2, 0, 10); // half=5, merkez 2 -> max(0,-3)=0 .. 7
  assert.ok(r.lower >= 0);
  assert.ok(r.upper > r.lower);
});

t('recenterRange: geçersiz girdi null', () => {
  assert.equal(recenterRange(100, 110, 100), null);
  assert.equal(recenterRange(0, 100, 110), null);
});

t('nearestLevelIndex: en yakın + clamp', () => {
  const lv = computeGridLevels(100, 110, 10); // 100..110 step 1
  assert.equal(nearestLevelIndex(103.4, lv), 3);
  assert.equal(nearestLevelIndex(103.6, lv), 4);
  assert.equal(nearestLevelIndex(50, lv), 0); // alt clamp
  assert.equal(nearestLevelIndex(999, lv), 10); // üst clamp
});

t('levelsBlockingNewBuy: açık alış seviyeyi bloklar', () => {
  const blocked = levelsBlockingNewBuy([
    { level_index: 2, side: 'BUY', status: 'OPEN', qty: '10' },
  ]);
  assert.ok(blocked.has(2));
  assert.equal(blocked.size, 1);
});

t('levelsBlockingNewBuy: dolu alış + satış yok -> blok', () => {
  const blocked = levelsBlockingNewBuy([
    { level_index: 2, side: 'BUY', status: 'FILLED', qty: '24' },
  ]);
  assert.ok(blocked.has(2));
});

t('levelsBlockingNewBuy: üstte açık satış -> alt alış blok', () => {
  const blocked = levelsBlockingNewBuy([
    { level_index: 2, side: 'BUY', status: 'FILLED', qty: '24' },
    { level_index: 3, side: 'SELL', status: 'OPEN', qty: '24' },
  ]);
  assert.ok(blocked.has(2));
});

t('levelsBlockingNewBuy: tamamlanan döngü -> alış serbest', () => {
  const blocked = levelsBlockingNewBuy([
    { level_index: 2, side: 'BUY', status: 'FILLED', qty: '24' },
    { level_index: 3, side: 'SELL', status: 'FILLED', qty: '24' },
  ]);
  assert.ok(!blocked.has(2));
});

t('levelsBlockingNewBuy: çift dolu alış aynı seviye -> blok', () => {
  const blocked = levelsBlockingNewBuy([
    { level_index: 2, side: 'BUY', status: 'FILLED', qty: '24' },
    { level_index: 2, side: 'BUY', status: 'FILLED', qty: '24' },
    { level_index: 3, side: 'SELL', status: 'OPEN', qty: '24' },
  ]);
  assert.ok(blocked.has(2));
});

t('gridHasFilledBuy: dolu alış var', () => {
  assert.equal(
    gridHasFilledBuy([{ level_index: 1, side: 'BUY', status: 'FILLED', qty: '1' }]),
    true,
  );
  assert.equal(
    gridHasFilledBuy([{ level_index: 1, side: 'BUY', status: 'OPEN', qty: '1' }]),
    false,
  );
});

t('consecutiveFilledBuysSinceLastSell: satıştan sonra sıfırlanır', () => {
  const orders = [
    { id: 1, side: 'BUY', status: 'FILLED' },
    { id: 2, side: 'BUY', status: 'FILLED' },
    { id: 3, side: 'SELL', status: 'FILLED' },
    { id: 4, side: 'BUY', status: 'FILLED' },
  ];
  assert.equal(consecutiveFilledBuysSinceLastSell(orders), 1);
  assert.equal(
    consecutiveFilledBuysSinceLastSell([
      { id: 1, side: 'BUY', status: 'FILLED' },
      { id: 2, side: 'BUY', status: 'FILLED' },
    ]),
    2,
  );
});

t('canPlaceNewBuyOrder: en fazla 2 slot', () => {
  const twoBuys = [
    { id: 1, side: 'BUY', status: 'FILLED' },
    { id: 2, side: 'BUY', status: 'FILLED' },
  ];
  assert.equal(canPlaceNewBuyOrder(twoBuys, 2), false);
  assert.equal(
    canPlaceNewBuyOrder([...twoBuys, { id: 3, side: 'SELL', status: 'FILLED' }], 2),
    true,
  );
  assert.equal(
    canPlaceNewBuyOrder([{ id: 1, side: 'BUY', status: 'OPEN' }], 2),
    true,
  );
  assert.equal(buySlotsUsed([{ id: 1, side: 'BUY', status: 'OPEN' }, ...twoBuys]), 3);
});

t('selectNearestBuyPlan: fiyata en yakın 2 seviye', () => {
  const lv = computeGridLevels(0.34, 0.37, 10);
  const plan = planInitialBuyOrders(lv, 0.356, 446);
  const blocked = new Set();
  const nearest = selectNearestBuyPlan(plan, blocked, 2);
  assert.equal(nearest.length, 2);
  assert.ok(nearest[0].price >= nearest[1].price);
  const maxBelow = Math.max(...plan.map((o) => o.price));
  assert.equal(nearest[0].price, maxBelow);
});

t('openBuyLevelsMatchTarget: seviye kümesi eşleşmesi', () => {
  const plan = [
    { levelIndex: 5, side: 'BUY', price: 0.355, qty: 1 },
    { levelIndex: 4, side: 'BUY', price: 0.352, qty: 1 },
  ];
  assert.equal(openBuyLevelsMatchTarget([5, 4], plan), true);
  assert.equal(openBuyLevelsMatchTarget([0, 1], plan), false);
});

t('sortBuyPlanNearestFirst: yüksek fiyat önce', () => {
  const sorted = sortBuyPlanNearestFirst([
    { levelIndex: 0, side: 'BUY', price: 0.34, qty: 1 },
    { levelIndex: 5, side: 'BUY', price: 0.355, qty: 1 },
  ]);
  assert.equal(sorted[0].levelIndex, 5);
});

t('shouldRepositionOpenBuys: [4,3] açık hedef [5,4] → churn yok', () => {
  const lv = computeGridLevels(0.34, 0.37, 10);
  const plan = [
    { levelIndex: 5, side: 'BUY', price: lv[5], qty: 1 },
    { levelIndex: 4, side: 'BUY', price: lv[4], qty: 1 },
  ];
  assert.equal(shouldRepositionOpenBuys([4, 3], plan, lv), false);
});

t('shouldRepositionOpenBuys: açık emir 2+ adım geride → reposition', () => {
  const lv = computeGridLevels(0.34, 0.37, 10);
  const plan = [
    { levelIndex: 7, side: 'BUY', price: lv[7], qty: 1 },
    { levelIndex: 6, side: 'BUY', price: lv[6], qty: 1 },
  ];
  assert.equal(shouldRepositionOpenBuys([3, 2], plan, lv), true);
});

t('shouldRepositionOpenBuys: hedef ile aynı seviyeler → reposition yok', () => {
  const lv = computeGridLevels(0.34, 0.37, 10);
  const plan = [
    { levelIndex: 5, side: 'BUY', price: lv[5], qty: 1 },
    { levelIndex: 4, side: 'BUY', price: lv[4], qty: 1 },
  ];
  assert.equal(shouldRepositionOpenBuys([5, 4], plan, lv), false);
});

t('shouldRepositionOpenBuys: açık yok → reposition (kurulum)', () => {
  const lv = computeGridLevels(0.34, 0.37, 10);
  const plan = [{ levelIndex: 5, side: 'BUY', price: lv[5], qty: 1 }];
  assert.equal(shouldRepositionOpenBuys([], plan, lv), true);
});

t('selectLadderBuyTarget: flat en yakın, bag en dip', () => {
  const lv = computeGridLevels(1.97, 2.09, 10);
  const plan = planInitialBuyOrders(lv, 2.05, 446);
  const blocked = new Set();
  const flat = selectLadderBuyTarget(plan, false, blocked);
  const bag = selectLadderBuyTarget(plan, true, blocked);
  assert.ok(flat && bag);
  assert.ok(flat.price > bag.price);
  assert.equal(flat.levelIndex, Math.max(...plan.map((o) => o.levelIndex)));
  assert.equal(bag.levelIndex, Math.min(...plan.map((o) => o.levelIndex)));
});

t('computeFloorExitPrice ve computeFloorSellQty', () => {
  assert.ok(Math.abs(computeFloorExitPrice(2, 0.5) - 2.01) < 1e-9);
  assert.equal(computeFloorSellQty(10, 0), 10);
  assert.equal(computeFloorSellQty(10, 4), 6);
  assert.equal(computeFloorSellQty(0, 0), 0);
});

t('canPlaceBreakevenDipBuy: dolu alış geçmişi slot tüketmez', () => {
  const orders = [
    { id: 1, side: 'BUY', status: 'FILLED' },
    { id: 2, side: 'SELL', status: 'FILLED' },
    { id: 3, side: 'BUY', status: 'FILLED' },
  ];
  assert.equal(canPlaceNewBuyOrder(orders, 1), false);
  assert.equal(canPlaceBreakevenDipBuy(orders), true);
  assert.equal(canPlaceBreakevenDipBuy([...orders, { id: 4, side: 'BUY', status: 'OPEN' }]), false);
});

t('dip buy defer: TON benzeri tetik ve histerezis', () => {
  const lv = computeGridLevels(1.816, 1.907, 10);
  const dipIdx = 0;
  const trigger = dipBuyDeferTriggerPrice(lv, dipIdx, 1);
  const release = dipBuyDeferReleasePrice(lv, dipIdx, 1);
  assert.ok(trigger > lv[dipIdx]);
  assert.ok(release > trigger);
  assert.equal(isDipBuyDeferArmed(1.848, lv, dipIdx, 1), false);
  assert.equal(isDipBuyDeferArmed(trigger, lv, dipIdx, 1), true);
  assert.equal(shouldCancelDeferredDipBuy(1.848, lv, dipIdx, 1), true);
  assert.equal(shouldCancelDeferredDipBuy(trigger, lv, dipIdx, 1), false);
  assert.equal(isDipBuyDeferArmed(1.85, lv, dipIdx, 0), true);
});

t('isFloorExitOrder', () => {
  assert.equal(
    isFloorExitOrder({
      level_index: GRID_FLOOR_EXIT_LEVEL_INDEX,
      side: 'SELL',
      buy_cost: FLOOR_EXIT_BUY_COST_TAG,
    }),
    true,
  );
  assert.equal(isFloorExitOrder({ level_index: 3, side: 'SELL', buy_cost: '10' }), false);
});

console.log(`\n${passed} test geçti.`);
