/**
 * Spot Grid motoru (Faz 3).
 *
 * - Kurulum: aralık (auto: lookback kline percentile / manual), fee-wall'a göre
 *   sınırlı grid sayısı, fiyat altına LIMIT_MAKER alış merdiveni.
 * - Bakım: açık emir fill tespiti -> realize + karşı emir arm; trend koruması
 *   (alt/üst stop-out, envanter tavanı), range-reset.
 *
 * grid_enabled=false iken hiçbir şey yapmaz (additive).
 */
import {
  getGridConfig,
  getActiveGrids,
  getRecoveringGrids,
  getFlashCooldownSymbols,
  getRecentlyStoppedGridSymbols,
  getRecentFloorCycleSymbols,
  createGrid,
  stopGrid,
  addGridRealized,
  setGridRecovering,
  closeRecoveredGrid,
  listGridOrders,
  insertGridOrder,
  updateOpenGridSellExcursions,
  getPairedGridBuyFilledAt,
  markGridOrder,
  setGridOrderBinanceId,
  cancelAllGridOrders,
  cancelOpenGridOrdersBySide,
  updateGridRange,
  setGridOrderLevelIndex,
  getGridFilledStats,
  getGridById,
  type GridStateRow,
  type GridOrderRow,
  type GridConfig,
} from '../db/grid';
import { logEvent } from '../db/trade-log';
import {
  isBenignCancelError,
  isOrderGoneError,
  serializeBinanceError,
} from '../exchange/order-errors';
import { TradingGateway, netQtyFromBuy } from '../exchange/gateway';
import type { OrderResponse } from '../exchange/binance';
import {
  parseSymbolFilters,
  formatPrice,
  formatQuantity,
  meetsMinNotional,
  meetsMinQty,
} from '../exchange/symbol-filters';
import {
  computeGridLevels,
  gridSpacingPct,
  maxGridCountForFeeWall,
  meetsFeeWall,
  planInitialBuyOrders,
  selectNearestBuyPlan,
  selectLadderBuyTarget,
  dipBuyDeferTriggerPrice,
  dipBuyDeferReleasePrice,
  isDipBuyDeferArmed,
  shouldCancelDeferredDipBuy,
  shouldRepositionOpenBuys,
  sortBuyPlanNearestFirst,
  nextOrderAfterFill,
  levelsBlockingNewBuy,
  canPlaceNewBuyOrder,
  canPlaceBreakevenDipBuy,
  openBuyOrderCount,
  buySlotsUsed,
  gridHasFilledBuy,
  rangeStatus,
  recenterRange,
  nearestLevelIndex,
  isFloorExitOrder,
  computeFloorExitPrice,
  GRID_FLOOR_EXIT_LEVEL_INDEX,
  FLOOR_EXIT_BUY_COST_TAG,
} from '../strategy/grid';
import {
  evaluateGridReadiness,
  applyPriceChangePct3mPenalty,
  rollingReturnPct,
  minutesSinceSqliteUtc,
  type GridReadinessResult,
} from '../strategy/grid-readiness';
import {
  gridCycleEntryFromBuyCost,
  buildGridCycleAnalytics,
  resolveGridCycleExcursionPrices,
} from '../strategy/grid-cycle-analytics';
import { listWatchlist } from '../db/watchlist';
import {
  fetchKlinesFromDo,
  fetchReadinessKlines,
  fetchOrderbookMetrics,
  fetchSymbolMidPrice,
  ensureMarketDataWatchlist,
} from '../exchange/market-data-client';
import { bn } from '../math/decimal';
import { getConfig, setConfig } from '../db/bot-config';
import { resolveSellQtyFromWallet, getFreeBaseQty } from '../exchange/position-sell';
import { baseAssetFromSymbol } from '../exchange/fill-utils';
import {
  evaluateFlashDrop,
  evaluateFlashDropForScout,
  flashDropConfigFromGrid,
  flashDropBlocksBuys,
  gridAnchorPrice,
  type FlashDropResult,
} from '../strategy/grid-flash-drop';
import {
  finalizeCandidateReadiness,
  isPostExitCooldownActive,
  relaxedReadinessConfig,
} from '../strategy/grid-readiness';
import { capRecoverySellBaseQty } from '../strategy/grid-recovery-qty';
import { blockSetupForMarketDownturn } from '../strategy/grid-market-downturn';
import {
  blockSetupForDefensiveMode,
  isGridDefensiveExempt,
  resolveDefensiveMarketMode,
  shouldStopRecoveryAtTarget,
  type DefensiveMarketMode,
} from '../strategy/grid-defensive-mode';
import { convertRecoveryToUsdt } from './recovery-convert';
import { maybeAutoExecuteRecoveryLadder } from './recovery-ladder';
import {
  buyGuardConfigFromGrid,
  buildAssessmentLogPayload,
  buildGridBuyGuardAssessment,
  shouldBlockNewGridBuy,
  shouldCancelOpenGridBuys,
  shouldSkipRecenterForReadiness,
  shouldTeardownForReadiness,
  type GridBuyGuardAssessment,
} from '../strategy/grid-buy-guard';

/** maintainGrid turu boyunca grid başına flash alış engeli. */
const flashBuyBlockByGrid = new Map<number, boolean>();

/** maintainGrid turu başına tek readiness snapshot (gridId). */
const maintainBuyGuardByGridId = new Map<number, GridBuyGuardAssessment>();

/** runGridMaintenance başına bir kez çözümlenen savunma modu. */
let maintenanceDefensiveMode: DefensiveMarketMode | null = null;

function needsBuyGuardAssessment(cfg: GridConfig): boolean {
  if (cfg.rangeMode === 'manual') return false;
  return cfg.buyGuardEnabled || cfg.readinessTeardownEnabled || cfg.recenterRequiresReady;
}

async function loadBuyGuardContextMaps(
  env: Env,
  cfg: GridConfig,
): Promise<{
  recentlyStopped: Map<string, { stopReason: string | null; stoppedAt: string }>;
  recentFloors: Map<string, { cycledAt: string }>;
}> {
  const needStoppedMap =
    cfg.readinessPostExitRelaxEnabled || cfg.readinessPostExitCooldownEnabled;
  const recentlyStopped = needStoppedMap
    ? await getRecentlyStoppedGridSymbols(
        env.DB,
        cfg.readinessPostExitRelaxEnabled ? cfg.readinessPostExitRelaxDays : 1,
      )
    : new Map();
  const recentFloors = cfg.readinessPostExitCooldownEnabled
    ? await getRecentFloorCycleSymbols(env.DB, cfg.readinessPostExitCooldownMin)
    : new Map();
  return { recentlyStopped, recentFloors };
}

async function buildBuyGuardAssessment(
  env: Env,
  gateway: TradingGateway,
  cfg: GridConfig,
  grid: GridStateRow,
  lastPrice: number,
): Promise<GridBuyGuardAssessment | null> {
  if (!needsBuyGuardAssessment(cfg)) return null;

  const { recentlyStopped, recentFloors } = await loadBuyGuardContextMaps(env, cfg);
  const assessed = await assessCandidate(
    env,
    gateway,
    cfg,
    grid.symbol,
    recentlyStopped,
    recentFloors,
  );
  if (!assessed) return null;

  const wl = await listWatchlist(env.DB);
  const inWatchlist = wl.some((w) => w.symbol === grid.symbol);
  const flash = await buildFlashDropEvaluation(env, gateway, grid, cfg, lastPrice);

  return buildGridBuyGuardAssessment({
    readiness: assessed.readiness,
    lastPrice: assessed.lastPrice,
    inWatchlist,
    anchorPrice: gridAnchorPrice(grid, lastPrice),
    flashLevel: flash.level,
  });
}

async function getOrBuildBuyGuardAssessment(
  env: Env,
  gateway: TradingGateway,
  cfg: GridConfig,
  grid: GridStateRow,
  lastPrice: number,
): Promise<GridBuyGuardAssessment | null> {
  const cached = maintainBuyGuardByGridId.get(grid.id);
  if (cached) return cached;
  const snap = await buildBuyGuardAssessment(env, gateway, cfg, grid, lastPrice);
  if (snap) maintainBuyGuardByGridId.set(grid.id, snap);
  return snap;
}

function isBreakevenDip(cfg: GridConfig): boolean {
  return cfg.ladderMode === 'breakeven_dip';
}

function hasTrackedBag(stats: { boughtQty: number; soldQty: number }, lastPrice: number): boolean {
  const netQty = stats.boughtQty - stats.soldQty;
  return netQty > 0 && netQty * lastPrice >= GRID_INVENTORY_DUST_USDT;
}

function tradingEnabled(env: Env): boolean {
  return String(env.TRADING_ENABLED) === 'true';
}

const GRID_LOCK_TTL_MS = 50_000;

/** Yeni kurulan grid bu süre boyunca readiness-teardown'dan muaf (churn önleme). */
const GRID_TEARDOWN_GRACE_MS = 15 * 60_000;

/** Teardown'da bu USDT değerinin üzerindeki net envanter recovery'ye yönlendirilir
 * (altı satılamayan toz; orphan saymıyoruz). */
const GRID_INVENTORY_DUST_USDT = 1;

/** stepSize floor sonrası minNotional ($5) altına düşmemek için seviye başı USDT tamponu. */
const NOTIONAL_LEVEL_QUOTE_BUFFER = 1.12;

async function buildFlashDropEvaluation(
  env: Env,
  gateway: TradingGateway,
  grid: GridStateRow,
  cfg: GridConfig,
  lastPrice: number,
): Promise<FlashDropResult> {
  const anchor = gridAnchorPrice(grid, lastPrice);
  const bars = Math.max(4, Math.ceil(cfg.flashDropWindowMin / 5) + 2);
  let klinesRaw = await fetchKlinesFromDo(env, grid.symbol, '5m', bars);
  if (!klinesRaw || klinesRaw.length < 3) {
    try {
      klinesRaw = await gateway.binance.getKlines(grid.symbol, '5m', bars);
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
      atMs: dbTimestampMs(o.updated_at || o.created_at),
    }));

  const stats = await getGridFilledStats(env.DB, grid.id);

  return evaluateFlashDrop({
    anchorPrice: anchor,
    lastPrice,
    klineCloses,
    recentFilledBuys,
    filledBuyCostUsdt: stats.boughtCost,
    investmentUsdt: Number(grid.investment_usdt),
    nowMs: Date.now(),
    cfg: flashDropConfigFromGrid(cfg),
  });
}

async function applyFlashDropGuard(
  env: Env,
  gateway: TradingGateway,
  cfg: GridConfig,
  grid: GridStateRow,
  lastPrice: number,
  open: GridOrderRow[],
): Promise<boolean> {
  const flash = await buildFlashDropEvaluation(env, gateway, grid, cfg, lastPrice);

  if (flash.level !== 'none') {
    await logEvent(env.DB, 'GRID_FLASH_DROP', {
      symbol: grid.symbol,
      gridId: grid.id,
      level: flash.level,
      reasons: flash.reasons,
      metrics: flash.metrics,
      anchorPrice: gridAnchorPrice(grid, lastPrice),
      lastPrice,
    });
  }

  if (flashDropBlocksBuys(flash.level)) {
    flashBuyBlockByGrid.set(grid.id, true);
  }

  if (flash.level === 'recovery') {
    await enterRecovery(env, gateway, cfg, grid, lastPrice, 'flash_drop');
    return true;
  }

  if (flash.level === 'pause') {
    const openBuys = open.filter((o) => o.side === 'BUY');
    if (openBuys.length > 0) {
      const { filled, canceled } = await cancelOpenBuyOrders(
        env,
        gateway,
        cfg,
        grid,
        openBuys,
        lastPrice,
      );
      await logEvent(env.DB, 'GRID_FLASH_DROP_PAUSE', {
        symbol: grid.symbol,
        gridId: grid.id,
        canceledBuys: canceled,
        filledBeforeCancel: filled.length,
      });
    }
  }

  return false;
}

function gridCountForInvestment(
  investmentUsdt: number,
  cfgGridCount: number,
  maxFeeWall: number,
  minNotional: number,
): number | null {
  const maxByNotional =
    minNotional > 0
      ? Math.floor(investmentUsdt / (minNotional * NOTIONAL_LEVEL_QUOTE_BUFFER))
      : Infinity;
  const n = Math.min(cfgGridCount, maxFeeWall, maxByNotional);
  return n >= 2 ? n : null;
}

function buyQtyForGridLevel(
  quotePerLevel: number,
  price: number,
  filters: { stepSize: string; minQty: string; minNotional: string | number },
): string | null {
  const minNot = Number(filters.minNotional) || 0;
  const targetQuote = quotePerLevel * NOTIONAL_LEVEL_QUOTE_BUFFER;
  const qty = formatQuantity(String(targetQuote / price), filters.stepSize);
  const notional = bn(qty).times(price).toFixed(8);
  if (!meetsMinQty(qty, filters.minQty) || !meetsMinNotional(notional, String(minNot))) {
    return null;
  }
  return qty;
}

/** D1 timestamp'ı (UTC, 'YYYY-MM-DD HH:MM:SS') ms'ye çevir. Parse edilemezse 0. */
function dbTimestampMs(ts: string): number {
  if (!ts) return 0;
  const iso = ts.includes('T') ? ts : ts.replace(' ', 'T');
  const withZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`;
  const ms = Date.parse(withZone);
  return Number.isNaN(ms) ? 0 : ms;
}

/** Üst üste binen cron koşularını serileştir (fazladan grid açılmasını önle). */
async function acquireGridLock(env: Env): Promise<boolean> {
  const now = Date.now();
  const until = Number(await getConfig(env.DB, 'grid_run_lock', env)) || 0;
  if (now < until) return false;
  await setConfig(env.DB, 'grid_run_lock', String(now + GRID_LOCK_TTL_MS));
  return true;
}

async function releaseGridLock(env: Env): Promise<void> {
  await setConfig(env.DB, 'grid_run_lock', '0');
}

export async function runGridMaintenance(env: Env): Promise<void> {
  const cfg = await getGridConfig(env.DB, env);
  if (!cfg.enabled) return;

  // Eşzamanlılık kilidi: aynı anda yalnız bir koşu (yarış -> fazla grid -> over-capital önlenir).
  if (!(await acquireGridLock(env))) {
    await logEvent(env.DB, 'GRID_RUN_SKIP', { reason: 'locked' });
    return;
  }

  try {
    flashBuyBlockByGrid.clear();
    maintenanceDefensiveMode = null;
    const gateway = new TradingGateway(env);
    const wl = await listWatchlist(env.DB);
    const downturnSyms = cfg.useWatchlist
      ? wl.map((w) => w.symbol)
      : [cfg.symbol];
    maintenanceDefensiveMode = await resolveDefensiveMarketMode(
      env,
      gateway.binance,
      cfg,
      downturnSyms,
    );

    // 1) Tüm aktif grid'leri bakım yap (her biri kendi sembolünde).
    const actives = await getActiveGrids(env.DB);
    for (const g of actives) {
      try {
        await maintainGrid(env, gateway, cfg, g, maintenanceDefensiveMode);
      } catch (err) {
        await logEvent(env.DB, 'GRID_MAINTAIN_ERROR', {
          gridId: g.id,
          symbol: g.symbol,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const recovering = await getRecoveringGrids(env.DB);
    for (const g of recovering) {
      try {
        await maintainRecovery(env, gateway, cfg, g, maintenanceDefensiveMode);
      } catch (err) {
        await logEvent(env.DB, 'GRID_RECOVERY_ERROR', {
          gridId: g.id,
          symbol: g.symbol,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 2) Boş slot varsa hazır adaylara YENİ grid kur. maxConcurrent'i SIKI uygula:
    //    her createGrid öncesi aktif sayısını yeniden oku.
    const stillActive = await getActiveGrids(env.DB);
    const slots = Math.max(0, cfg.maxConcurrent - stillActive.length);
    if (slots > 0) {
      const exclude = new Set(stillActive.map((g) => g.symbol));
      if (!cfg.allowNewGridWhileRecovering) {
        for (const g of recovering) exclude.add(g.symbol);
      }
      await setupGrids(env, gateway, cfg, slots, exclude, maintenanceDefensiveMode);
    }
  } finally {
    maintenanceDefensiveMode = null;
    await releaseGridLock(env);
  }
}

async function fetchLastPrice(gateway: TradingGateway, symbol: string): Promise<number | null> {
  try {
    const p = await gateway.binance.getSymbolPrice(symbol);
    const n = Number(p);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

async function candidateSymbols(env: Env, cfg: GridConfig): Promise<string[]> {
  if (cfg.rangeMode === 'manual' || !cfg.useWatchlist) return [cfg.symbol];
  const wl = await listWatchlist(env.DB);
  const syms = wl.map((w) => w.symbol).filter((s) => s.endsWith('USDT'));
  return syms.length > 0 ? syms.slice(0, cfg.candidateCount) : [cfg.symbol];
}

/** Bir aday için readiness: WS (DO) önce, REST fallback. */
async function assessCandidate(
  env: Env,
  gateway: TradingGateway,
  cfg: GridConfig,
  symbol: string,
  recentlyStopped: Map<string, { stopReason: string | null; stoppedAt: string }> = new Map(),
  recentFloors: Map<string, { cycledAt: string }> = new Map(),
): Promise<{ readiness: GridReadinessResult; lastPrice: number } | null> {
  // klines: DO (WS-warmed) önce, REST fallback (daha uzun lookback için)
  const klinesRaw = await fetchReadinessKlines(env, gateway.binance, symbol, {
    lookbackBars: cfg.readinessLookback,
    stabilityBars: cfg.readinessStabilityBars,
    needFullStability:
      cfg.readinessMaxPathRangeRatio > 0 ||
      cfg.readinessMaxBarRangePathRatio > 0 ||
      cfg.readinessMaxStabilityRangePct > 0,
  });
  if (!klinesRaw) return null;
  const klines = klinesRaw.map((k) => ({
    high: Number(k.high),
    low: Number(k.low),
    close: Number(k.close),
  }));

  // lastPrice: DO book (WS) önce, REST fallback
  let lastPrice: number | null = null;
  const mid = await fetchSymbolMidPrice(env, symbol);
  if (mid && Number(mid) > 0) lastPrice = Number(mid);
  if (lastPrice == null) lastPrice = await fetchLastPrice(gateway, symbol);
  if (lastPrice == null) return null;

  // spread: DO metrics (WS)
  const obm = await fetchOrderbookMetrics(env, symbol);
  const spreadPct = obm && !obm.stale ? obm.spreadPct : null;

  const closes = klines.map((k) => k.close).filter((c) => c > 0);
  const readinessCfg = {
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
  const stoppedMap = recentlyStopped ?? new Map();
  const floorMap = recentFloors ?? new Map();
  const sym = symbol.toUpperCase();
  const recentStop = stoppedMap.get(sym);
  const recentFloor = floorMap.get(sym);
  const postExitCooldown = isPostExitCooldownActive(
    cfg.readinessPostExitCooldownEnabled,
    cfg.readinessPostExitCooldownMin,
    recentStop,
    recentFloor,
  );
  const postExitRelax =
    cfg.readinessPostExitRelaxEnabled && recentStop != null && !postExitCooldown;
  const effectiveCfg = postExitRelax
    ? relaxedReadinessConfig(readinessCfg)
    : readinessCfg;
  const base = evaluateGridReadiness({
    klines,
    lastPrice,
    spreadPct,
    config: effectiveCfg,
  });
  const merged = finalizeCandidateReadiness({
    base,
    closes,
    lastPrice,
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
  const klines1m = await fetchKlinesFromDo(env, symbol, '1m', 35);
  const priceChangePct3m = rollingReturnPct(lastPrice, klines1m, 3);
  const readiness = applyPriceChangePct3mPenalty(merged.readiness, priceChangePct3m);
  return { readiness, lastPrice };
}

/**
 * Boş slot kadar YENİ grid kur. Auto modda hazır adaylardan en yüksek skorlu
 * `slots` tanesi (zaten aktif olanlar hariç). Manual modda tek pinli sembol.
 */
async function setupGrids(
  env: Env,
  gateway: TradingGateway,
  cfg: GridConfig,
  slots: number,
  exclude: Set<string>,
  defensiveMode: DefensiveMarketMode | null,
): Promise<void> {
  const wl = await listWatchlist(env.DB);
  const downturnSyms = cfg.useWatchlist
    ? wl.map((w) => w.symbol)
    : [cfg.symbol];
  const defensive =
    defensiveMode ??
    (await resolveDefensiveMarketMode(env, gateway.binance, cfg, downturnSyms));
  if (await blockSetupForDefensiveMode(env.DB, defensive)) {
    return;
  }
  if (
    await blockSetupForMarketDownturn(env, gateway.binance, cfg, downturnSyms, {
      manualMode: cfg.rangeMode === 'manual',
    })
  ) {
    return;
  }

  // Manual mod: tek pinli sembol + manuel aralık (readiness atlanır).
  if (cfg.rangeMode === 'manual') {
    if (exclude.has(cfg.symbol)) return;
    if (!(cfg.upperPrice > cfg.lowerPrice && cfg.lowerPrice > 0)) {
      await logEvent(env.DB, 'GRID_SETUP_SKIP', { reason: 'manual_range_invalid', symbol: cfg.symbol });
      return;
    }
    const lastPrice = await fetchLastPrice(gateway, cfg.symbol);
    if (!lastPrice || rangeStatus(lastPrice, cfg.lowerPrice, cfg.upperPrice) !== 'in') {
      await logEvent(env.DB, 'GRID_SETUP_SKIP', { reason: 'manual_price_out_of_range', symbol: cfg.symbol, lastPrice });
      return;
    }
    await deployGrid(env, gateway, cfg, cfg.symbol, { lower: cfg.lowerPrice, upper: cfg.upperPrice }, lastPrice);
    return;
  }

  // Auto + readiness: adayları WS ile değerlendir, körü körüne girme.
  let candidates = (await candidateSymbols(env, cfg)).filter((s) => !exclude.has(s));

  if (cfg.flashDropSymbolCooldownMin > 0) {
    const cooled = await getFlashCooldownSymbols(env.DB, cfg.flashDropSymbolCooldownMin);
    candidates = candidates.filter((s) => !cooled.has(s));
  }

  const needStoppedMap =
    cfg.readinessPostExitRelaxEnabled || cfg.readinessPostExitCooldownEnabled;
  const recentlyStopped = needStoppedMap
    ? await getRecentlyStoppedGridSymbols(
        env.DB,
        cfg.readinessPostExitRelaxEnabled ? cfg.readinessPostExitRelaxDays : 1,
      )
    : new Map();
  const recentFloors = cfg.readinessPostExitCooldownEnabled
    ? await getRecentFloorCycleSymbols(env.DB, cfg.readinessPostExitCooldownMin)
    : new Map();

  const assessments: Array<{ symbol: string; readiness: GridReadinessResult; lastPrice: number }> = [];
  for (const symbol of candidates) {
    const a = await assessCandidate(env, gateway, cfg, symbol, recentlyStopped, recentFloors);
    if (a) assessments.push({ symbol, ...a });
  }

  const ready = assessments
    .filter((a) => a.readiness.ready && a.readiness.range)
    .sort((a, b) => b.readiness.score - a.readiness.score);

  if (ready.length === 0) {
    const blockers = assessments
      .map((a) => `${a.symbol}:${a.readiness.primaryBlocker ?? 'na'}`)
      .slice(0, 12);
    await logEvent(env.DB, 'GRID_WAIT', {
      reason: 'no_ready_candidate',
      scanned: assessments.length,
      slots,
      blockers,
    });
    return;
  }

  // Boş slot kadar en yüksek skorlu hazır adayları kur. maxConcurrent'i HER kurulumdan
  // önce yeniden okuyarak SIKI uygula (yarış olsa bile limit aşılmasın).
  const picks = ready.slice(0, slots);
  for (const pick of picks) {
    const activeNow = await getActiveGrids(env.DB);
    if (activeNow.length >= cfg.maxConcurrent) break;
    if (activeNow.some((g) => g.symbol === pick.symbol)) continue;
    await logEvent(env.DB, 'GRID_CANDIDATE_PICKED', {
      symbol: pick.symbol,
      score: Number(pick.readiness.score.toFixed(2)),
      efficiencyRatio: pick.readiness.efficiencyRatio,
      rangeWidthPct: pick.readiness.rangeWidthPct,
      atrPct: pick.readiness.atrPct,
      range: pick.readiness.range,
    });
    await deployGrid(env, gateway, cfg, pick.symbol, pick.readiness.range!, pick.lastPrice);
  }
}

/** LIMIT_MAKER satış: fiyat her zaman güncel fiyatın ÜSTÜNDE olmalı (yoksa taker -> red). */
function makerSellPrice(target: number, lastPrice: number, tickSize: string): string {
  const tick = Number(tickSize) || 0;
  const desired = Math.max(target, lastPrice + tick);
  let s = formatPrice(String(desired), tickSize);
  let guard = 0;
  while (Number(s) <= lastPrice && guard < 20) {
    s = formatPrice(String(Number(s) + (tick || Number(s) * 0.0001)), tickSize);
    guard++;
  }
  return s;
}

function avgFillPriceFromBuyOrder(order: OrderResponse): number | null {
  const exec = Number(order.executedQty);
  const quote = Number(order.cummulativeQuoteQty);
  if (exec > 0 && quote > 0) return quote / exec;
  const fills = order.fills ?? [];
  if (fills.length === 0) return null;
  let qtySum = 0;
  let quoteSum = 0;
  for (const f of fills) {
    const q = Number(f.qty);
    const p = Number(f.price);
    if (q > 0 && p > 0) {
      qtySum += q;
      quoteSum += q * p;
    }
  }
  return qtySum > 0 ? quoteSum / qtySum : null;
}

/** Classic: dolu alış sonrası üst seviye SELL arm (maintain ile aynı mantık). */
async function armSellAfterBuyFill(
  env: Env,
  gateway: TradingGateway,
  cfg: GridConfig,
  grid: GridStateRow,
  buyLevelIndex: number,
  buyQty: string,
  buyPrice: string,
  levels: number[],
  lastPrice: number,
  filters: ReturnType<typeof parseSymbolFilters>,
): Promise<boolean> {
  const next = nextOrderAfterFill(buyLevelIndex, 'BUY', levels, Number(grid.investment_usdt));
  if (!next || next.side !== 'SELL') return false;
  const price = makerSellPrice(next.price, lastPrice, filters.tickSize);
  const qty = formatQuantity(buyQty, filters.stepSize);
  const notional = bn(qty).times(price).toFixed(8);
  if (!meetsMinQty(qty, filters.minQty) || !meetsMinNotional(notional, filters.minNotional)) {
    await logEvent(env.DB, 'GRID_REARM_SKIP', {
      symbol: grid.symbol,
      gridId: grid.id,
      levelIndex: next.levelIndex,
      qty,
      price,
      notional,
      minNotional: filters.minNotional,
      context: 'setup_market_entry',
    });
    return false;
  }
  const buyCost = bn(buyQty).times(buyPrice).toFixed(8);
  return placeGridOrder(
    env,
    gateway,
    cfg,
    grid.symbol,
    grid.id,
    next.levelIndex,
    'SELL',
    price,
    qty,
    buyCost,
  );
}

/**
 * Kurulumda bir seviye payı MARKET alım (grid_setup_market_entry).
 * buyGuard atlanır; readiness kurulum öncesi geçilmiş sayılır.
 */
async function placeSetupMarketEntry(
  env: Env,
  gateway: TradingGateway,
  cfg: GridConfig,
  grid: GridStateRow,
  symbol: string,
  levels: number[],
  lastPrice: number,
  filters: ReturnType<typeof parseSymbolFilters>,
  quotePerLevel: number,
): Promise<boolean> {
  const realMode = tradingEnabled(env) && cfg.liveGate;
  const quoteStr = bn(quotePerLevel).toFixed(2);
  let fillPrice: number;
  let qtyStr: string;
  let binanceOrderId: string;

  if (realMode) {
    let order: OrderResponse;
    try {
      order = await gateway.marketBuy(symbol, quoteStr);
    } catch (err) {
      await logEvent(env.DB, 'GRID_SETUP_MARKET_BUY_FAILED', {
        symbol,
        gridId: grid.id,
        quoteUsdt: quoteStr,
        ...serializeBinanceError(err),
      });
      return false;
    }
    const net = netQtyFromBuy(order, symbol);
    qtyStr = formatQuantity(net.net_base_qty, filters.stepSize);
    if (!meetsMinQty(qtyStr, filters.minQty)) {
      await logEvent(env.DB, 'GRID_SETUP_MARKET_BUY_FAILED', {
        symbol,
        gridId: grid.id,
        reason: 'qty_below_min',
        qty: qtyStr,
        minQty: filters.minQty,
      });
      return false;
    }
    fillPrice = avgFillPriceFromBuyOrder(order) ?? lastPrice;
    const notional = bn(qtyStr).times(fillPrice).toFixed(8);
    if (!meetsMinNotional(notional, filters.minNotional)) {
      await logEvent(env.DB, 'GRID_SETUP_MARKET_BUY_FAILED', {
        symbol,
        gridId: grid.id,
        reason: 'notional_below_min',
        notional,
        minNotional: filters.minNotional,
      });
      return false;
    }
    binanceOrderId = String(order.orderId);
  } else {
    const paperQty = buyQtyForGridLevel(quotePerLevel, lastPrice, filters);
    if (!paperQty) {
      await logEvent(env.DB, 'GRID_SETUP_MARKET_BUY_FAILED', {
        symbol,
        gridId: grid.id,
        reason: 'paper_qty_invalid',
        quoteUsdt: quoteStr,
        lastPrice,
      });
      return false;
    }
    qtyStr = paperQty;
    fillPrice = lastPrice;
    binanceOrderId = `mock-market-${grid.id}-${Date.now()}`;
  }

  const levelIndex = nearestLevelIndex(fillPrice, levels);
  const priceStr = formatPrice(String(fillPrice), filters.tickSize);

  let orderId: number;
  try {
    orderId = await insertGridOrder(env.DB, {
      gridId: grid.id,
      levelIndex,
      side: 'BUY',
      price: priceStr,
      qty: qtyStr,
      binanceOrderId,
    });
    await markGridOrder(env.DB, orderId, 'FILLED');
  } catch (err) {
    await logEvent(env.DB, 'GRID_SETUP_MARKET_BUY_FAILED', {
      symbol,
      gridId: grid.id,
      reason: 'db_insert_failed',
      message: err instanceof Error ? err.message : String(err),
      binanceOrderId,
    });
    return false;
  }

  await logEvent(env.DB, 'GRID_SETUP_MARKET_BUY', {
    symbol,
    gridId: grid.id,
    quoteUsdt: quoteStr,
    executedQty: qtyStr,
    avgPrice: fillPrice,
    levelIndex,
    ladderMode: cfg.ladderMode,
    realMode,
  });

  if (isBreakevenDip(cfg)) {
    const floorSync = await syncFloorExitSell(env, gateway, cfg, grid, lastPrice, filters);
    if (floorSync.changed) {
      await logEvent(env.DB, 'GRID_FLOOR_EXIT_SYNC', {
        symbol: grid.symbol,
        gridId: grid.id,
        action: floorSync.action,
        price: floorSync.price,
        qty: floorSync.qty,
        avgCost: floorSync.avgCost,
        context: 'setup_market_entry',
      });
    }
  } else {
    await armSellAfterBuyFill(
      env,
      gateway,
      cfg,
      grid,
      levelIndex,
      qtyStr,
      priceStr,
      levels,
      lastPrice,
      filters,
    );
  }

  return true;
}

/** LIMIT_MAKER alış: fiyat her zaman güncel fiyatın ALTINDA olmalı (yoksa taker -> red). */
function makerBuyPrice(target: number, lastPrice: number, tickSize: string): string {
  const tick = Number(tickSize) || 0;
  const desired = Math.min(target, lastPrice - tick);
  let s = formatPrice(String(desired), tickSize);
  let guard = 0;
  while (Number(s) >= lastPrice && guard < 20) {
    s = formatPrice(String(Number(s) - (tick || Number(s) * 0.0001)), tickSize);
    guard++;
  }
  return s;
}

async function deployGrid(
  env: Env,
  gateway: TradingGateway,
  cfg: GridConfig,
  symbol: string,
  range: { lower: number; upper: number },
  lastPrice: number,
): Promise<void> {
  if (cfg.flashDropEnabled) {
    const bars = Math.max(4, Math.ceil(cfg.flashDropWindowMin / 5) + 2);
    let klinesRaw = await fetchKlinesFromDo(env, symbol, '5m', bars);
    if (!klinesRaw || klinesRaw.length < 3) {
      try {
        klinesRaw = await gateway.binance.getKlines(symbol, '5m', bars);
      } catch {
        klinesRaw = null;
      }
    }
    const klineCloses = (klinesRaw ?? []).map((k) => Number(k.close)).filter((c) => c > 0);
    const flash = evaluateFlashDropForScout({
      lastPrice,
      klineCloses,
      cfg: flashDropConfigFromGrid(cfg),
    });
    const pauseRank = { none: 0, warn: 1, pause: 2, recovery: 3 } as const;
    if (pauseRank[flash.level] >= pauseRank.pause) {
      await logEvent(env.DB, 'GRID_SETUP_SKIP', {
        reason: 'flash_drop_recent',
        symbol,
        level: flash.level,
        reasons: flash.reasons,
        metrics: flash.metrics,
        lastPrice,
      });
      return;
    }
  }

  const info = await gateway.binance.getExchangeInfo(symbol);
  const symInfo = info.symbols[0];
  if (!symInfo) return;
  const filters = parseSymbolFilters(symInfo);

  // fee-wall: grid sayısını spacing >= fee*multiple olacak şekilde sınırla
  const maxN = maxGridCountForFeeWall(range.lower, range.upper, cfg.feeRoundtripPct, cfg.feeWallMultiple);
  // notional duvarı: seviye başı tutar (investment/gridCount) minNotional'ı %5 marjla geçmeli
  // (yoksa SELL re-arm "Filter failure: NOTIONAL" ile patlar -> izlenmeyen bag).
  // %20 tampon: qty stepSize'a yuvarlanınca ve SELL tarafı aynı qty'yi biraz farklı
  // fiyattan kullandığında notional minNotional'ın altına düşmesin.
  const minNot = Number(filters.minNotional) || 0;
  const gridCount = gridCountForInvestment(cfg.investmentUsdt, cfg.gridCount, maxN, minNot);
  if (gridCount == null) {
    const minInvest = minNot > 0 ? Math.ceil(minNot * NOTIONAL_LEVEL_QUOTE_BUFFER * 2) : null;
    await logEvent(env.DB, 'GRID_SETUP_SKIP', {
      reason: 'investment_below_min_notional',
      symbol,
      investmentUsdt: cfg.investmentUsdt,
      minNotional: minNot,
      minInvestmentUsdtHint: minInvest,
      requestedGridCount: cfg.gridCount,
    });
    return;
  }
  const spacing = gridSpacingPct(range.lower, range.upper, gridCount);
  if (!meetsFeeWall(spacing, cfg.feeRoundtripPct, cfg.feeWallMultiple)) {
    await logEvent(env.DB, 'GRID_SETUP_SKIP', {
      reason: 'fee_wall',
      symbol,
      spacing,
      feeRoundtripPct: cfg.feeRoundtripPct,
    });
    return;
  }

  const levels = computeGridLevels(range.lower, range.upper, gridCount);
  const plan = planInitialBuyOrders(levels, lastPrice, cfg.investmentUsdt);
  const quotePerLevel = cfg.investmentUsdt / gridCount;

  const grid = await createGrid(env.DB, {
    symbol,
    lower: range.lower,
    upper: range.upper,
    gridCount,
    investmentUsdt: cfg.investmentUsdt,
    anchorPrice: lastPrice,
  });

  let placed = 0;
  let marketEntryDone = false;
  if (cfg.setupMarketEntry) {
    marketEntryDone = await placeSetupMarketEntry(
      env,
      gateway,
      cfg,
      grid,
      symbol,
      levels,
      lastPrice,
      filters,
      quotePerLevel,
    );
    if (marketEntryDone) placed++;
  }

  if (isBreakevenDip(cfg)) {
    if (!marketEntryDone) {
      const target = selectLadderBuyTarget(plan, false, new Set());
      if (target) {
        const price = makerBuyPrice(target.price, lastPrice, filters.tickSize);
        const qty = buyQtyForGridLevel(quotePerLevel, Number(price), filters);
        if (qty) {
          const ok = await placeGridOrder(
            env,
            gateway,
            cfg,
            symbol,
            grid.id,
            target.levelIndex,
            'BUY',
            price,
            qty,
            null,
          );
          if (ok) placed++;
        }
      }
    }
  } else {
    const buyPlan = sortBuyPlanNearestFirst(plan);
    for (const o of buyPlan) {
      const allOrders = await listGridOrders(env.DB, grid.id);
      if (!canPlaceNewBuyOrder(allOrders, cfg.maxConsecutiveBuys)) break;
      const price = makerBuyPrice(o.price, lastPrice, filters.tickSize);
      const qty = buyQtyForGridLevel(quotePerLevel, Number(price), filters);
      if (!qty) continue;
      const ok = await placeGridOrder(env, gateway, cfg, symbol, grid.id, o.levelIndex, 'BUY', price, qty, null);
      if (ok) placed++;
    }
  }

  if (placed === 0) {
    await logEvent(env.DB, 'GRID_SETUP_SKIP', {
      reason: 'no_buys_placed',
      symbol,
      gridId: grid.id,
      investmentUsdt: cfg.investmentUsdt,
      gridCount,
      minNotional: minNot,
      plannedBuys: plan.length,
    });
  }

  const parallelRecovering = (await getRecoveringGrids(env.DB)).filter((g) => g.symbol === symbol);
  await logEvent(env.DB, 'GRID_SETUP', {
    symbol,
    gridId: grid.id,
    lower: range.lower,
    upper: range.upper,
    gridCount,
    spacingPct: spacing,
    buysPlaced: placed,
    setupMarketEntry: cfg.setupMarketEntry,
    marketEntryDone,
    investmentUsdt: cfg.investmentUsdt,
    live: tradingEnabled(env) && cfg.liveGate,
    mode: tradingEnabled(env) && cfg.liveGate ? 'live' : 'paper',
    parallelRecoveringGridId: parallelRecovering[0]?.id ?? null,
    allowNewGridWhileRecovering: cfg.allowNewGridWhileRecovering,
  });

  const wl = await listWatchlist(env.DB);
  const watchSymbols = [...new Set([...wl.map((w) => w.symbol), symbol])];
  await ensureMarketDataWatchlist(env, watchSymbols);
}

async function placeGridOrder(
  env: Env,
  gateway: TradingGateway,
  cfg: GridConfig,
  symbol: string,
  gridId: number,
  levelIndex: number,
  side: 'BUY' | 'SELL',
  price: string,
  qty: string,
  buyCost: string | null,
  cycleTracking?: { entryPrice: string; troughPrice?: string; peakPrice?: string } | null,
): Promise<boolean> {
  if (side === 'BUY') {
    if (flashBuyBlockByGrid.get(gridId)) {
      await logEvent(env.DB, 'GRID_BUY_BLOCKED', {
        symbol,
        gridId,
        levelIndex,
        reason: 'flash_drop_guard',
      });
      return false;
    }
    const allOrders = await listGridOrders(env.DB, gridId);
    const blocked = levelsBlockingNewBuy(allOrders);
    if (blocked.has(levelIndex)) {
      await logEvent(env.DB, 'GRID_BUY_BLOCKED', {
        symbol,
        gridId,
        levelIndex,
        reason: 'duplicate_buy_guard',
      });
      return false;
    }
    const buyCapOk = isBreakevenDip(cfg)
      ? canPlaceBreakevenDipBuy(allOrders)
      : canPlaceNewBuyOrder(allOrders, cfg.maxConsecutiveBuys);
    if (!buyCapOk) {
      await logEvent(env.DB, 'GRID_BUY_BLOCKED', {
        symbol,
        gridId,
        levelIndex,
        reason: isBreakevenDip(cfg) ? 'dip_open_buy_exists' : 'consecutive_buy_cap',
        maxConsecutiveBuys: isBreakevenDip(cfg) ? 1 : cfg.maxConsecutiveBuys,
        buySlotsUsed: buySlotsUsed(allOrders),
        openBuys: openBuyOrderCount(allOrders),
      });
      return false;
    }

    if (cfg.buyGuardEnabled) {
      const gridRow = await getGridById(env.DB, gridId);
      const lp = await fetchLastPrice(gateway, symbol);
      if (gridRow && lp) {
        const snap = await getOrBuildBuyGuardAssessment(env, gateway, cfg, gridRow, lp);
        if (snap) {
          const guardCfg = buyGuardConfigFromGrid(cfg);
          const blockDecision = shouldBlockNewGridBuy(snap, guardCfg);
          if (blockDecision.block) {
            await logEvent(env.DB, 'GRID_BUY_BLOCKED_READINESS', {
              symbol,
              gridId,
              levelIndex,
              reason: blockDecision.reason,
              ...(cfg.buyLogAssessment ? buildAssessmentLogPayload(snap) : {}),
            });
            return false;
          }
        }
      }
    }
  }

  // GÜVENLİK: gerçek emir YALNIZCA tradingEnabled && liveGate. Aksi halde
  // gateway'e hiç dokunma (TRADING_ENABLED=true olsa bile gerçek emir gitmesin).
  let binanceOrderId: string | null = null;
  const realMode = tradingEnabled(env) && cfg.liveGate;
  if (realMode) {
    try {
      const order = await gateway.placeGridLimit(symbol, side, qty, price);
      binanceOrderId = String(order.orderId);
    } catch (err) {
      await logEvent(env.DB, 'GRID_ORDER_PLACE_FAILED', {
        symbol,
        gridId,
        levelIndex,
        side,
        price,
        qty,
        ...serializeBinanceError(err),
      });
      return false;
    }
  } else {
    // mock / live_gate kapalı: kayıt tut, fill price-cross ile simüle edilir (gerçek emir yok)
    binanceOrderId = `mock-${gridId}-${levelIndex}-${side}-${Date.now()}`;
  }
  try {
    const cycleEntry =
      cycleTracking?.entryPrice ??
      (side === 'SELL' && buyCost && buyCost !== FLOOR_EXIT_BUY_COST_TAG
        ? gridCycleEntryFromBuyCost(buyCost, qty)
        : null);
    await insertGridOrder(env.DB, {
      gridId,
      levelIndex,
      side,
      price,
      qty,
      binanceOrderId,
      buyCost,
      cycleEntryPrice: cycleEntry,
      cycleTroughPrice: cycleTracking?.troughPrice ?? cycleEntry,
      cyclePeakPrice: cycleTracking?.peakPrice ?? cycleEntry,
    });
    return true;
  } catch (err) {
    // DB insert başarısız (ör. UNIQUE(grid_id, level_index, status): seviye zaten
    // dolu). Gerçek modda emir borsaya GİTTİ ama DB'ye yazılamadı -> izlenemez
    // orphan kalmasın diye iptal et. Ayrıca exception'ı yutarak tüm maintain
    // turunun (diğer gridler dahil) çökmesini engelle.
    if (realMode && binanceOrderId && !binanceOrderId.startsWith('mock-')) {
      try {
        await gateway.cancelOrder(symbol, binanceOrderId);
      } catch (cancelErr) {
        await logGridBinanceApi(env, 'cancelOrder', cancelErr, {
          symbol,
          gridId,
          binanceOrderId,
          levelIndex,
          side,
          scope: 'rollback_after_insert_failed',
        });
      }
    }
    await logEvent(env.DB, 'GRID_ORDER_INSERT_FAILED', {
      symbol,
      side,
      price,
      qty,
      levelIndex,
      gridId,
      binanceOrderId,
      message: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

function exchangeOrderHasFill(status: string): boolean {
  return status === 'FILLED' || status === 'PARTIALLY_FILLED';
}

/** Grid motoru Binance API hatalarını trade_log'a yazar (beklenen → WARN). */
async function logGridBinanceApi(
  env: Env,
  operation: string,
  err: unknown,
  ctx: Record<string, string | number | boolean | null | undefined>,
): Promise<void> {
  const benign =
    operation === 'cancelOrder'
      ? isBenignCancelError(err)
      : operation === 'getOrder'
        ? isOrderGoneError(err)
        : false;
  await logEvent(
    env.DB,
    benign ? 'GRID_BINANCE_API_WARN' : 'GRID_BINANCE_API_ERROR',
    {
      operation,
      ...serializeBinanceError(err),
      ...ctx,
    },
  );
}

async function isOrderFilled(
  env: Env,
  gateway: TradingGateway,
  cfg: GridConfig,
  symbol: string,
  order: GridOrderRow,
  lastPrice: number,
): Promise<boolean> {
  if (tradingEnabled(env) && cfg.liveGate && order.binance_order_id && !order.binance_order_id.startsWith('mock-')) {
    try {
      const o = await gateway.getOrder(symbol, order.binance_order_id);
      return exchangeOrderHasFill(o.status);
    } catch (err) {
      await logGridBinanceApi(env, 'getOrder', err, {
        symbol,
        gridId: null,
        binanceOrderId: order.binance_order_id,
        levelIndex: order.level_index,
        side: order.side,
      });
      return false;
    }
  }
  // mock / live_gate kapalı: price-cross
  const price = Number(order.price);
  return order.side === 'BUY' ? lastPrice <= price : lastPrice >= price;
}

/** İptal öncesi: borsada dolmuş OPEN alışları FILLED yap (DB'de CANCELED yazma). */
async function markFilledBuyOrdersFromExchange(
  env: Env,
  gateway: TradingGateway,
  cfg: GridConfig,
  grid: GridStateRow,
  orders: GridOrderRow[],
  lastPrice: number,
): Promise<GridOrderRow[]> {
  const marked: GridOrderRow[] = [];
  for (const o of orders) {
    if (o.side !== 'BUY' || o.status !== 'OPEN') continue;
    if (!(await isOrderFilled(env, gateway, cfg, grid.symbol, o, lastPrice))) continue;
    await markGridOrder(env.DB, o.id, 'FILLED');
    marked.push({ ...o, status: 'FILLED' });
  }
  return marked;
}

async function maintainGrid(
  env: Env,
  gateway: TradingGateway,
  cfg: GridConfig,
  grid: GridStateRow,
  defensiveMode: DefensiveMarketMode | null,
): Promise<void> {
  const lastPrice = await fetchLastPrice(gateway, grid.symbol);
  if (!lastPrice) return;

  await updateOpenGridSellExcursions(env.DB, grid.id, String(lastPrice));

  if (defensiveMode?.active) {
    const defensiveTeardown = await maybeDefensiveTeardownGrid(
      env,
      gateway,
      cfg,
      grid,
      lastPrice,
      defensiveMode,
    );
    if (defensiveTeardown) return;
  }

  const lower = Number(grid.lower_price);
  const upper = Number(grid.upper_price);
  const status = rangeStatus(lastPrice, lower, upper);

  // Trend koruması: alt/üst stop-out
  const stopBelow = lower * (1 - cfg.stopBelowPct / 100);
  const stopAbove = upper * (1 + cfg.stopAbovePct / 100);
  if (lastPrice <= stopBelow) {
    await enterRecovery(env, gateway, cfg, grid, lastPrice, 'stop_below_range');
    return;
  }
  if (lastPrice >= stopAbove) {
    // Üst sınırda da kalan envanteri zararına/sahipsiz bırakma: recovery (fiyat market
    // üstü olduğundan ~anında kârla satar); envanter yoksa enterRecovery düz kapatır.
    const openNow = await listGridOrders(env.DB, grid.id, 'OPEN');
    const stats = await getGridFilledStats(env.DB, grid.id);
    const hasBag = stats.boughtQty - stats.soldQty > 0 || openNow.some((o) => o.side === 'SELL');
    if (hasBag) {
      await enterRecovery(env, gateway, cfg, grid, lastPrice, 'stop_above_range');
    } else {
      await closeGrid(env, gateway, cfg, grid, 'stop_above_range', lastPrice);
    }
    return;
  }

  const openForFlash = await listGridOrders(env.DB, grid.id, 'OPEN');
  if (cfg.flashDropEnabled) {
    const flashStopped = await applyFlashDropGuard(
      env,
      gateway,
      cfg,
      grid,
      lastPrice,
      openForFlash,
    );
    if (flashStopped) return;
  }

  maintainBuyGuardByGridId.delete(grid.id);
  const buyGuardSnap = needsBuyGuardAssessment(cfg)
    ? await getOrBuildBuyGuardAssessment(env, gateway, cfg, grid, lastPrice)
    : null;
  const guardCfg = buyGuardConfigFromGrid(cfg);

  if (buyGuardSnap && cfg.buyGuardEnabled && cfg.buyCancelOpenOnNotReady) {
    const openBuys = openForFlash.filter((o) => o.side === 'BUY');
    const cancelDecision = shouldCancelOpenGridBuys(buyGuardSnap, guardCfg);
    if (openBuys.length > 0 && cancelDecision.block) {
      const { filled, canceled } = await cancelOpenBuyOrders(
        env,
        gateway,
        cfg,
        grid,
        openBuys,
        lastPrice,
      );
      for (const order of filled) {
        if (cfg.buyLogAssessment && buyGuardSnap) {
          await logEvent(env.DB, 'GRID_BUY_FILL_ASSESSMENT', {
            symbol: grid.symbol,
            gridId: grid.id,
            fillPrice: order.price,
            qty: order.qty,
            anchorPrice: gridAnchorPrice(grid, lastPrice),
            reconciledBeforeCancel: true,
            ...buildAssessmentLogPayload(buyGuardSnap),
          });
        }
      }
      if (canceled > 0) {
        await logEvent(env.DB, 'GRID_BUY_CANCELED_READINESS', {
          symbol: grid.symbol,
          gridId: grid.id,
          reason: cancelDecision.reason,
          canceled,
          filledBeforeCancel: filled.length,
          ...(cfg.buyLogAssessment ? buildAssessmentLogPayload(buyGuardSnap) : {}),
        });
      } else if (filled.length > 0) {
        await logEvent(env.DB, 'GRID_BUY_CANCEL_SKIPPED_FILLED', {
          symbol: grid.symbol,
          gridId: grid.id,
          reason: cancelDecision.reason,
          filled: filled.length,
          ...(cfg.buyLogAssessment ? buildAssessmentLogPayload(buyGuardSnap) : {}),
        });
      }
    }
  }

  // Re-center: yalnızca henüz dolu alış yokken (flat merdiven). Dolu alış sonrası iptal +
  // yeni alış merdiveni envanter/çift alış riski yaratır.
  if (cfg.recenterEnabled && !flashBuyBlockByGrid.get(grid.id)) {
    const mid = (lower + upper) / 2;
    const half = (upper - lower) / 2;
    const driftFrac = half > 0 ? Math.abs(lastPrice - mid) / half : 0;
    if (driftFrac >= cfg.recenterDriftPct / 100) {
      const allOrders = await listGridOrders(env.DB, grid.id);
      if (gridHasFilledBuy(allOrders)) {
        await logEvent(env.DB, 'GRID_RECENTER_SKIP', {
          symbol: grid.symbol,
          gridId: grid.id,
          reason: 'filled_buy_exists',
          driftFrac,
          lastPrice,
        });
      } else {
        const recenterSkip = buyGuardSnap
          ? shouldSkipRecenterForReadiness(buyGuardSnap, guardCfg)
          : { block: false, reason: null };
        if (recenterSkip.block) {
          await logEvent(env.DB, 'GRID_RECENTER_SKIP', {
            symbol: grid.symbol,
            gridId: grid.id,
            reason: 'readiness_not_ready',
            blocker: recenterSkip.reason,
            driftFrac,
            lastPrice,
            ...(cfg.buyLogAssessment && buyGuardSnap
              ? buildAssessmentLogPayload(buyGuardSnap)
              : {}),
          });
        } else {
          await recenterGrid(env, gateway, cfg, grid, lastPrice);
          return;
        }
      }
    }
  }

  const info = await gateway.binance.getExchangeInfo(grid.symbol);
  const symInfo = info.symbols[0];
  if (!symInfo) return;
  const filters = parseSymbolFilters(symInfo);
  const levels = computeGridLevels(lower, upper, grid.grid_count);

  const open = await listGridOrders(env.DB, grid.id, 'OPEN');

  // envanter (bag) tavanı: dolmuş alış - satılmamış
  let inventoryCost = 0;
  for (const o of open) {
    if (o.side === 'SELL' && o.buy_cost) inventoryCost += Number(o.buy_cost);
  }
  const inventoryGuardHit = cfg.maxInventoryUsdt > 0 && inventoryCost > cfg.maxInventoryUsdt;

  let fills = 0;
  for (const order of open) {
    const filled = await isOrderFilled(env, gateway, cfg, grid.symbol, order, lastPrice);
    if (!filled) continue;
    fills++;
    await markGridOrder(env.DB, order.id, 'FILLED');

    if (order.side === 'BUY') {
      const snap = maintainBuyGuardByGridId.get(grid.id) ?? buyGuardSnap;
      if (cfg.buyLogAssessment && snap) {
        await logEvent(env.DB, 'GRID_BUY_FILL_ASSESSMENT', {
          symbol: grid.symbol,
          gridId: grid.id,
          fillPrice: order.price,
          qty: order.qty,
          anchorPrice: gridAnchorPrice(grid, lastPrice),
          ...buildAssessmentLogPayload(snap),
        });
      }
    }

    const next = nextOrderAfterFill(order.level_index, order.side, levels, Number(grid.investment_usdt));

    if (order.side === 'SELL') {
      const proceeds = bn(order.qty).times(order.price);
      const fillStats = await getGridFilledStats(env.DB, grid.id);
      const cost = isFloorExitOrder(order)
        ? bn(order.qty).times(
            fillStats.boughtQty > 0 ? fillStats.boughtCost / fillStats.boughtQty : Number(order.price),
          )
        : bn(order.buy_cost ?? '0');
      const feePct = cfg.feeRoundtripPct / 100;
      const pnl = proceeds.minus(cost).minus(proceeds.times(feePct)).toFixed(6);
      await addGridRealized(env.DB, grid.id, pnl);
      const excursionPrices = resolveGridCycleExcursionPrices(order, order.buy_cost, order.qty);
      const buyFilledAt = await getPairedGridBuyFilledAt(env.DB, grid.id, order);
      const holdMinutes =
        buyFilledAt != null
          ? minutesSinceSqliteUtc(buyFilledAt, order.updated_at || new Date().toISOString())
          : null;
      const cycleAnalytics = buildGridCycleAnalytics({
        entryPrice: excursionPrices.entry,
        exitPrice: order.price,
        troughPrice: excursionPrices.trough,
        peakPrice: excursionPrices.peak,
        holdMinutes,
        floorExit: isFloorExitOrder(order),
      });
      await logEvent(env.DB, 'GRID_CYCLE', {
        symbol: grid.symbol,
        gridId: grid.id,
        levelIndex: order.level_index,
        sellPrice: order.price,
        qty: order.qty,
        pnl,
        floorExit: isFloorExitOrder(order),
        ...cycleAnalytics,
      });
      maintainBuyGuardByGridId.delete(grid.id);
      if (needsBuyGuardAssessment(cfg)) {
        const postCycleSnap = await buildBuyGuardAssessment(env, gateway, cfg, grid, lastPrice);
        if (postCycleSnap) {
          maintainBuyGuardByGridId.set(grid.id, postCycleSnap);
          if (!postCycleSnap.readiness.ready) {
            flashBuyBlockByGrid.set(grid.id, true);
            await logEvent(env.DB, 'GRID_CYCLE_READINESS_HOLD', {
              symbol: grid.symbol,
              gridId: grid.id,
              blocker: postCycleSnap.readiness.primaryBlocker,
              score: Number(postCycleSnap.readiness.score.toFixed(2)),
              gatesPassed: postCycleSnap.readiness.gates.filter((g) => g.pass).length,
              gatesTotal: postCycleSnap.readiness.gates.length,
              ...(cfg.buyLogAssessment ? buildAssessmentLogPayload(postCycleSnap) : {}),
            });
          }
        }
      }
      if (!isBreakevenDip(cfg) && next && next.side === 'BUY') {
        const price = makerBuyPrice(next.price, lastPrice, filters.tickSize);
        const quotePerLevel = Number(grid.investment_usdt) / grid.grid_count;
        const qty = buyQtyForGridLevel(quotePerLevel, Number(price), filters);
        if (qty) {
          await placeGridOrder(env, gateway, cfg, grid.symbol, grid.id, next.levelIndex, 'BUY', price, qty, null);
        }
      }
    } else if (!isBreakevenDip(cfg)) {
      const buyCost = bn(order.qty).times(order.price).toFixed(8);
      if (next && next.side === 'SELL') {
        const price = makerSellPrice(next.price, lastPrice, filters.tickSize);
        const qty = formatQuantity(order.qty, filters.stepSize);
        const notional = bn(qty).times(price).toFixed(8);
        if (meetsMinQty(qty, filters.minQty) && meetsMinNotional(notional, filters.minNotional)) {
          await placeGridOrder(env, gateway, cfg, grid.symbol, grid.id, next.levelIndex, 'SELL', price, qty, buyCost);
        } else {
          await logEvent(env.DB, 'GRID_REARM_SKIP', {
            symbol: grid.symbol,
            gridId: grid.id,
            levelIndex: next.levelIndex,
            qty,
            price,
            notional,
            minNotional: filters.minNotional,
          });
        }
      }
    }
  }

  if (isBreakevenDip(cfg)) {
    const legacyCanceled = await cancelLegacyGridOpenSells(env, gateway, cfg, grid);
    if (legacyCanceled > 0) {
      await logEvent(env.DB, 'GRID_LEGACY_SELL_CANCELED', {
        symbol: grid.symbol,
        gridId: grid.id,
        count: legacyCanceled,
      });
    }
    const floorSync = await syncFloorExitSell(env, gateway, cfg, grid, lastPrice, filters);
    if (floorSync.changed) {
      await logEvent(env.DB, 'GRID_FLOOR_EXIT_SYNC', {
        symbol: grid.symbol,
        gridId: grid.id,
        action: floorSync.action,
        price: floorSync.price,
        qty: floorSync.qty,
        avgCost: floorSync.avgCost,
      });
    }
  }

  if (status === 'in' && !inventoryGuardHit && !flashBuyBlockByGrid.get(grid.id)) {
    const afterOpen = await listGridOrders(env.DB, grid.id, 'OPEN');
    const allOrders = await listGridOrders(env.DB, grid.id);
    const stats = await getGridFilledStats(env.DB, grid.id);
    const bag = hasTrackedBag(stats, lastPrice);

    if (isBreakevenDip(cfg)) {
      const openMaybeFilled =
        !bag &&
        (await Promise.all(
          afterOpen
            .filter((o) => o.side === 'BUY')
            .map((o) => isOrderFilled(env, gateway, cfg, grid.symbol, o, lastPrice)),
        )).some(Boolean);
      if (!openMaybeFilled) {
        const sync = await syncLadderBuy(env, gateway, cfg, grid, levels, lastPrice, filters);
        if (sync.repositioned || sync.targetLevels.length > 0) {
          await logEvent(env.DB, 'GRID_LADDER_BUY_SYNC', {
            symbol: grid.symbol,
            gridId: grid.id,
            lastPrice,
            bag,
            openBuysBefore: afterOpen.filter((o) => o.side === 'BUY').length,
            buysCanceled: sync.canceled,
            buysPlaced: sync.placed,
            targetLevels: sync.targetLevels,
            skipped: sync.skipped,
          });
        }
      }
    } else {
      const hasFilled = gridHasFilledBuy(allOrders);
      const openMaybeFilled =
        !hasFilled &&
        (await Promise.all(
          afterOpen
            .filter((o) => o.side === 'BUY')
            .map((o) => isOrderFilled(env, gateway, cfg, grid.symbol, o, lastPrice)),
        )).some(Boolean);
      if (!hasFilled && !openMaybeFilled) {
        const sync = await syncOpenBuysToNearest(env, gateway, cfg, grid, levels, lastPrice, filters);
        if (sync.repositioned) {
          await logEvent(env.DB, 'GRID_BUY_LADDER_REPOSITION', {
            symbol: grid.symbol,
            gridId: grid.id,
            lastPrice,
            openBuysBefore: afterOpen.filter((o) => o.side === 'BUY').length,
            buysCanceled: sync.canceled,
            buysPlaced: sync.placed,
            targetLevels: sync.targetLevels,
          });
        }
      }
    }
  }

  if (inventoryGuardHit) {
    await logEvent(env.DB, 'GRID_INVENTORY_GUARD', {
      symbol: grid.symbol,
      gridId: grid.id,
      inventoryCost,
      maxInventoryUsdt: cfg.maxInventoryUsdt,
    });
  }

  // Teardown fill + floor sync SONRASI: dolu alışta geçici "açık emir yok" teardown'u
  // engeller (TON bag + floor satış kurulmadan recovery_no_qty).
  if (cfg.readinessTeardownEnabled) {
    const teardown = await maybeTeardownGrid(env, gateway, cfg, grid, lastPrice);
    if (teardown) return;
  }

  const openAfter = await listGridOrders(env.DB, grid.id, 'OPEN');
  let inventoryCostAfter = 0;
  for (const o of openAfter) {
    if (o.side === 'SELL' && o.buy_cost) inventoryCostAfter += Number(o.buy_cost);
  }

  await logEvent(env.DB, 'GRID_MAINTAIN', {
    symbol: grid.symbol,
    gridId: grid.id,
    lastPrice,
    rangeStatus: status,
    openOrders: openAfter.length,
    fills,
    inventoryCost: inventoryCostAfter,
    realizedPnl: grid.realized_pnl,
    cycles: grid.cycles,
  });
}

/** Açık grid emirlerini iptal et (Binance + DB). */
async function cancelOpenGridOrders(
  env: Env,
  gateway: TradingGateway,
  cfg: GridConfig,
  grid: GridStateRow,
): Promise<GridOrderRow[]> {
  const open = await listGridOrders(env.DB, grid.id, 'OPEN');
  if (tradingEnabled(env) && cfg.liveGate) {
    for (const o of open) {
      if (o.binance_order_id && !o.binance_order_id.startsWith('mock-')) {
        try {
          await gateway.cancelOrder(grid.symbol, o.binance_order_id);
        } catch (err) {
          await logGridBinanceApi(env, 'cancelOrder', err, {
            symbol: grid.symbol,
            gridId: grid.id,
            binanceOrderId: o.binance_order_id,
            side: o.side,
            levelIndex: o.level_index,
            scope: 'cancel_all_open',
          });
        }
      }
    }
  }
  await cancelAllGridOrders(env.DB, grid.id);
  return open;
}

/** Yalnız açık ALIŞ emirlerini iptal et (Binance + DB) — envanter SATIŞ'larına dokunma. */
async function cancelOpenBuyOrders(
  env: Env,
  gateway: TradingGateway,
  cfg: GridConfig,
  grid: GridStateRow,
  open: GridOrderRow[],
  lastPrice: number,
): Promise<{ filled: GridOrderRow[]; canceled: number }> {
  const filled = await markFilledBuyOrdersFromExchange(
    env,
    gateway,
    cfg,
    grid,
    open,
    lastPrice,
  );
  const filledIds = new Set(filled.map((o) => o.id));

  if (tradingEnabled(env) && cfg.liveGate) {
    for (const o of open) {
      if (filledIds.has(o.id)) continue;
      if (o.side === 'BUY' && o.binance_order_id && !o.binance_order_id.startsWith('mock-')) {
        try {
          await gateway.cancelOrder(grid.symbol, o.binance_order_id);
        } catch (err) {
          await logGridBinanceApi(env, 'cancelOrder', err, {
            symbol: grid.symbol,
            gridId: grid.id,
            binanceOrderId: o.binance_order_id,
            side: o.side,
            levelIndex: o.level_index,
            scope: 'cancel_open_buys',
          });
        }
      }
    }
  }
  const before = await listGridOrders(env.DB, grid.id, 'OPEN');
  const openBuysBefore = before.filter((o) => o.side === 'BUY' && !filledIds.has(o.id)).length;
  await cancelOpenGridOrdersBySide(env.DB, grid.id, 'BUY');
  return { filled, canceled: openBuysBefore };
}

/**
 * Açık alışları fiyata en yakın maxConsecutive seviyeye hizala.
 * Hedef dışındaki açık alışları iptal edip yeniden kurar (recenter / heal).
 */
async function syncOpenBuysToNearest(
  env: Env,
  gateway: TradingGateway,
  cfg: GridConfig,
  grid: GridStateRow,
  levels: number[],
  lastPrice: number,
  filters: ReturnType<typeof parseSymbolFilters>,
  occupiedLevels?: Set<number>,
): Promise<{
  placed: number;
  canceled: number;
  repositioned: boolean;
  targetLevels: number[];
  skipped?: string;
}> {
  const quotePerLevel = Number(grid.investment_usdt) / grid.grid_count;
  const plan = planInitialBuyOrders(levels, lastPrice, Number(grid.investment_usdt));
  const allOrders = await listGridOrders(env.DB, grid.id);
  const buyBlocked = levelsBlockingNewBuy(allOrders);
  const targets = selectNearestBuyPlan(
    plan,
    buyBlocked,
    cfg.maxConsecutiveBuys,
    occupiedLevels,
  );
  const targetLevels = targets.map((o) => o.levelIndex);
  const openBuys = allOrders.filter((o) => o.side === 'BUY' && o.status === 'OPEN');
  const currentLevels = openBuys.map((o) => o.level_index);
  const openLevelSet = new Set(currentLevels);

  const placeMissingTargets = async (): Promise<number> => {
    let placed = 0;
    for (const o of targets) {
      if (openLevelSet.has(o.levelIndex)) continue;
      const fresh = await listGridOrders(env.DB, grid.id);
      if (!canPlaceNewBuyOrder(fresh, cfg.maxConsecutiveBuys)) break;
      const price = makerBuyPrice(o.price, lastPrice, filters.tickSize);
      const qty = buyQtyForGridLevel(quotePerLevel, Number(price), filters);
      if (!qty) continue;
      const ok = await placeGridOrder(
        env,
        gateway,
        cfg,
        grid.symbol,
        grid.id,
        o.levelIndex,
        'BUY',
        price,
        qty,
        null,
      );
      if (ok) {
        placed++;
        openLevelSet.add(o.levelIndex);
      }
    }
    return placed;
  };

  if (!shouldRepositionOpenBuys(currentLevels, targets, levels)) {
    const placed = await placeMissingTargets();
    return {
      placed,
      canceled: 0,
      repositioned: placed > 0,
      targetLevels,
      skipped: placed > 0 ? undefined : 'stable',
    };
  }

  let canceled = 0;
  if (openBuys.length > 0) {
    const cancelResult = await cancelOpenBuyOrders(env, gateway, cfg, grid, openBuys, lastPrice);
    canceled = cancelResult.canceled;
    openLevelSet.clear();
  }

  const placed = await placeMissingTargets();

  return { placed, canceled, repositioned: canceled > 0 || placed > 0, targetLevels };
}

/** breakeven_dip: tek açık alış (flat: yakın, bag: dip). */
async function syncLadderBuy(
  env: Env,
  gateway: TradingGateway,
  cfg: GridConfig,
  grid: GridStateRow,
  levels: number[],
  lastPrice: number,
  filters: ReturnType<typeof parseSymbolFilters>,
  occupiedLevels?: Set<number>,
): Promise<{
  placed: number;
  canceled: number;
  repositioned: boolean;
  targetLevels: number[];
  skipped?: string;
}> {
  const quotePerLevel = Number(grid.investment_usdt) / grid.grid_count;
  const plan = planInitialBuyOrders(levels, lastPrice, Number(grid.investment_usdt));
  const allOrders = await listGridOrders(env.DB, grid.id);
  const stats = await getGridFilledStats(env.DB, grid.id);
  const bag = hasTrackedBag(stats, lastPrice);
  const buyBlocked = levelsBlockingNewBuy(allOrders);
  const target = selectLadderBuyTarget(plan, bag, buyBlocked, occupiedLevels);
  const targets = target ? [target] : [];
  const targetLevels = targets.map((o) => o.levelIndex);
  const openBuys = allOrders.filter((o) => o.side === 'BUY' && o.status === 'OPEN');
  const currentLevels = openBuys.map((o) => o.level_index);
  const openLevelSet = new Set(currentLevels);
  const deferSteps = Math.max(0, cfg.dipBuyDeferSteps);

  if (deferSteps > 0 && openBuys.length > 0) {
    const releaseBuys = openBuys.filter((ob) =>
      shouldCancelDeferredDipBuy(lastPrice, levels, ob.level_index, deferSteps),
    );
    if (releaseBuys.length > 0) {
      const { filled, canceled } = await cancelOpenBuyOrders(
        env,
        gateway,
        cfg,
        grid,
        releaseBuys,
        lastPrice,
      );
      await logEvent(env.DB, 'GRID_LADDER_BUY_RELEASED', {
        symbol: grid.symbol,
        gridId: grid.id,
        lastPrice,
        targetLevel: target?.levelIndex ?? null,
        targetPrice: target?.price ?? null,
        releaseLevels: releaseBuys.map((o) => o.level_index),
        deferSteps,
        canceled,
        filledBeforeCancel: filled.length,
      });
      return {
        placed: 0,
        canceled: releaseBuys.length,
        repositioned: true,
        targetLevels,
        skipped: 'released',
      };
    }
  }

  if (target && deferSteps > 0) {
    const triggerPrice = dipBuyDeferTriggerPrice(levels, target.levelIndex, deferSteps);
    const releasePrice = dipBuyDeferReleasePrice(levels, target.levelIndex, deferSteps);
    if (openBuys.length === 0 && !isDipBuyDeferArmed(lastPrice, levels, target.levelIndex, deferSteps)) {
      await logEvent(env.DB, 'GRID_LADDER_BUY_DEFERRED', {
        symbol: grid.symbol,
        gridId: grid.id,
        lastPrice,
        targetLevel: target.levelIndex,
        targetPrice: target.price,
        triggerPrice,
        releasePrice,
        deferSteps,
        bag,
      });
      return {
        placed: 0,
        canceled: 0,
        repositioned: false,
        targetLevels,
        skipped: 'deferred',
      };
    }
  }

  const placeMissingTargets = async (): Promise<number> => {
    let placed = 0;
    for (const o of targets) {
      if (openLevelSet.has(o.levelIndex)) continue;
      const fresh = await listGridOrders(env.DB, grid.id);
      if (!canPlaceBreakevenDipBuy(fresh)) break;
      const price = makerBuyPrice(o.price, lastPrice, filters.tickSize);
      const qty = buyQtyForGridLevel(quotePerLevel, Number(price), filters);
      if (!qty) {
        await logEvent(env.DB, 'GRID_LADDER_BUY_SKIP', {
          symbol: grid.symbol,
          gridId: grid.id,
          levelIndex: o.levelIndex,
          price,
          reason: 'min_qty_or_notional',
        });
        continue;
      }
      const ok = await placeGridOrder(
        env,
        gateway,
        cfg,
        grid.symbol,
        grid.id,
        o.levelIndex,
        'BUY',
        price,
        qty,
        null,
      );
      if (ok) {
        placed++;
        openLevelSet.add(o.levelIndex);
        if (deferSteps > 0) {
          const armedSnap = maintainBuyGuardByGridId.get(grid.id);
          await logEvent(env.DB, 'GRID_LADDER_BUY_ARMED', {
            symbol: grid.symbol,
            gridId: grid.id,
            levelIndex: o.levelIndex,
            price,
            lastPrice,
            triggerPrice: dipBuyDeferTriggerPrice(levels, o.levelIndex, deferSteps),
            deferSteps,
            ...(cfg.buyLogAssessment && armedSnap ? buildAssessmentLogPayload(armedSnap) : {}),
          });
        }
      }
    }
    return placed;
  };

  if (!shouldRepositionOpenBuys(currentLevels, targets, levels)) {
    const placed = await placeMissingTargets();
    return {
      placed,
      canceled: 0,
      repositioned: placed > 0,
      targetLevels,
      skipped: placed > 0 ? undefined : 'stable',
    };
  }

  let canceled = 0;
  if (openBuys.length > 0) {
    const cancelResult = await cancelOpenBuyOrders(env, gateway, cfg, grid, openBuys, lastPrice);
    canceled = cancelResult.canceled;
    openLevelSet.clear();
  }

  const placed = await placeMissingTargets();
  const skipped =
    targets.length > 0 && placed === 0
      ? openBuyOrderCount(await listGridOrders(env.DB, grid.id)) >= 1
        ? 'open_buy_exists'
        : 'place_failed'
      : undefined;
  return { placed, canceled, repositioned: canceled > 0 || placed > 0, targetLevels, skipped };
}

async function cancelOpenSellOrders(
  env: Env,
  gateway: TradingGateway,
  cfg: GridConfig,
  grid: GridStateRow,
  open: GridOrderRow[],
): Promise<void> {
  if (tradingEnabled(env) && cfg.liveGate) {
    for (const o of open) {
      if (o.side === 'SELL' && o.binance_order_id && !o.binance_order_id.startsWith('mock-')) {
        try {
          await gateway.cancelOrder(grid.symbol, o.binance_order_id);
        } catch (err) {
          await logGridBinanceApi(env, 'cancelOrder', err, {
            symbol: grid.symbol,
            gridId: grid.id,
            binanceOrderId: o.binance_order_id,
            side: o.side,
            levelIndex: o.level_index,
            scope: 'cancel_open_sells',
          });
        }
      }
    }
  }
  for (const o of open) {
    await markGridOrder(env.DB, o.id, 'CANCELED');
  }
}

async function cancelLegacyGridOpenSells(
  env: Env,
  gateway: TradingGateway,
  cfg: GridConfig,
  grid: GridStateRow,
): Promise<number> {
  const open = await listGridOrders(env.DB, grid.id, 'OPEN');
  const legacy = open.filter((o) => o.side === 'SELL' && !isFloorExitOrder(o));
  if (legacy.length === 0) return 0;
  await cancelOpenSellOrders(env, gateway, cfg, grid, legacy);
  return legacy.length;
}

async function syncFloorExitSell(
  env: Env,
  gateway: TradingGateway,
  cfg: GridConfig,
  grid: GridStateRow,
  lastPrice: number,
  filters: ReturnType<typeof parseSymbolFilters>,
): Promise<{
  changed: boolean;
  action?: string;
  price?: string;
  qty?: string;
  avgCost?: number;
}> {
  const stats = await getGridFilledStats(env.DB, grid.id);
  const netQty = stats.boughtQty - stats.soldQty;
  const open = await listGridOrders(env.DB, grid.id, 'OPEN');
  const floorOpen = open.find((o) => isFloorExitOrder(o));

  if (!hasTrackedBag(stats, lastPrice)) {
    if (floorOpen) {
      await cancelOpenSellOrders(env, gateway, cfg, grid, [floorOpen]);
      return { changed: true, action: 'canceled_empty_bag' };
    }
    return { changed: false };
  }

  if (!(stats.boughtQty > 0)) return { changed: false };
  const avgCost = stats.boughtCost / stats.boughtQty;
  const rawTarget = computeFloorExitPrice(avgCost, cfg.floorExitMarginPct);
  const price = makerSellPrice(rawTarget, lastPrice, filters.tickSize);
  const qty = formatQuantity(String(netQty), filters.stepSize);
  const notional = bn(qty).times(price).toFixed(8);

  if (!meetsMinQty(qty, filters.minQty) || !meetsMinNotional(notional, filters.minNotional)) {
    await logEvent(env.DB, 'GRID_FLOOR_EXIT_SKIP', {
      symbol: grid.symbol,
      gridId: grid.id,
      qty,
      price,
      notional,
      minNotional: filters.minNotional,
    });
    return { changed: false };
  }

  if (floorOpen && floorOpen.price === price && floorOpen.qty === qty) {
    return { changed: false, price, qty, avgCost };
  }

  if (floorOpen) {
    await cancelOpenSellOrders(env, gateway, cfg, grid, [floorOpen]);
  }

  const entryPrice = String(avgCost);
  const ok = await placeGridOrder(
    env,
    gateway,
    cfg,
    grid.symbol,
    grid.id,
    GRID_FLOOR_EXIT_LEVEL_INDEX,
    'SELL',
    price,
    qty,
    FLOOR_EXIT_BUY_COST_TAG,
    {
      entryPrice,
      troughPrice: floorOpen?.cycle_trough_price ?? entryPrice,
      peakPrice: floorOpen?.cycle_peak_price ?? entryPrice,
    },
  );
  if (!ok) return { changed: floorOpen != null, action: 'place_failed' };

  return {
    changed: true,
    action: floorOpen ? 'replaced' : 'placed',
    price,
    qty,
    avgCost,
  };
}

/**
 * Aday artık uygun değilse gridi kapat: flat ise sil + emir iptal; envanter (açık SELL)
 * varsa break-even recovery'ye yönlendir. Kapatıldıysa true döner.
 */
async function maybeTeardownGrid(
  env: Env,
  gateway: TradingGateway,
  cfg: GridConfig,
  grid: GridStateRow,
  lastPrice: number,
): Promise<boolean> {
  // Manual modda readiness atlanır (kullanıcı pinlemiş).
  if (cfg.rangeMode === 'manual') return false;

  // Yeni kurulan gridi anında kapatma (deploy->teardown churn'ünü önle).
  const ageMs = Date.now() - dbTimestampMs(grid.created_at);
  if (ageMs < GRID_TEARDOWN_GRACE_MS) return false;

  const openOrders = await listGridOrders(env.DB, grid.id, 'OPEN');

  // Envanteri AÇIK SATIŞ emrinden değil, NET DOLMUŞ envanterden (alındı - satıldı)
  // tespit et. Satış herhangi bir sebeple kurulamadıysa (NOTIONAL, immediate-match,
  // vb.) açık SELL olmaz ama coin cüzdanda durur. Net dolmuşa bakmak bu kör noktayı
  // kapatır -> grid durdurulurken envanter ASLA orphan kalmaz, recovery'ye gider.
  const stats = await getGridFilledStats(env.DB, grid.id);
  const netQty = stats.boughtQty - stats.soldQty;
  const hasInventory = netQty > 0 && netQty * lastPrice >= GRID_INVENTORY_DUST_USDT;

  // Ölü grid: hiç açık emir yok VE envanter yok. Slotu boşalt.
  if (openOrders.length === 0 && !hasInventory) {
    await stopGrid(env.DB, grid.id, 'no_open_orders');
    await logEvent(env.DB, 'GRID_TEARDOWN', {
      symbol: grid.symbol,
      gridId: grid.id,
      blocker: 'no_open_orders',
      lastPrice,
    });
    return true;
  }

  const wl = await listWatchlist(env.DB);
  const needStoppedMap =
    cfg.readinessPostExitRelaxEnabled || cfg.readinessPostExitCooldownEnabled;
  const recentlyStopped = needStoppedMap
    ? await getRecentlyStoppedGridSymbols(
        env.DB,
        cfg.readinessPostExitRelaxEnabled ? cfg.readinessPostExitRelaxDays : 1,
      )
    : new Map();
  const recentFloors = cfg.readinessPostExitCooldownEnabled
    ? await getRecentFloorCycleSymbols(env.DB, cfg.readinessPostExitCooldownMin)
    : new Map();
  let buyGuardSnap: GridBuyGuardAssessment | null =
    maintainBuyGuardByGridId.get(grid.id) ?? null;
  if (!buyGuardSnap && needsBuyGuardAssessment(cfg)) {
    buyGuardSnap = await buildBuyGuardAssessment(env, gateway, cfg, grid, lastPrice);
    if (buyGuardSnap) maintainBuyGuardByGridId.set(grid.id, buyGuardSnap);
  }

  const assessment = buyGuardSnap
    ? { readiness: buyGuardSnap.readiness, lastPrice: buyGuardSnap.lastPrice }
    : await assessCandidate(env, gateway, cfg, grid.symbol, recentlyStopped, recentFloors);
  const inWatchlist = buyGuardSnap?.inWatchlist ?? wl.some((w) => w.symbol === grid.symbol);
  const ready = assessment?.readiness.ready ?? false;
  const guardCfg = buyGuardConfigFromGrid(cfg);
  const readinessTeardown =
    buyGuardSnap != null && shouldTeardownForReadiness(buyGuardSnap, guardCfg).block;

  // Watchlist dışı, trending veya ciddi readiness blocker.
  const gates = assessment?.readiness.gates ?? [];
  const rangingGate = gates.find((g) => g.id === 'ranging');
  const trending = rangingGate != null && !rangingGate.pass;
  const shouldTeardown = !inWatchlist || trending || readinessTeardown;
  if (!shouldTeardown) return false;

  const blocker = !inWatchlist
    ? 'not_in_watchlist'
    : trending
      ? 'trending'
      : (buyGuardSnap?.readiness.primaryBlocker ?? 'not_ready');
  const assessmentLog =
    buyGuardSnap && cfg.buyLogAssessment ? buildAssessmentLogPayload(buyGuardSnap) : {};

  // Envanter VARSA asla orphan bırakma -> recovery (gerçek modda tüm cüzdan free
  // bakiyesini break-even+ LIMIT_MAKER ile satar, izlenmeyen bag dahil).
  if (hasInventory) {
    await logEvent(env.DB, 'GRID_TEARDOWN_RECOVERY', {
      symbol: grid.symbol,
      gridId: grid.id,
      inWatchlist,
      ready,
      blocker,
      netQty,
      ...assessmentLog,
    });
    await enterRecovery(env, gateway, cfg, grid, lastPrice, `teardown_${blocker}`);
    return true;
  }

  await cancelOpenGridOrders(env, gateway, cfg, grid);
  await stopGrid(env.DB, grid.id, 'not_ready_teardown');
  await logEvent(env.DB, 'GRID_TEARDOWN', {
    symbol: grid.symbol,
    gridId: grid.id,
    inWatchlist,
    ready,
    blocker,
    lastPrice,
    ...assessmentLog,
  });
  return true;
}

/**
 * Aralığı güncel fiyat etrafında yeniden ortala. Bekleyen ALIŞ'ları iptal eder,
 * envanter SATIŞ'larını yeni seviyelere remap eder, yeni ALIŞ merdivenini kurar.
 */
async function recenterGrid(
  env: Env,
  gateway: TradingGateway,
  cfg: GridConfig,
  grid: GridStateRow,
  lastPrice: number,
): Promise<void> {
  const oldLower = Number(grid.lower_price);
  const oldUpper = Number(grid.upper_price);
  const next = recenterRange(lastPrice, oldLower, oldUpper);
  if (!next) return;

  const info = await gateway.binance.getExchangeInfo(grid.symbol);
  const symInfo = info.symbols[0];
  if (!symInfo) return;
  const filters = parseSymbolFilters(symInfo);

  const newLevels = computeGridLevels(next.lower, next.upper, grid.grid_count);

  const open = await listGridOrders(env.DB, grid.id, 'OPEN');
  const sells = open.filter((o) => o.side === 'SELL');

  // 1) Bekleyen ALIŞ'ları iptal (envanter taşımazlar).
  const openBuys = open.filter((o) => o.side === 'BUY');
  if (openBuys.length > 0) {
    await cancelOpenBuyOrders(env, gateway, cfg, grid, openBuys, lastPrice);
  }

  // 2) Aralığı güncelle.
  await updateGridRange(env.DB, grid.id, next.lower, next.upper);

  // 3) Envanter SATIŞ'larını yeni level_index'lere remap (collision'da boş index'e kaydır).
  // ÖNEMLİ: UNIQUE(grid_id, level_index, status) -> sırayla UPDATE ederken hedef index
  // henüz taşınmamış başka bir açık SATIŞ tarafından tutuluyorsa ihlal oluşur ve maintain
  // çöker. Bu yüzden iki faz: önce hepsini çakışmayan geçici index'lere park et, sonra
  // final index'leri ata (artık hiçbir gerçek seviye başka satış tarafından tutulmuyor).
  const TEMP_LEVEL_BASE = 100_000;
  for (let i = 0; i < sells.length; i++) {
    await setGridOrderLevelIndex(env.DB, sells[i]!.id, TEMP_LEVEL_BASE + i);
  }
  const usedLevels = new Set<number>();
  for (const s of sells) {
    let idx = nearestLevelIndex(Number(s.price), newLevels);
    if (usedLevels.has(idx)) {
      // boş komşu index bul (önce yukarı, sonra aşağı)
      let alt = idx;
      for (let d = 1; d <= grid.grid_count; d++) {
        if (idx + d <= grid.grid_count && !usedLevels.has(idx + d)) { alt = idx + d; break; }
        if (idx - d >= 0 && !usedLevels.has(idx - d)) { alt = idx - d; break; }
      }
      idx = alt;
    }
    usedLevels.add(idx);
    await setGridOrderLevelIndex(env.DB, s.id, idx);
  }

  const sync = isBreakevenDip(cfg)
    ? await syncLadderBuy(
        env,
        gateway,
        cfg,
        { ...grid, lower_price: String(next.lower), upper_price: String(next.upper) },
        newLevels,
        lastPrice,
        filters,
        usedLevels,
      )
    : await syncOpenBuysToNearest(
        env,
        gateway,
        cfg,
        { ...grid, lower_price: String(next.lower), upper_price: String(next.upper) },
        newLevels,
        lastPrice,
        filters,
        usedLevels,
      );

  await logEvent(env.DB, 'GRID_RECENTER', {
    symbol: grid.symbol,
    gridId: grid.id,
    lastPrice,
    oldRange: { lower: oldLower, upper: oldUpper },
    newRange: next,
    buysCanceled: open.filter((o) => o.side === 'BUY').length,
    sellsRemapped: sells.length,
    buysPlaced: sync.placed,
    targetLevels: sync.targetLevels,
    repositioned: sync.repositioned,
  });
}

/**
 * Break-even+margin LIMIT_MAKER satış (RECOVERING). Satış miktarı = bu grid'in
 * izlenen kalanı (FILLED alış − satış) ile cüzdan free'nin minimumu; paralel yeni
 * grid alışları recovery emrine karışmaz.
 */
async function enterRecovery(
  env: Env,
  gateway: TradingGateway,
  cfg: GridConfig,
  grid: GridStateRow,
  lastPrice: number,
  reason = 'stop_below_range',
): Promise<void> {
  await cancelOpenGridOrders(env, gateway, cfg, grid);

  // Maliyet bazı: FILLED alışların ağırlıklı ortalaması (sell arm fail olsa bile).
  const stats = await getGridFilledStats(env.DB, grid.id);
  const avgCost = stats.boughtQty > 0 ? stats.boughtCost / stats.boughtQty : lastPrice;

  const info = await gateway.binance.getExchangeInfo(grid.symbol);
  const symInfo = info.symbols[0];
  if (!symInfo) {
    await stopGrid(env.DB, grid.id, 'recovery_no_symbol_info');
    return;
  }
  const filters = parseSymbolFilters(symInfo);

  const marginPct = (cfg.feeRoundtripPct + cfg.recoveryMarginPct) / 100;
  const rawTarget = avgCost * (1 + marginPct);
  const targetPrice = makerSellPrice(rawTarget, lastPrice, filters.tickSize);

  const realMode = tradingEnabled(env) && cfg.liveGate;
  const trackedRemaining = Math.max(0, stats.boughtQty - stats.soldQty);
  let sellQty: string;
  let freeLogged: string | undefined;
  if (realMode) {
    const free = await getFreeBaseQty(gateway, baseAssetFromSymbol(grid.symbol));
    freeLogged = free;
    const capped = capRecoverySellBaseQty(trackedRemaining, Number(free));
    const resolved = await resolveSellQtyFromWallet(gateway, grid.symbol, String(capped));
    if (!resolved || bn(resolved.sellQty).lte(0)) {
      await logEvent(env.DB, 'GRID_RECOVERY_SKIP', {
        symbol: grid.symbol,
        gridId: grid.id,
        reason: trackedRemaining <= 0 ? 'no_tracked_qty' : 'no_wallet_qty',
        trackedRemaining,
        free,
      });
      await stopGrid(env.DB, grid.id, 'recovery_no_qty');
      return;
    }
    sellQty = resolved.sellQty;
  } else {
    const remaining = Math.max(0, stats.boughtQty - stats.soldQty);
    sellQty = formatQuantity(String(remaining), filters.stepSize);
    if (!meetsMinQty(sellQty, filters.minQty) || bn(sellQty).lte(0)) {
      await logEvent(env.DB, 'GRID_RECOVERY_SKIP', {
        symbol: grid.symbol,
        gridId: grid.id,
        reason: 'no_tracked_qty',
      });
      await stopGrid(env.DB, grid.id, 'recovery_no_qty');
      return;
    }
  }

  const notional = bn(sellQty).times(targetPrice).toFixed(8);
  if (!meetsMinNotional(notional, filters.minNotional)) {
    await logEvent(env.DB, 'GRID_RECOVERY_SKIP', {
      symbol: grid.symbol,
      gridId: grid.id,
      reason: 'min_notional',
      sellQty,
      targetPrice,
    });
    await stopGrid(env.DB, grid.id, 'recovery_min_notional');
    return;
  }

  let recoveryOrderId: string;
  if (realMode) {
    try {
      const order = await gateway.placeGridLimit(grid.symbol, 'SELL', sellQty, targetPrice);
      recoveryOrderId = String(order.orderId);
    } catch (err) {
      await logEvent(env.DB, 'GRID_RECOVERY_FAILED', {
        symbol: grid.symbol,
        gridId: grid.id,
        message: err instanceof Error ? err.message : String(err),
        targetPrice,
        sellQty,
      });
      await stopGrid(env.DB, grid.id, 'recovery_place_failed');
      return;
    }
  } else {
    recoveryOrderId = `mock-recovery-${grid.id}-${Date.now()}`;
  }

  await setGridRecovering(env.DB, grid.id, {
    recoveryOrderId,
    recoveryTargetPrice: targetPrice,
    recoveryQty: sellQty,
    recoveryAvgCost: String(avgCost),
    stopReason: reason,
  });

  await logEvent(env.DB, 'GRID_RECOVERY_OPENED', {
    symbol: grid.symbol,
    gridId: grid.id,
    reason,
    recoveryOrderId,
    targetPrice,
    sellQty,
    trackedRemaining,
    free: freeLogged,
    avgCost,
    lastPrice,
    marginPct: cfg.recoveryMarginPct,
    feeRoundtripPct: cfg.feeRoundtripPct,
    live: realMode,
  });
}

async function maintainRecovery(
  env: Env,
  gateway: TradingGateway,
  cfg: GridConfig,
  grid: GridStateRow,
  defensiveMode: DefensiveMarketMode | null,
): Promise<void> {
  const orderId = grid.recovery_order_id;
  const targetPrice = grid.recovery_target_price;
  const qty = grid.recovery_qty;
  const avgCost = grid.recovery_avg_cost;
  if (!orderId || !targetPrice || !qty || !avgCost) {
    await stopGrid(env.DB, grid.id, 'recovery_incomplete');
    return;
  }

  const lastPrice = await fetchLastPrice(gateway, grid.symbol);
  const realMode = tradingEnabled(env) && cfg.liveGate;

  let filled = false;
  if (realMode && !orderId.startsWith('mock-')) {
    try {
      const o = await gateway.getOrder(grid.symbol, orderId);
      filled = o.status === 'FILLED';
    } catch {
      filled = false;
    }
  } else if (lastPrice != null) {
    filled = lastPrice >= Number(targetPrice);
  }

  if (filled) {
    const proceeds = bn(qty).times(targetPrice);
    const cost = bn(avgCost).times(qty);
    const feePct = cfg.feeRoundtripPct / 100;
    const pnl = proceeds.minus(cost).minus(proceeds.times(feePct)).toFixed(6);
    await closeRecoveredGrid(env.DB, grid.id, pnl);
    await logEvent(env.DB, 'GRID_RECOVERY_FILLED', {
      symbol: grid.symbol,
      gridId: grid.id,
      targetPrice,
      qty,
      avgCost,
      pnl,
    });
    return;
  }

  if (
    defensiveMode?.active &&
    !isGridDefensiveExempt(cfg, grid.id) &&
    lastPrice != null &&
    shouldStopRecoveryAtTarget(
      lastPrice,
      Number(targetPrice),
      cfg.defensiveRecoveryStopPct,
    )
  ) {
    await logEvent(env.DB, 'GRID_RECOVERY_DEFENSIVE_CONVERT', {
      symbol: grid.symbol,
      gridId: grid.id,
      targetPrice,
      lastPrice,
      stopPct: cfg.defensiveRecoveryStopPct,
      reasons: defensiveMode.reasons,
    });
    await convertRecoveryToUsdt(env, grid.id, { source: 'defensive_stop_loss' });
    return;
  }

  if (lastPrice != null) {
    const ladderRan = await maybeAutoExecuteRecoveryLadder(env, cfg, grid, lastPrice);
    if (ladderRan) return;
  }

  await logEvent(env.DB, 'GRID_RECOVERY_WAIT', {
    symbol: grid.symbol,
    gridId: grid.id,
    targetPrice,
    lastPrice,
    qty,
    avgCost,
    distancePct:
      lastPrice != null && Number(targetPrice) > 0
        ? (((Number(targetPrice) - lastPrice) / lastPrice) * 100).toFixed(3)
        : null,
  });
}

/**
 * Savunma modu: muaf olmayan aktif gridleri recovery'ye al veya flat ise kapat.
 */
async function maybeDefensiveTeardownGrid(
  env: Env,
  gateway: TradingGateway,
  cfg: GridConfig,
  grid: GridStateRow,
  lastPrice: number,
  defensiveMode: DefensiveMarketMode,
): Promise<boolean> {
  if (!defensiveMode.active || isGridDefensiveExempt(cfg, grid.id)) return false;

  const ageMs = Date.now() - dbTimestampMs(grid.created_at);
  if (ageMs < GRID_TEARDOWN_GRACE_MS) return false;

  const openOrders = await listGridOrders(env.DB, grid.id, 'OPEN');
  const stats = await getGridFilledStats(env.DB, grid.id);
  const netQty = stats.boughtQty - stats.soldQty;
  const hasInventory = netQty > 0 && netQty * lastPrice >= GRID_INVENTORY_DUST_USDT;

  if (hasInventory) {
    await logEvent(env.DB, 'GRID_TEARDOWN_RECOVERY', {
      symbol: grid.symbol,
      gridId: grid.id,
      blocker: 'defensive_mode',
      reasons: defensiveMode.reasons,
      netQty,
      lastPrice,
    });
    await enterRecovery(env, gateway, cfg, grid, lastPrice, 'defensive_mode');
    return true;
  }

  if (openOrders.length > 0) {
    await cancelOpenGridOrders(env, gateway, cfg, grid);
  }
  await stopGrid(env.DB, grid.id, 'defensive_mode');
  await logEvent(env.DB, 'GRID_TEARDOWN', {
    symbol: grid.symbol,
    gridId: grid.id,
    blocker: 'defensive_mode',
    reasons: defensiveMode.reasons,
    lastPrice,
  });
  return true;
}

async function closeGrid(
  env: Env,
  gateway: TradingGateway,
  cfg: GridConfig,
  grid: GridStateRow,
  reason: string,
  lastPrice: number,
): Promise<void> {
  await cancelOpenGridOrders(env, gateway, cfg, grid);

  await stopGrid(env.DB, grid.id, reason);
  await logEvent(env.DB, 'GRID_STOPPED', {
    symbol: grid.symbol,
    gridId: grid.id,
    reason,
    lastPrice,
    realizedPnl: grid.realized_pnl,
    cycles: grid.cycles,
    rangeResetEnabled: cfg.rangeResetEnabled,
  });

  // range-reset: bir sonraki cron'da setupGrid yeni aralıkla yeniden kurar
}

/** Tüm ACTIVE grid'leri iptal edip break-even recovery'ye çeker (manuel, one-shot). */
export async function recoverAllActiveGrids(env: Env): Promise<{
  total: number;
  recovered: number;
  failed: string[];
}> {
  const cfg = await getGridConfig(env.DB, env);
  if (!cfg.enabled) {
    return { total: 0, recovered: 0, failed: ['grid_disabled'] };
  }

  const gateway = new TradingGateway(env);
  const actives = await getActiveGrids(env.DB);
  let recovered = 0;
  const failed: string[] = [];

  for (const grid of actives) {
    try {
      const lastPrice = await fetchLastPrice(gateway, grid.symbol);
      if (!lastPrice) {
        failed.push(`${grid.symbol}:no_price`);
        continue;
      }
      await enterRecovery(env, gateway, cfg, grid, lastPrice, 'manual_recover_all');
      recovered++;
    } catch (err) {
      failed.push(`${grid.symbol}:${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await logEvent(env.DB, 'GRID_RECOVER_ALL', {
    total: actives.length,
    recovered,
    failed,
    live: tradingEnabled(env) && cfg.liveGate,
  });

  return { total: actives.length, recovered, failed };
}

export interface CancelGridResult {
  ok: boolean;
  message: string;
  symbol?: string;
  gridId?: number;
  status?: string;
  ordersCanceled?: number;
  recoveryOrderCanceled?: boolean;
}

export type ForceRecenterResult = {
  ok: boolean;
  gridId?: number;
  symbol?: string;
  error?: string;
};

/** Manuel / trigger: dolu alış yokken aralığı fiyata ortala + en yakın alış merdiveni. */
export async function forceRecenterGrid(
  env: Env,
  opts?: { gridId?: number; symbol?: string },
): Promise<ForceRecenterResult> {
  const cfg = await getGridConfig(env.DB, env);
  if (!cfg.enabled) return { ok: false, error: 'grid_disabled' };

  let grid: GridStateRow | null = null;
  if (opts?.gridId != null) {
    grid = await getGridById(env.DB, opts.gridId);
  } else {
    const active = await getActiveGrids(env.DB);
    if (opts?.symbol) {
      grid = active.find((g) => g.symbol === opts.symbol) ?? null;
    } else {
      grid = active[0] ?? null;
    }
  }

  if (!grid || grid.status !== 'ACTIVE') {
    return { ok: false, error: 'grid_not_active', gridId: grid?.id, symbol: grid?.symbol };
  }

  const allOrders = await listGridOrders(env.DB, grid.id);
  if (gridHasFilledBuy(allOrders)) {
    return { ok: false, error: 'filled_buy_exists', gridId: grid.id, symbol: grid.symbol };
  }

  const gateway = new TradingGateway(env);
  let lastPrice = (await fetchSymbolMidPrice(env, grid.symbol)) ?? null;
  if (lastPrice == null || lastPrice <= 0) {
    lastPrice = await fetchLastPrice(gateway, grid.symbol);
  }
  if (lastPrice == null || lastPrice <= 0) {
    return { ok: false, error: 'no_price', gridId: grid.id, symbol: grid.symbol };
  }

  await recenterGrid(env, gateway, cfg, grid, lastPrice);
  return { ok: true, gridId: grid.id, symbol: grid.symbol };
}

/** Panel: grid iptal — Binance açık emirler + DB; grid STOPPED (coin satılmaz). */
export async function cancelGridOperation(env: Env, gridId: number): Promise<CancelGridResult> {
  const grid = await getGridById(env.DB, gridId);
  if (!grid) return { ok: false, message: 'not_found' };
  if (grid.status !== 'ACTIVE' && grid.status !== 'RECOVERING') {
    return { ok: false, message: 'not_active', symbol: grid.symbol, gridId, status: grid.status };
  }

  const cfg = await getGridConfig(env.DB, env);
  const gateway = new TradingGateway(env);
  const lastPrice = (await fetchLastPrice(gateway, grid.symbol)) ?? 0;

  if (grid.status === 'ACTIVE') {
    const open = await cancelOpenGridOrders(env, gateway, cfg, grid);
    await stopGrid(env.DB, grid.id, 'manual_cancel');
    await logEvent(env.DB, 'GRID_STOPPED', {
      symbol: grid.symbol,
      gridId: grid.id,
      reason: 'manual_cancel',
      lastPrice,
      realizedPnl: grid.realized_pnl,
      cycles: grid.cycles,
      ordersCanceled: open.length,
      rangeResetEnabled: cfg.rangeResetEnabled,
    });
    return {
      ok: true,
      message: 'canceled',
      symbol: grid.symbol,
      gridId: grid.id,
      status: 'STOPPED',
      ordersCanceled: open.length,
    };
  }

  let recoveryOrderCanceled = false;
  const orderId = grid.recovery_order_id;
  if (tradingEnabled(env) && cfg.liveGate && orderId && !orderId.startsWith('mock-')) {
    try {
      await gateway.cancelOrder(grid.symbol, orderId);
      recoveryOrderCanceled = true;
    } catch {
      /* zaten kapanmış olabilir */
    }
  }
  await stopGrid(env.DB, grid.id, 'manual_cancel');
  await logEvent(env.DB, 'GRID_STOPPED', {
    symbol: grid.symbol,
    gridId: grid.id,
    reason: 'manual_cancel',
    lastPrice,
    recoveryOrderCanceled,
    realizedPnl: grid.realized_pnl,
    cycles: grid.cycles,
  });
  return {
    ok: true,
    message: 'canceled',
    symbol: grid.symbol,
    gridId: grid.id,
    status: 'STOPPED',
    ordersCanceled: 0,
    recoveryOrderCanceled,
  };
}
