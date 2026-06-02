/** Admin: aktif grid durumu (ladder + realize kâr + envanter) — izleme paneli için. */
import {
  getGridConfig,
  getActiveGrid,
  getActiveGrids,
  getRecoveringGrids,
  getFlashCooldownSymbols,
  getRecentlyStoppedGridSymbols,
  getRecentFloorCycleSymbols,
  listGridOrders,
  getGridFilledStats,
  parseRecoveryLadderDone,
  type GridConfig,
  type GridStateRow,
} from '../db/grid';
import { movePctFromAnchor } from '../strategy/recovery-ladder';
import {
  computeGridLevels,
  gridSpacingPct,
  rangeStatus,
  isFloorExitOrder,
  computeFloorExitPrice,
  planInitialBuyOrders,
  selectLadderBuyTarget,
  levelsBlockingNewBuy,
  dipBuyDeferTriggerPrice,
  isDipBuyDeferArmed,
} from '../strategy/grid';
import {
  evaluateFlashDrop,
  flashDropConfigFromGrid,
  gridAnchorPrice,
  type FlashDropLevel,
} from '../strategy/grid-flash-drop';
import {
  evaluateGridReadiness,
  finalizeCandidateReadiness,
  applyPriceChangePct3mPenalty,
  rollingReturnPct,
  isPostExitCooldownActive,
  relaxedReadinessConfig,
  type GridReadinessConfig,
} from '../strategy/grid-readiness';
import {
  resolveGridMarketDownturn,
  type GridMarketDownturnResult,
} from '../strategy/grid-market-downturn';
import { evaluateDefensiveMarketMode } from '../strategy/grid-defensive-mode';
import type { MarketRegime } from '../indicators/market-regime';
import { listWatchlist } from '../db/watchlist';
import { listTradeLogs } from '../db/trade-log';
import {
  fetchKlinesFromDo,
  fetchReadinessKlines,
  fetchOrderbookMetrics,
  fetchSymbolMidPrice,
  fetchSymbolMidPrices,
  syncMarketDataSymbols,
} from '../exchange/market-data-client';
import { BinanceClient } from '../exchange/binance';
import { avgCostFromTrades } from '../jobs/grid-sweep';
import { bn } from '../math/decimal';
import { buildSymbolWalletClaimsMap, computeExcessFree } from './grid-wallet-claims';

export interface GridLadderLevel {
  levelIndex: number;
  price: number;
  side: 'BUY' | 'SELL' | null;
  open: boolean;
  planned?: boolean;
  kind?: 'floor' | 'grid' | 'planned' | 'waiting';
  /** LIMIT fiyatı (floor satışta seviye fiyatından farklı olabilir). */
  orderPrice?: number;
  /** defer: fiyat bu seviyeye inince limit konur. */
  deferTriggerPrice?: number;
}

export interface GridStatusReport {
  enabled: boolean;
  liveGate: boolean;
  tradingEnabled: boolean;
  active: boolean;
  gridId: number | null;
  symbol: string | null;
  lower: number | null;
  upper: number | null;
  gridCount: number | null;
  spacingPct: number | null;
  lastPrice: number | null;
  rangeStatus: string | null;
  realizedPnl: string | null;
  cycles: number | null;
  openBuys: number;
  openSells: number;
  inventoryCostUsdt: number;
  /** Açık SATIŞ emirlerindeki toplam coin (dolu alışlardan). */
  inventoryQty: number;
  /** Ağırlıklı ortalama alış maliyeti (USDT/coin). */
  inventoryAvgCost: number | null;
  /** Güncel fiyata göre unrealized % (envanter varken). */
  inventoryUnrealizedPct: number | null;
  ladder: GridLadderLevel[];
  ladderMode: 'classic' | 'breakeven_dip';
  floorExitMarginPct: number;
  dipBuyDeferSteps: number;
  /** breakeven_dip: ortalama + marj ham hedef (floor emri piyasa üstüne kısılmış olabilir). */
  floorExitTargetPrice: number | null;
  flashDrop: {
    level: FlashDropLevel;
    anchorPrice: number;
    dropPct: number;
    windowDropPct: number;
    recentFillCount: number;
    reasons: string[];
  } | null;
}

/** Canlı panel yaması — fiyat, aralık (unrealized panelde hesaplanır). */
export interface GridStatusLivePatch {
  gridId: number;
  lastPrice: number | null;
  rangeStatus: string | null;
  inventoryUnrealizedPct?: number | null;
  flashDrop?: GridStatusReport['flashDrop'];
}

function emptyStatus(enabled: boolean, liveGate: boolean, tradingEnabled: boolean): GridStatusReport {
  return {
    enabled,
    liveGate,
    tradingEnabled,
    active: false,
    gridId: null,
    symbol: null,
    lower: null,
    upper: null,
    gridCount: null,
    spacingPct: null,
    lastPrice: null,
    rangeStatus: null,
    realizedPnl: null,
    cycles: null,
    openBuys: 0,
    openSells: 0,
    inventoryCostUsdt: 0,
    inventoryQty: 0,
    inventoryAvgCost: null,
    inventoryUnrealizedPct: null,
    ladder: [],
    ladderMode: 'breakeven_dip',
    floorExitMarginPct: 0.5,
    dipBuyDeferSteps: 1,
    floorExitTargetPrice: null,
    flashDrop: null,
  };
}

function parseDbTsMs(ts: string): number {
  if (!ts) return 0;
  const iso = ts.includes('T') ? ts : ts.replace(' ', 'T');
  const withZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`;
  const ms = Date.parse(withZone);
  return Number.isNaN(ms) ? 0 : ms;
}

/** Önce DO/WS mid fiyatı, yoksa REST son fiyat (panel tazeliği için). */
async function wsPriceWithRestFallback(
  env: Env,
  client: BinanceClient,
  symbol: string,
): Promise<number | null> {
  const mid = await fetchSymbolMidPrice(env, symbol);
  if (mid && Number(mid) > 0) return Number(mid);
  try {
    return Number(await client.getSymbolPrice(symbol)) || null;
  } catch {
    return null;
  }
}

async function flashDropSnapshot(
  env: Env,
  grid: GridStateRow,
  lastPrice: number,
  cfg: GridConfig,
  opts: { restKlineFallback?: boolean } = {},
): Promise<GridStatusReport['flashDrop']> {
  if (!cfg.flashDropEnabled || !(lastPrice > 0)) return null;
  const bars = Math.max(4, Math.ceil(cfg.flashDropWindowMin / 5) + 2);
  let klinesRaw = await fetchKlinesFromDo(env, grid.symbol, '5m', bars);
  if (opts.restKlineFallback !== false && (!klinesRaw || klinesRaw.length < 3)) {
    try {
      klinesRaw = await new BinanceClient(env).getKlines(grid.symbol, '5m', bars);
    } catch {
      klinesRaw = null;
    }
  }
  const klineCloses = (klinesRaw ?? []).map((k) => Number(k.close)).filter((c) => c > 0);
  const allOrders = await listGridOrders(env.DB, grid.id);
  const recentFilledBuys = allOrders
    .filter((o) => o.side === 'BUY' && o.status === 'FILLED')
    .map((o) => ({
      qty: Number(o.qty),
      price: Number(o.price),
      atMs: parseDbTsMs(o.updated_at || o.created_at),
    }));
  const stats = await getGridFilledStats(env.DB, grid.id);
  const anchor = gridAnchorPrice(grid, lastPrice);
  const flash = evaluateFlashDrop({
    anchorPrice: anchor,
    lastPrice,
    klineCloses,
    recentFilledBuys,
    filledBuyCostUsdt: stats.boughtCost,
    investmentUsdt: Number(grid.investment_usdt),
    nowMs: Date.now(),
    cfg: flashDropConfigFromGrid(cfg),
  });
  if (flash.level === 'none') return null;
  return {
    level: flash.level,
    anchorPrice: anchor,
    dropPct: flash.metrics.anchorDrawdownPct,
    windowDropPct: flash.metrics.windowDropPct,
    recentFillCount: flash.metrics.fillCountInWindow,
    reasons: flash.reasons,
  };
}

async function buildStatusForRow(
  env: Env,
  grid: GridStateRow,
  enabled: boolean,
  liveGate: boolean,
  tradingEnabled: boolean,
): Promise<GridStatusReport> {
  const lower = Number(grid.lower_price);
  const upper = Number(grid.upper_price);
  const levels = computeGridLevels(lower, upper, grid.grid_count);
  const open = await listGridOrders(env.DB, grid.id, 'OPEN');
  const cfg = await getGridConfig(env.DB, env);
  const dipMode = cfg.ladderMode === 'breakeven_dip';

  const lastPrice = await wsPriceWithRestFallback(env, new BinanceClient(env), grid.symbol);

  const openGrid = open.filter((o) => !isFloorExitOrder(o));
  const floorOrder = open.find((o) => isFloorExitOrder(o));
  const openByLevel = new Map(openGrid.map((o) => [o.level_index, o]));
  const fillStats = await getGridFilledStats(env.DB, grid.id);
  const netQty = fillStats.boughtQty - fillStats.soldQty;
  const bagTracked =
    netQty > 0 && lastPrice != null && lastPrice > 0 && netQty * lastPrice >= 1;
  let dipBuyTargetLevel: number | null = null;
  let dipDeferTrigger: number | null = null;
  let dipDeferArmed = true;
  const deferSteps = dipMode ? cfg.dipBuyDeferSteps : 0;
  if (dipMode && lastPrice != null && lastPrice > 0) {
    const allOrders = await listGridOrders(env.DB, grid.id);
    const plan = planInitialBuyOrders(levels, lastPrice, Number(grid.investment_usdt));
    const target = selectLadderBuyTarget(
      plan,
      bagTracked,
      levelsBlockingNewBuy(allOrders),
    );
    dipBuyTargetLevel = target?.levelIndex ?? null;
    if (target && deferSteps > 0) {
      dipDeferTrigger = dipBuyDeferTriggerPrice(levels, target.levelIndex, deferSteps);
      dipDeferArmed = isDipBuyDeferArmed(lastPrice, levels, target.levelIndex, deferSteps);
    }
  }
  const ladder: GridLadderLevel[] = levels.map((price, levelIndex) => {
    const o = openByLevel.get(levelIndex);
    if (o) {
      return {
        levelIndex,
        price,
        side: o.side,
        open: true,
        planned: false,
        kind: 'grid',
        orderPrice: Number(o.price),
      };
    }
    if (dipMode) {
      if (dipBuyTargetLevel === levelIndex) {
        const waiting = deferSteps > 0 && !dipDeferArmed;
        return {
          levelIndex,
          price,
          side: 'BUY',
          open: false,
          planned: true,
          kind: waiting ? 'waiting' : 'planned',
          deferTriggerPrice: dipDeferTrigger ?? undefined,
        };
      }
      return { levelIndex, price, side: null, open: false, planned: false };
    }
    if (lastPrice != null && price > lastPrice) {
      return { levelIndex, price, side: 'SELL', open: false, planned: true, kind: 'planned' };
    }
    if (lastPrice != null && price < lastPrice) {
      return { levelIndex, price, side: 'BUY', open: false, planned: true, kind: 'planned' };
    }
    return { levelIndex, price, side: null, open: false, planned: false };
  });

  if (dipMode && floorOrder) {
    ladder.push({
      levelIndex: floorOrder.level_index,
      price: Number(floorOrder.price),
      side: 'SELL',
      open: true,
      planned: false,
      kind: 'floor',
      orderPrice: Number(floorOrder.price),
    });
  }

  const inventoryQty = netQty > 0 ? netQty : 0;
  const inventoryAvgCost =
    fillStats.boughtQty > 0 ? fillStats.boughtCost / fillStats.boughtQty : null;
  const inventoryCost =
    inventoryAvgCost != null && inventoryQty > 0 ? inventoryQty * inventoryAvgCost : 0;
  const inventoryUnrealizedPct =
    inventoryAvgCost != null && lastPrice != null && inventoryAvgCost > 0
      ? ((lastPrice - inventoryAvgCost) / inventoryAvgCost) * 100
      : null;
  const floorExitTargetPrice =
    dipMode && inventoryAvgCost != null && inventoryAvgCost > 0
      ? computeFloorExitPrice(inventoryAvgCost, cfg.floorExitMarginPct)
      : null;

  const flashDrop =
    lastPrice != null && lastPrice > 0
      ? await flashDropSnapshot(env, grid, lastPrice, cfg)
      : null;

  return {
    enabled,
    liveGate,
    tradingEnabled,
    active: true,
    gridId: grid.id,
    symbol: grid.symbol,
    lower,
    upper,
    gridCount: grid.grid_count,
    spacingPct: gridSpacingPct(lower, upper, grid.grid_count),
    lastPrice,
    rangeStatus: lastPrice != null ? rangeStatus(lastPrice, lower, upper) : null,
    realizedPnl: grid.realized_pnl,
    cycles: grid.cycles,
    openBuys: open.filter((o) => o.side === 'BUY').length,
    openSells: open.filter((o) => o.side === 'SELL').length,
    inventoryCostUsdt: Number(bn(inventoryCost).toFixed(2)),
    inventoryQty: Number(bn(inventoryQty).toFixed(8)),
    inventoryAvgCost:
      inventoryAvgCost != null ? Number(inventoryAvgCost.toFixed(8)) : null,
    inventoryUnrealizedPct:
      inventoryUnrealizedPct != null ? Number(inventoryUnrealizedPct.toFixed(2)) : null,
    ladder,
    ladderMode: cfg.ladderMode,
    floorExitMarginPct: cfg.floorExitMarginPct,
    dipBuyDeferSteps: cfg.dipBuyDeferSteps,
    floorExitTargetPrice,
    flashDrop,
  };
}

/** Tek aktif grid (en yeni) — /grid endpoint geriye uyumluluğu. */
export async function buildGridStatus(env: Env): Promise<GridStatusReport> {
  const cfg = await getGridConfig(env.DB, env);
  const tradingEnabled = String(env.TRADING_ENABLED) === 'true';
  const grid = await getActiveGrid(env.DB);
  if (!grid) return emptyStatus(cfg.enabled, cfg.liveGate, tradingEnabled);
  return buildStatusForRow(env, grid, cfg.enabled, cfg.liveGate, tradingEnabled);
}

/** Tüm aktif grid'ler (çoklu eşzamanlı). */
export async function buildGridStatuses(env: Env): Promise<GridStatusReport[]> {
  const cfg = await getGridConfig(env.DB, env);
  const tradingEnabled = String(env.TRADING_ENABLED) === 'true';
  const grids = await getActiveGrids(env.DB);
  return Promise.all(
    grids.map((g) => buildStatusForRow(env, g, cfg.enabled, cfg.liveGate, tradingEnabled)),
  );
}

let lastActiveGridMarketSyncMs = 0;

/** Aktif grid sembollerini gözcü listesiyle DO WS'e ekle (en fazla ~60 sn'de bir). */
async function ensureActiveGridsOnMarketData(env: Env, activeSymbols: string[]): Promise<void> {
  if (activeSymbols.length === 0 || !env.MARKET_DATA) return;
  const now = Date.now();
  if (now - lastActiveGridMarketSyncMs < 60_000) return;
  lastActiveGridMarketSyncMs = now;
  const wl = await listWatchlist(env.DB);
  const merged = [...new Set([...wl.map((w) => w.symbol), ...activeSymbols])];
  await syncMarketDataSymbols(env, merged);
}

/** Aktif grid kartları: tek DO /books + fiyat; flash/D1 yok (hafif, ~1 sn poll). */
export async function buildGridStatusesLive(env: Env): Promise<GridStatusLivePatch[]> {
  const grids = await getActiveGrids(env.DB);
  if (grids.length === 0) return [];
  const symbols = grids.map((g) => g.symbol);
  await ensureActiveGridsOnMarketData(env, symbols);

  let mids = await fetchSymbolMidPrices(env, symbols);
  if (mids.size < symbols.length) {
    const client = new BinanceClient(env);
    await Promise.all(
      symbols.map(async (sym) => {
        if (mids.has(sym.toUpperCase())) return;
        const p = await wsPriceWithRestFallback(env, client, sym);
        if (p != null && p > 0) mids.set(sym.toUpperCase(), p);
      }),
    );
  }

  return grids.map((grid) => {
    const lower = Number(grid.lower_price);
    const upper = Number(grid.upper_price);
    const lastPrice = mids.get(grid.symbol.toUpperCase()) ?? null;
    return {
      gridId: grid.id,
      lastPrice,
      rangeStatus: lastPrice != null ? rangeStatus(lastPrice, lower, upper) : null,
      inventoryUnrealizedPct: null,
      flashDrop: undefined,
    };
  });
}

export interface GridCandidateRow {
  symbol: string;
  ready: boolean;
  isActive: boolean;
  isRecovering: boolean;
  recoveringGridId: number | null;
  setupEligible: boolean;
  score: number;
  efficiencyRatio: number | null;
  rangeWidthPct: number | null;
  atrPct: number | null;
  spreadPct: number | null;
  priceInRange: boolean;
  primaryBlocker: string | null;
  gatesPassed: number;
  gatesTotal: number;
  lastPrice: number | null;
  /** Güncel fiyata göre N bar önceki kapanış getirisi % (DO kline). */
  priceChangePct3m: number | null;
  priceChangePct10m: number | null;
  priceChangePct30m: number | null;
  priceChangePct1h: number | null;
  flashLevel: FlashDropLevel | null;
  windowDropPct: number | null;
  downsideBlocked: boolean;
  flashCooldown: boolean;
  pathRangeRatio: number | null;
  postExitRelax: boolean;
  recentStopReason: string | null;
}

export interface GridMarketGate {
  active: boolean;
  reasons: string[];
  breadthPct: string;
  btc24hChangePct: number | null;
  btc15mReturnPct: number | null;
  regime: string;
  /** grid_market_downturn_force_active — panel manuel kilidi */
  forceActive: boolean;
}

/** Panel rejim özeti — chop bitişi / bot hazırlığı tek bakışta. */
export interface GridRegimeSummary {
  regime: string;
  breadthPct: number | null;
  btc24hChangePct: number | null;
  btc15mReturnPct: number | null;
  regimeCacheUpdatedAt: string | null;
  isChop: boolean;
  breadthAboveChop: boolean;
  breadthAboveWeak: boolean;
  btc24hAboveRecovery: boolean;
  marketGateActive: boolean;
  candidateCount: number;
  readyCount: number;
  setupEligibleCount: number;
  fallingNowCount: number;
  green3mCount: number;
  green10mCount: number;
  lastGridWaitAt: string | null;
  lastGridWaitReason: string | null;
  headline: string;
  defensiveActive: boolean;
  defensiveReasons: string[];
  defensiveExemptCount: number;
}

export interface GridCandidatesReport {
  candidates: GridCandidateRow[];
  marketGate: GridMarketGate;
  regimeSummary: GridRegimeSummary;
  /** @deprecated marketGate.active kullanın */
  marketPanic: boolean;
}

/** detectMarketRegime / grid-market-downturn ile uyumlu (breadth 0–100). */
const BREADTH_CHOP_MAX_PCT = 45;
const BREADTH_WEAK_MAX_PCT = 38;
const BTC_24H_RECOVERY_PCT = -2.5;

interface RegimeCacheParsed {
  breadth: string;
  btc24hChangePct: number | null;
  btc15mReturnPct: number | null;
  gridMarketDownturn: boolean;
  gridMarketDownturnReasons: string[];
}

function parseRegimeCacheDetail(detail: string | null): RegimeCacheParsed {
  const empty: RegimeCacheParsed = {
    breadth: '0',
    btc24hChangePct: null,
    btc15mReturnPct: null,
    gridMarketDownturn: false,
    gridMarketDownturnReasons: [],
  };
  if (!detail) return empty;
  try {
    const d = JSON.parse(detail) as {
      breadth?: string | number;
      btc24hChangePct?: number;
      btc15mReturnPct?: number;
      gridMarketDownturn?: boolean;
      gridMarketDownturnReasons?: string[];
    };
    return {
      breadth: d.breadth != null ? String(d.breadth) : '0',
      btc24hChangePct:
        d.btc24hChangePct != null && Number.isFinite(d.btc24hChangePct) ? d.btc24hChangePct : null,
      btc15mReturnPct:
        d.btc15mReturnPct != null && Number.isFinite(d.btc15mReturnPct) ? d.btc15mReturnPct : null,
      gridMarketDownturn: Boolean(d.gridMarketDownturn),
      gridMarketDownturnReasons: Array.isArray(d.gridMarketDownturnReasons)
        ? d.gridMarketDownturnReasons
        : [],
    };
  } catch {
    return empty;
  }
}

async function fetchRegimeCacheRow(db: D1Database): Promise<{
  regime: string;
  detail: string | null;
  updatedAt: string | null;
}> {
  const row = await db
    .prepare('SELECT regime, detail, updated_at FROM regime_cache WHERE id = 1')
    .first<{ regime: string; detail: string | null; updated_at: string | null }>();
  return {
    regime: row?.regime ?? 'trend',
    detail: row?.detail ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

async function fetchLastGridWait(
  db: D1Database,
): Promise<{ at: string; reason: string } | null> {
  const row = await db
    .prepare(
      `SELECT created_at, payload FROM trade_log WHERE event_type = 'GRID_WAIT' ORDER BY id DESC LIMIT 1`,
    )
    .first<{ created_at: string; payload: string | null }>();
  if (!row) return null;
  let reason = 'unknown';
  if (row.payload) {
    try {
      const p = JSON.parse(row.payload) as { reason?: string };
      if (p.reason) reason = p.reason;
    } catch {
      /* ignore */
    }
  }
  return { at: row.created_at, reason };
}

function downturnStubFromGate(
  marketGate: GridMarketGate,
  regime: string,
): GridMarketDownturnResult | null {
  if (!marketGate.active) return null;
  const reg = regime as MarketRegime;
  return {
    active: true,
    reasons: marketGate.reasons,
    metrics: {
      breadthPct: marketGate.breadthPct,
      btc24hChangePct: marketGate.btc24hChangePct,
      btc15mReturnPct: marketGate.btc15mReturnPct,
      btcAtrPct: null,
      regime: reg,
      ema9Above21: false,
    },
    regime: { regime: reg, btcAtrPct: null, breadthPct: marketGate.breadthPct, detail: {} },
  };
}

export function buildRegimeSummary(input: {
  candidates: GridCandidateRow[];
  marketGate: GridMarketGate;
  cfg: GridConfig;
  regime: string;
  regimeCacheUpdatedAt: string | null;
  lastGridWait: { at: string; reason: string } | null;
}): GridRegimeSummary {
  const breadthNum = Number(input.marketGate.breadthPct);
  const breadthPct = Number.isFinite(breadthNum) ? breadthNum : null;
  const btc24h = input.marketGate.btc24hChangePct;
  const isChop =
    input.regime === 'chop' ||
    input.regime === 'panic' ||
    (breadthPct != null && breadthPct <= BREADTH_CHOP_MAX_PCT);
  const breadthAboveChop = breadthPct != null && breadthPct > BREADTH_CHOP_MAX_PCT;
  const breadthAboveWeak = breadthPct != null && breadthPct > BREADTH_WEAK_MAX_PCT;
  const btc24hAboveRecovery = btc24h != null && btc24h > BTC_24H_RECOVERY_PCT;

  const candidateCount = input.candidates.length;
  const readyCount = input.candidates.filter((c) => c.ready).length;
  const setupEligibleCount = input.candidates.filter((c) => c.setupEligible).length;
  const fallingNowCount = input.candidates.filter(
    (c) => c.primaryBlocker === 'downside_momentum',
  ).length;
  const green3mCount = input.candidates.filter(
    (c) => c.priceChangePct3m != null && c.priceChangePct3m > 0,
  ).length;
  const green10mCount = input.candidates.filter(
    (c) => c.priceChangePct10m != null && c.priceChangePct10m > 0,
  ).length;

  const defensive = evaluateDefensiveMarketMode({
    cfg: input.cfg,
    regime: input.regime,
    breadthPct: input.marketGate.breadthPct,
    downturn: downturnStubFromGate(input.marketGate, input.regime),
  });

  let headline: string;
  if (defensive.active) {
    headline = `Savunma modu aktif (${defensive.reasons.join(', ')}) — yeni grid yok; muaf olmayan aktifler recovery.`;
  } else if (input.marketGate.forceActive) {
    headline = 'Manuel piyasa kilidi açık — yeni grid kurulmaz.';
  } else if (input.marketGate.active) {
    headline = 'Otomatik piyasa düşüş kapısı aktif — makro zayıf.';
  } else if (setupEligibleCount >= 1) {
    headline = `${setupEligibleCount} aday kuruluma hazır — boş slot olunca bot deneyebilir.`;
  } else if (breadthAboveChop && green3mCount >= 3 && fallingNowCount < candidateCount / 2) {
    headline = 'Makro toparlanıyor; sembol kapıları hâlâ çoğu coinde sıkı.';
  } else if (isChop && fallingNowCount >= Math.max(3, Math.ceil(candidateCount * 0.5))) {
    headline = 'Chop + çoğu aday “şimdi düşüyor” — testere devam ediyor.';
  } else if (readyCount > 0) {
    headline = `${readyCount} aday teknik hazır ama slot/kapı engeli var.`;
  } else if (breadthPct != null && breadthPct <= BREADTH_WEAK_MAX_PCT) {
    headline = `Evren zayıf (breadth %${breadthPct.toFixed(0)}) — chop bitene kadar bekle.`;
  } else {
    headline = 'Mikro momentum zayıf; 3dk/10dk yeşile dönünce hazır aday artar.';
  }

  return {
    regime: input.regime,
    breadthPct,
    btc24hChangePct: btc24h,
    btc15mReturnPct: input.marketGate.btc15mReturnPct,
    regimeCacheUpdatedAt: input.regimeCacheUpdatedAt,
    isChop,
    breadthAboveChop,
    breadthAboveWeak,
    btc24hAboveRecovery,
    marketGateActive: input.marketGate.active,
    candidateCount,
    readyCount,
    setupEligibleCount,
    fallingNowCount,
    green3mCount,
    green10mCount,
    lastGridWaitAt: input.lastGridWait?.at ?? null,
    lastGridWaitReason: input.lastGridWait?.reason ?? null,
    headline,
    defensiveActive: defensive.active,
    defensiveReasons: defensive.reasons,
    defensiveExemptCount: input.cfg.defensiveExemptGridIds.length,
  };
}

function applyDefensiveGateToCandidates(
  rows: GridCandidateRow[],
  defensiveActive: boolean,
): GridCandidateRow[] {
  if (!defensiveActive) return rows;
  return rows.map((r) => ({
    ...r,
    setupEligible: false,
    primaryBlocker: r.setupEligible ? 'defensive_mode' : r.primaryBlocker,
  }));
}

export type BuildGridCandidatesOptions = {
  /**
   * Canlı poll: tam REST regime çözümlemesi yerine regime_cache (bot ile aynı bayrak).
   * Aday satırlarında piyasa kapısı yine uygulanır — önceden live=1 kapıyı düşürüyordu.
   */
  skipMarketDownturn?: boolean;
};

function gateBlockerFromReasons(reasons: string[]): string {
  if (reasons.includes('panic')) return 'market_panic';
  if (reasons.includes('force_active')) return 'force_active';
  return 'market_downturn';
}

function applyMarketGateToCandidates(
  rows: GridCandidateRow[],
  marketGate: GridMarketGate,
): GridCandidateRow[] {
  if (!marketGate.active) return rows;
  const gateBlocker = gateBlockerFromReasons(marketGate.reasons);
  return rows.map((r) => ({
    ...r,
    setupEligible: false,
    primaryBlocker: r.setupEligible ? gateBlocker : r.primaryBlocker,
  }));
}

async function marketGateFromRegimeCache(db: D1Database, cfg: GridConfig): Promise<GridMarketGate> {
  const cached = await fetchRegimeCacheRow(db);
  const parsed = parseRegimeCacheDetail(cached.detail);
  const base: Omit<GridMarketGate, 'active' | 'reasons' | 'forceActive'> = {
    breadthPct: parsed.breadth,
    btc24hChangePct: parsed.btc24hChangePct,
    btc15mReturnPct: parsed.btc15mReturnPct,
    regime: cached.regime,
  };

  if (cfg.marketDownturnForceActive) {
    return {
      active: true,
      reasons: ['force_active'],
      ...base,
      forceActive: true,
    };
  }
  if (!cfg.marketDownturnEnabled) {
    return {
      active: false,
      reasons: [],
      ...base,
      forceActive: false,
    };
  }
  return {
    active: parsed.gridMarketDownturn,
    reasons: parsed.gridMarketDownturn
      ? parsed.gridMarketDownturnReasons.length > 0
        ? parsed.gridMarketDownturnReasons
        : ['breadth_weak']
      : [],
    ...base,
    forceActive: false,
  };
}

async function resolveMarketGateForCandidates(
  env: Env,
  cfg: GridConfig,
  client: BinanceClient,
  watchlistSymbols: string[],
  opts: BuildGridCandidatesOptions,
): Promise<GridMarketGate> {
  if (opts.skipMarketDownturn) {
    return marketGateFromRegimeCache(env.DB, cfg);
  }
  if (!cfg.marketDownturnEnabled) {
    return marketGateFromRegimeCache(env.DB, cfg);
  }
  const downturn = await resolveGridMarketDownturn(env, client, cfg, watchlistSymbols);
  return {
    active: downturn.active,
    reasons: downturn.reasons,
    breadthPct: downturn.metrics.breadthPct,
    btc24hChangePct: downturn.metrics.btc24hChangePct,
    btc15mReturnPct: downturn.metrics.btc15mReturnPct,
    regime: downturn.metrics.regime,
    forceActive: cfg.marketDownturnForceActive,
  };
}

export async function buildGridCandidates(env: Env): Promise<GridCandidateRow[]> {
  const report = await buildGridCandidatesReport(env);
  return report.candidates;
}

export async function buildGridCandidatesReport(
  env: Env,
  opts: BuildGridCandidatesOptions = {},
): Promise<GridCandidatesReport> {
  const cfg = await getGridConfig(env.DB, env);
  const wl = await listWatchlist(env.DB);
  const symbols = wl.map((w) => w.symbol).filter((s) => s.endsWith('USDT')).slice(0, cfg.candidateCount);
  const activeSet = new Set((await getActiveGrids(env.DB)).map((g) => g.symbol));
  const recoveringBySymbol = new Map(
    (await getRecoveringGrids(env.DB)).map((g) => [g.symbol, g.id] as const),
  );
  const client = new BinanceClient(env);
  const readinessCfg: GridReadinessConfig = {
    maxEfficiencyRatio: cfg.maxEfficiencyRatio,
    minRangeWidthPct: cfg.minRangeWidthPct,
    maxRangeWidthPct: cfg.maxRangeWidthPct,
    minAtrPct: cfg.minAtrPct,
    maxSpreadPct: cfg.readinessMaxSpreadPct,
    rangePctl: cfg.rangePctl,
    maxPathRangeRatio: cfg.readinessMaxPathRangeRatio,
    maxBarRangePathRatio: cfg.readinessMaxBarRangePathRatio,
    maxStabilityRangePct: cfg.readinessMaxStabilityRangePct,
    stabilityBars: cfg.readinessStabilityBars,
  };

  const needStoppedMap =
    cfg.readinessPostExitRelaxEnabled || cfg.readinessPostExitCooldownEnabled;
  const [cooldownSet, recentlyStopped, recentFloors, marketGate, regimeCacheRow, lastGridWait] =
    await Promise.all([
      cfg.flashDropSymbolCooldownMin > 0
        ? getFlashCooldownSymbols(env.DB, cfg.flashDropSymbolCooldownMin)
        : Promise.resolve(new Set<string>()),
      needStoppedMap
        ? getRecentlyStoppedGridSymbols(
            env.DB,
            cfg.readinessPostExitRelaxEnabled ? cfg.readinessPostExitRelaxDays : 1,
          )
        : Promise.resolve(new Map()),
      cfg.readinessPostExitCooldownEnabled
        ? getRecentFloorCycleSymbols(env.DB, cfg.readinessPostExitCooldownMin)
        : Promise.resolve(new Map()),
      resolveMarketGateForCandidates(env, cfg, client, wl.map((w) => w.symbol), opts),
      fetchRegimeCacheRow(env.DB),
      fetchLastGridWait(env.DB),
    ]);

  const rows = await Promise.all(
    symbols.map((symbol) =>
      assessCandidateRow(
        env,
        client,
        symbol,
        activeSet,
        recoveringBySymbol,
        readinessCfg,
        cfg,
        cooldownSet,
        recentlyStopped,
        recentFloors,
      ),
    ),
  );
  rows.sort((a, b) => Number(b.ready) - Number(a.ready) || b.score - a.score);

  const visibleRows =
    cfg.readinessHourDeclineEnabled && cfg.readinessHourDeclineBars >= 2
      ? rows.filter((r) => r.primaryBlocker !== 'hour_decline')
      : rows;

  let candidates = applyMarketGateToCandidates(visibleRows, marketGate);
  const defensive = evaluateDefensiveMarketMode({
    cfg,
    regime: regimeCacheRow.regime,
    breadthPct: marketGate.breadthPct,
    downturn: downturnStubFromGate(marketGate, regimeCacheRow.regime),
  });
  candidates = applyDefensiveGateToCandidates(candidates, defensive.active);

  const regimeSummary = buildRegimeSummary({
    candidates,
    marketGate,
    cfg,
    regime: regimeCacheRow.regime,
    regimeCacheUpdatedAt: regimeCacheRow.updatedAt,
    lastGridWait,
  });

  return { candidates, marketGate, regimeSummary, marketPanic: marketGate.active };
}

function emptyCandidateRow(
  symbol: string,
  activeSet: Set<string>,
  recoveringBySymbol: Map<string, number>,
  blocker: string,
  cfg: GridConfig,
  gatesTotal = 8,
): GridCandidateRow {
  const recoveringGridId = recoveringBySymbol.get(symbol) ?? null;
  const isRecovering = recoveringGridId != null;
  const ready = false;
  return {
    symbol,
    ready,
    isActive: activeSet.has(symbol),
    isRecovering,
    recoveringGridId,
    setupEligible: false,
    score: 0,
    efficiencyRatio: null,
    rangeWidthPct: null,
    atrPct: null,
    spreadPct: null,
    priceInRange: false,
    primaryBlocker: blocker,
    gatesPassed: 0,
    gatesTotal,
    lastPrice: null,
    priceChangePct3m: null,
    priceChangePct10m: null,
    priceChangePct30m: null,
    priceChangePct1h: null,
    flashLevel: null,
    windowDropPct: null,
    downsideBlocked: false,
    flashCooldown: blocker === 'flash_cooldown',
    pathRangeRatio: null,
    postExitRelax: false,
    recentStopReason: null,
  };
}

async function assessCandidateRow(
  env: Env,
  client: BinanceClient,
  symbol: string,
  activeSet: Set<string>,
  recoveringBySymbol: Map<string, number>,
  readinessCfg: GridReadinessConfig,
  cfg: GridConfig,
  cooldownSet: Set<string>,
  recentlyStopped: Map<string, { stopReason: string | null; stoppedAt: string }>,
  recentFloors: Map<string, { cycledAt: string }>,
): Promise<GridCandidateRow> {
  const recoveringGridId = recoveringBySymbol.get(symbol) ?? null;
  const isRecovering = recoveringGridId != null;
  const flashCooldown = cooldownSet.has(symbol);
  const gatesTotalBase =
    6 +
    (cfg.flashDropEnabled ? 1 : 0) +
    (cfg.readinessDownsideBars > 0 ? 1 : 0) +
    (cfg.readinessMaxEntryBandPct > 0 ? 1 : 0) +
    (cfg.readinessMediumReturnBars > 0 && cfg.readinessMediumReturnWarnPct > 0 ? 1 : 0) +
    (cfg.readinessPostExitCooldownEnabled ? 1 : 0) +
    (cfg.readinessHourDeclineEnabled && cfg.readinessHourDeclineBars >= 2 ? 1 : 0) +
    (cfg.readinessMaxPathRangeRatio > 0 ? 1 : 0) +
    (cfg.readinessMaxBarRangePathRatio > 0 ? 1 : 0) +
    (cfg.readinessMaxStabilityRangePct > 0 ? 1 : 0);

  if (flashCooldown) {
    return emptyCandidateRow(symbol, activeSet, recoveringBySymbol, 'flash_cooldown', cfg, gatesTotalBase);
  }

  const raw = await fetchReadinessKlines(env, client, symbol, {
    lookbackBars: cfg.readinessLookback,
    stabilityBars: cfg.readinessStabilityBars,
    needFullStability:
      cfg.readinessMaxPathRangeRatio > 0 ||
      cfg.readinessMaxBarRangePathRatio > 0 ||
      cfg.readinessMaxStabilityRangePct > 0,
  });
  if (!raw || raw.length < 20) {
    return emptyCandidateRow(symbol, activeSet, recoveringBySymbol, 'no_klines', cfg, gatesTotalBase);
  }
  const klines = raw.map((k) => ({ high: Number(k.high), low: Number(k.low), close: Number(k.close) }));
  const closes = klines.map((k) => k.close).filter((c) => c > 0);
  const [mid, obm, klines1m, klines5m] = await Promise.all([
    fetchSymbolMidPrice(env, symbol),
    fetchOrderbookMetrics(env, symbol),
    fetchKlinesFromDo(env, symbol, '1m', 35),
    fetchKlinesFromDo(env, symbol, '5m', 13),
  ]);
  let lastPrice: number | null = null;
  if (mid && Number(mid) > 0) lastPrice = Number(mid);
  if (lastPrice == null) lastPrice = Number(klines[klines.length - 1]!.close) || null;
  const priceChangePct3m = rollingReturnPct(lastPrice, klines1m, 3);
  const priceChangePct10m = rollingReturnPct(lastPrice, klines1m, 10);
  const priceChangePct30m = rollingReturnPct(lastPrice, klines1m, 30);
  const priceChangePct1h = rollingReturnPct(lastPrice, klines5m, 12);
  const spreadPct = obm && !obm.stale ? obm.spreadPct : null;
  const sym = symbol.toUpperCase();
  const recentStop = recentlyStopped.get(sym);
  const recentFloor = recentFloors.get(sym);
  const postExitCooldown = isPostExitCooldownActive(
    cfg.readinessPostExitCooldownEnabled,
    cfg.readinessPostExitCooldownMin,
    recentStop,
    recentFloor,
  );
  const postExitRelax =
    cfg.readinessPostExitRelaxEnabled && recentStop != null && !postExitCooldown;
  const effectiveReadinessCfg = postExitRelax
    ? relaxedReadinessConfig(readinessCfg)
    : readinessCfg;
  const base = evaluateGridReadiness({
    klines,
    lastPrice: lastPrice ?? 0,
    spreadPct,
    config: effectiveReadinessCfg,
  });
  const merged = finalizeCandidateReadiness({
    base,
    closes,
    lastPrice: lastPrice ?? 0,
    flashCfg: flashDropConfigFromGrid(cfg),
    flashEnabled: cfg.flashDropEnabled,
    downsideBars: cfg.readinessDownsideBars,
    shortReturnBars: cfg.readinessShortReturnBars,
    momentumWarnPct: cfg.readinessMomentumWarnPct,
    flashCooldown: false,
    postExitRelax,
    postExitMomentumWarnPct: cfg.readinessPostExitMomentumWarnPct,
    maxEntryBandPct: cfg.readinessMaxEntryBandPct,
    mediumReturnBars: cfg.readinessMediumReturnBars,
    mediumReturnWarnPct: cfg.readinessMediumReturnWarnPct,
    postExitCooldown,
    postExitCooldownMin: cfg.readinessPostExitCooldownMin,
    hourDeclineBars: cfg.readinessHourDeclineEnabled ? cfg.readinessHourDeclineBars : 0,
  });
  const r = applyPriceChangePct3mPenalty(merged.readiness, priceChangePct3m);
  const isActive = activeSet.has(symbol);
  const setupEligible =
    r.ready &&
    !isActive &&
    (cfg.allowNewGridWhileRecovering || !isRecovering);
  return {
    symbol,
    ready: r.ready,
    isActive,
    isRecovering,
    recoveringGridId,
    setupEligible,
    score: Number(r.score.toFixed(2)),
    efficiencyRatio: r.efficiencyRatio,
    rangeWidthPct: r.rangeWidthPct,
    atrPct: r.atrPct,
    spreadPct: r.spreadPct,
    priceInRange: r.priceInRange,
    primaryBlocker: r.primaryBlocker,
    gatesPassed: r.gates.filter((g) => g.pass).length,
    gatesTotal: r.gates.length,
    lastPrice,
    priceChangePct3m,
    priceChangePct10m,
    priceChangePct30m,
    priceChangePct1h,
    flashLevel: cfg.flashDropEnabled ? merged.flashLevel : null,
    windowDropPct: cfg.flashDropEnabled ? Number(merged.windowDropPct.toFixed(2)) : null,
    downsideBlocked: merged.downsideBlocked,
    flashCooldown: false,
    pathRangeRatio: r.pathRangeRatio != null ? Number(r.pathRangeRatio.toFixed(2)) : null,
    postExitRelax,
    recentStopReason: recentStop?.stopReason ?? null,
  };
}

export interface GridRecoveryRow {
  gridId: number;
  symbol: string;
  qty: string;
  avgCost: string;
  targetPrice: string;
  costUsdt: number | null;
  valueUsdt: number | null;
  lastPrice: number | null;
  distancePct: number | null;
  unrealizedPct: number | null;
  waitingSince: string;
  walletFree: number;
  walletLocked: number;
  walletTotal: number;
  excessFree: number;
  /** Ort. maliyete göre fiyat hareketi % (kademeli özet). */
  ladderMovePct: number | null;
  ladderDoneCount: number;
}

export interface GridDashboard {
  enabled: boolean;
  liveGate: boolean;
  tradingEnabled: string;
  marketDownturnForceActive: boolean;
  maxConcurrent: number;
  grids: GridStatusReport[];
  recovering: GridRecoveryRow[];
  candidates: GridCandidateRow[];
  marketGate: GridMarketGate;
  /** @deprecated marketGate.active */
  marketPanic: boolean;
  totals: {
    realizedPnlAllTime: string;
    cyclesAllTime: number;
    activeGrids: number;
    recoveringCount: number;
    realizedPnlToday: string;
    cyclesToday: number;
  };
  recentCycles: Array<{
    symbol: string;
    pnl: string;
    at: string;
    kind: 'cycle' | 'recovery';
    source?: string | null;
  }>;
  recentLogs: Array<{ id: number; event_type: string; created_at: string; payload: unknown }>;
}

async function buildRecoveringRows(env: Env): Promise<GridRecoveryRow[]> {
  const recovering = await getRecoveringGrids(env.DB);
  const actives = await getActiveGrids(env.DB);
  const client = new BinanceClient(env);
  const [balances, claimsMap] = await Promise.all([
    client.getAccountBalances(),
    buildSymbolWalletClaimsMap(env.DB, actives, recovering),
  ]);

  return Promise.all(
    recovering.map(async (g) => {
      const asset = g.symbol.replace(/USDT$/, '');
      const bal = balances.find((b) => b.asset === asset);
      const walletFree = Number(bal?.free ?? 0);
      const walletLocked = Number(bal?.locked ?? 0);
      const walletTotal = walletFree + walletLocked;
      const excessFree = computeExcessFree(walletFree, walletLocked, claimsMap.get(g.symbol));

      const target = Number(g.recovery_target_price ?? 0);
      const avg = Number(g.recovery_avg_cost ?? 0);
      const lastPrice = await wsPriceWithRestFallback(env, client, g.symbol);
      const distancePct =
        lastPrice != null && lastPrice > 0 && target > 0
          ? ((target - lastPrice) / lastPrice) * 100
          : null;
      const unrealizedPct =
        lastPrice != null && avg > 0 ? ((lastPrice - avg) / avg) * 100 : null;
      const qtyN = Number(g.recovery_qty ?? 0);
      const costUsdt = qtyN > 0 && avg > 0 ? qtyN * avg : null;
      const valueUsdt =
        qtyN > 0 && lastPrice != null && lastPrice > 0 ? qtyN * lastPrice : null;
      const ladderDone = parseRecoveryLadderDone(g.recovery_ladder_done);
      const ladderMovePctRaw =
        lastPrice != null && avg > 0 ? movePctFromAnchor(avg, lastPrice) : null;

      return {
        gridId: g.id,
        symbol: g.symbol,
        qty: g.recovery_qty ?? '0',
        avgCost: g.recovery_avg_cost ?? '0',
        targetPrice: g.recovery_target_price ?? '0',
        costUsdt: costUsdt != null ? Number(costUsdt.toFixed(2)) : null,
        valueUsdt: valueUsdt != null ? Number(valueUsdt.toFixed(2)) : null,
        lastPrice,
        distancePct: distancePct != null ? Number(distancePct.toFixed(3)) : null,
        unrealizedPct: unrealizedPct != null ? Number(unrealizedPct.toFixed(3)) : null,
        waitingSince: g.updated_at,
        walletFree: Number(walletFree.toFixed(8)),
        walletLocked: Number(walletLocked.toFixed(8)),
        walletTotal: Number(walletTotal.toFixed(8)),
        excessFree: Number(excessFree.toFixed(8)),
        ladderMovePct:
          ladderMovePctRaw != null ? Number(ladderMovePctRaw.toFixed(3)) : null,
        ladderDoneCount: ladderDone.length,
      };
    }),
  );
}

export type OrphanRecommend = 'sell' | 'recovery' | 'dust' | 'no_pair';

export interface OrphanBalanceRow {
  asset: string;
  symbol: string;
  free: number;
  locked: number;
  price: number | null;
  valueUsdt: number | null;
  avgCost: number | null;
  unrealizedPct: number | null;
  recommend: OrphanRecommend;
  /** Sembolde ACTIVE/RECOVERING varken grid dışı kalan serbest miktar. */
  excessUnderGrid?: boolean;
  walletTotal?: number;
}

export interface OrphanReport {
  thresholdUsdt: number;
  totalValueUsdt: number;
  actionableValueUsdt: number;
  dustValueUsdt: number;
  actionableCount: number;
  dustCount: number;
  rows: OrphanBalanceRow[];
}

const ORPHAN_IGNORE_ASSETS = new Set([
  'USDT',
  'BNB',
  'BUSD',
  'FDUSD',
  'USDC',
  'USDP',
  'TUSD',
  'DAI',
  'LUNC', // toz / işlem değeri yok — panelde gösterme
]);

/**
 * Cüzdandaki takipsiz (öksüz) bakiyeler: grid'i olmayan semboller + meşgul sembolde
 * grid kayıtlarının üstünde kalan serbest miktar (excess). BNB/stable hariç.
 */
export async function buildOrphanBalances(env: Env): Promise<OrphanReport> {
  const cfg = await getGridConfig(env.DB, env);
  const client = new BinanceClient(env);
  const [balances, prices, actives, recovering] = await Promise.all([
    client.getAccountBalances(),
    client.getAllSymbolPrices(),
    getActiveGrids(env.DB),
    getRecoveringGrids(env.DB),
  ]);

  const priceMap = new Map(prices.map((p) => [p.symbol, Number(p.price)]));
  const busy = new Set<string>([
    ...actives.map((g) => g.symbol),
    ...recovering.map((g) => g.symbol),
  ]);
  const claimsMap = await buildSymbolWalletClaimsMap(env.DB, actives, recovering);
  const threshold = 5; // Binance USDT pariteleri için tipik minNotional (~$5).
  const feePct = cfg.feeRoundtripPct / 100;

  type Candidate = { balance: (typeof balances)[0]; orphanFree: number; excessUnderGrid: boolean };
  const candidates: Candidate[] = [];

  for (const b of balances) {
    if (ORPHAN_IGNORE_ASSETS.has(b.asset)) continue;
    const free = Number(b.free);
    const locked = Number(b.locked);
    if (!(free > 0)) continue;
    const symbol = `${b.asset}USDT`;
    const claims = claimsMap.get(symbol);
    if (busy.has(symbol)) {
      const excess = computeExcessFree(free, locked, claims);
      if (excess > 0) candidates.push({ balance: b, orphanFree: excess, excessUnderGrid: true });
    } else {
      candidates.push({ balance: b, orphanFree: free, excessUnderGrid: false });
    }
  }

  const rows = await Promise.all(
    candidates.map(async ({ balance: b, orphanFree, excessUnderGrid }): Promise<OrphanBalanceRow> => {
      const free = orphanFree;
      const locked = Number(b.locked);
      const symbol = `${b.asset}USDT`;
      const walletTotal = Number(b.free) + locked;
      const price = priceMap.get(symbol) ?? null;
      if (price == null || !(price > 0)) {
        return {
          asset: b.asset,
          symbol,
          free,
          locked,
          price: null,
          valueUsdt: null,
          avgCost: null,
          unrealizedPct: null,
          recommend: 'no_pair',
          excessUnderGrid,
          walletTotal: excessUnderGrid ? walletTotal : undefined,
        };
      }
      const valueUsdt = free * price;
      if (valueUsdt < threshold) {
        return {
          asset: b.asset,
          symbol,
          free,
          locked,
          price,
          valueUsdt: Number(valueUsdt.toFixed(2)),
          avgCost: null,
          unrealizedPct: null,
          recommend: 'dust',
          excessUnderGrid,
          walletTotal: excessUnderGrid ? walletTotal : undefined,
        };
      }
      let avgCost: number | null = null;
      try {
        avgCost = avgCostFromTrades(await client.getMyTrades(symbol, 1000));
      } catch {
        avgCost = null;
      }
      const unrealizedPct =
        avgCost != null && avgCost > 0 ? ((price - avgCost) / avgCost) * 100 : null;
      const recommend: OrphanRecommend =
        avgCost == null || price >= avgCost * (1 + feePct) ? 'sell' : 'recovery';
      return {
        asset: b.asset,
        symbol,
        free,
        locked,
        price,
        valueUsdt: Number(valueUsdt.toFixed(2)),
        avgCost: avgCost != null ? Number(avgCost.toFixed(8)) : null,
        unrealizedPct: unrealizedPct != null ? Number(unrealizedPct.toFixed(2)) : null,
        recommend,
        excessUnderGrid,
        walletTotal: excessUnderGrid ? walletTotal : undefined,
      };
    }),
  );

  const rank: Record<OrphanRecommend, number> = { sell: 0, recovery: 1, dust: 2, no_pair: 3 };
  rows.sort(
    (a, b) => rank[a.recommend] - rank[b.recommend] || (b.valueUsdt ?? 0) - (a.valueUsdt ?? 0),
  );

  const actionable = rows.filter((r) => r.recommend === 'sell' || r.recommend === 'recovery');
  const dust = rows.filter((r) => r.recommend === 'dust');
  const sum = (arr: OrphanBalanceRow[]) => arr.reduce((s, r) => s + (r.valueUsdt ?? 0), 0);

  return {
    thresholdUsdt: threshold,
    totalValueUsdt: Number(sum(rows).toFixed(2)),
    actionableValueUsdt: Number(sum(actionable).toFixed(2)),
    dustValueUsdt: Number(sum(dust).toFixed(2)),
    actionableCount: actionable.length,
    dustCount: dust.length,
    rows,
  };
}

export async function buildGridDashboard(
  env: Env,
  opts: { includeCandidates?: boolean } = {},
): Promise<GridDashboard> {
  const includeCandidates = opts.includeCandidates ?? true;
  const cfg = await getGridConfig(env.DB, env);
  // Adaylar yavaş (REST kline fallback) -> çekirdek dashboard'u bloklamasın diye
  // varsayılan olarak ayrı endpoint'ten (progressive) çekilir.
  const [grids, candidateReport, recovering] = await Promise.all([
    buildGridStatuses(env),
    includeCandidates
      ? buildGridCandidatesReport(env)
      : (async (): Promise<GridCandidatesReport> => {
          const [marketGate, regimeCacheRow, lastGridWait] = await Promise.all([
            marketGateFromRegimeCache(env.DB, cfg),
            fetchRegimeCacheRow(env.DB),
            fetchLastGridWait(env.DB),
          ]);
          return {
            candidates: [],
            marketGate,
            regimeSummary: buildRegimeSummary({
              candidates: [],
              marketGate,
              cfg,
              regime: regimeCacheRow.regime,
              regimeCacheUpdatedAt: regimeCacheRow.updatedAt,
              lastGridWait,
            }),
            marketPanic: marketGate.active,
          };
        })(),
    buildRecoveringRows(env),
  ]);
  const candidates = candidateReport.candidates;

  const totalsRow = await env.DB.prepare(
    `SELECT COALESCE(SUM(CAST(realized_pnl AS REAL)),0) AS pnl,
            COALESCE(SUM(cycles),0) AS cyc,
            SUM(CASE WHEN status='ACTIVE' THEN 1 ELSE 0 END) AS act,
            SUM(CASE WHEN status='RECOVERING' THEN 1 ELSE 0 END) AS rec
     FROM grid_state`,
  ).first<{ pnl: number; cyc: number; act: number; rec: number }>();

  // Bugün realize (TR saati 00:00'dan beri): grid cycle + kurtarma dolumları.
  // created_at UTC saklanır; İstanbul (UTC+3) gün başlangıcı = date('now','+3h') @ 00:00 - 3h.
  const { results: cycleLogs } = await env.DB.prepare(
    `SELECT id, event_type, payload, created_at FROM trade_log
     WHERE event_type IN ('GRID_CYCLE','GRID_RECOVERY_FILLED')
       AND created_at >= datetime(date('now','+3 hours'),'-3 hours')
     ORDER BY id DESC`,
  ).all<{ id: number; event_type: string; payload: string; created_at: string }>();

  let realizedPnlToday = 0;
  const recentCycles = (cycleLogs ?? []).map((l) => {
    let p: { symbol?: string; pnl?: string; source?: string; max_adverse_pct?: string } = {};
    try {
      p = JSON.parse(l.payload);
    } catch {
      /* ignore */
    }
    realizedPnlToday += Number(p.pnl ?? 0) || 0;
    return {
      symbol: p.symbol ?? '—',
      pnl: p.pnl ?? '0',
      at: l.created_at,
      kind: (l.event_type === 'GRID_RECOVERY_FILLED' ? 'recovery' : 'cycle') as
        | 'recovery'
        | 'cycle',
      source: p.source ?? null,
      maxAdversePct: p.max_adverse_pct ?? null,
    };
  });

  const logs = await listTradeLogs(env.DB, {
    limit: 15,
    offset: 0,
    excludeEventTypes: ['GRID_MAINTAIN', 'SCOUT_RUN'],
  });

  return {
    enabled: cfg.enabled,
    liveGate: cfg.liveGate,
    tradingEnabled: String(env.TRADING_ENABLED ?? 'false'),
    marketDownturnForceActive: cfg.marketDownturnForceActive,
    maxConcurrent: cfg.maxConcurrent,
    grids,
    recovering,
    candidates,
    marketGate: candidateReport.marketGate,
    marketPanic: candidateReport.marketPanic,
    totals: {
      realizedPnlAllTime: Number(totalsRow?.pnl ?? 0).toFixed(4),
      cyclesAllTime: Number(totalsRow?.cyc ?? 0),
      activeGrids: Number(totalsRow?.act ?? 0),
      recoveringCount: Number(totalsRow?.rec ?? 0),
      realizedPnlToday: realizedPnlToday.toFixed(4),
      cyclesToday: recentCycles.length,
    },
    recentCycles,
    recentLogs: logs.map((l) => {
      let payload: unknown = l.payload;
      try {
        payload = JSON.parse(l.payload);
      } catch {
        /* keep raw */
      }
      return { id: l.id, event_type: l.event_type, created_at: l.created_at, payload };
    }),
  };
}
