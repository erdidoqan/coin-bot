/** Spot Grid — DB katmanı (grid_state + grid_orders) ve grid config. */
import { getConfig } from './bot-config';
import { computeGridCycleExcursionUpdate } from '../strategy/grid-cycle-analytics';
import { FLOOR_EXIT_BUY_COST_TAG, GRID_FLOOR_EXIT_LEVEL_INDEX } from '../strategy/grid';

export type GridStatus = 'ACTIVE' | 'RECOVERING' | 'STOPPED';
export type GridOrderStatus = 'OPEN' | 'FILLED' | 'CANCELED';
export type GridOrderSide = 'BUY' | 'SELL';

export interface GridStateRow {
  id: number;
  symbol: string;
  lower_price: string;
  upper_price: string;
  grid_count: number;
  investment_usdt: string;
  status: GridStatus;
  realized_pnl: string;
  cycles: number;
  stop_reason: string | null;
  recovery_order_id: string | null;
  recovery_target_price: string | null;
  recovery_qty: string | null;
  recovery_avg_cost: string | null;
  anchor_price: string | null;
  created_at: string;
  updated_at: string;
}

export interface GridOrderRow {
  id: number;
  grid_id: number;
  level_index: number;
  side: GridOrderSide;
  price: string;
  qty: string;
  binance_order_id: string | null;
  status: GridOrderStatus;
  buy_cost: string | null;
  cycle_entry_price: string | null;
  cycle_trough_price: string | null;
  cycle_peak_price: string | null;
  created_at: string;
  updated_at: string;
}

export interface GridConfig {
  enabled: boolean;
  liveGate: boolean;
  symbol: string;
  rangeMode: 'auto' | 'manual';
  rangeLookbackDays: number;
  rangePctl: number;
  lowerPrice: number;
  upperPrice: number;
  gridCount: number;
  investmentUsdt: number;
  feeRoundtripPct: number;
  feeWallMultiple: number;
  stopBelowPct: number;
  recoveryMarginPct: number;
  stopAbovePct: number;
  rangeResetEnabled: boolean;
  recenterEnabled: boolean;
  recenterDriftPct: number;
  readinessTeardownEnabled: boolean;
  buyGuardEnabled: boolean;
  buyCancelOpenOnNotReady: boolean;
  buyBlockNewOnNotReady: boolean;
  buyCancelAnchorDrawdownPct: number;
  buyLogAssessment: boolean;
  teardownOnReadinessBlockers: boolean;
  teardownReadinessBlockersCsv: string;
  recenterRequiresReady: boolean;
  maxInventoryUsdt: number;
  // readiness (körü körüne girme engeli)
  useWatchlist: boolean;
  candidateCount: number;
  maxEfficiencyRatio: number;
  minRangeWidthPct: number;
  maxRangeWidthPct: number;
  minAtrPct: number;
  readinessMaxSpreadPct: number;
  readinessLookback: number;
  excludeSymbols: string[];
  maxConcurrent: number;
  flashDropEnabled: boolean;
  flashDropWarnPct: number;
  flashDropPausePct: number;
  flashDropRecoveryPct: number;
  flashDropWindowMin: number;
  flashDropMaxFills: number;
  flashDropFillWindowMin: number;
  flashDropOverfillMult: number;
  flashDropScoutBlockPanic: boolean;
  flashDropSymbolCooldownMin: number;
  readinessDownsideBars: number;
  readinessShortReturnBars: number;
  readinessMomentumWarnPct: number;
  readinessPostExitRelaxEnabled: boolean;
  readinessPostExitRelaxDays: number;
  readinessPostExitMomentumWarnPct: number;
  /** 0 = kapalı. Kurulum fiyatı auto-range üst %X üstündeyse hazır değil. */
  readinessMaxEntryBandPct: number;
  readinessMediumReturnBars: number;
  readinessMediumReturnWarnPct: number;
  readinessPostExitCooldownEnabled: boolean;
  readinessPostExitCooldownMin: number;
  readinessHourDeclineEnabled: boolean;
  readinessHourDeclineBars: number;
  allowNewGridWhileRecovering: boolean;
  readinessMaxPathRangeRatio: number;
  readinessMaxBarRangePathRatio: number;
  readinessMaxStabilityRangePct: number;
  readinessStabilityBars: number;
  scoutRiskFilterEnabled: boolean;
  scoutMaxAbsChangePct: number;
  scoutPoolMultiplier: number;
  /** Açık + ardışık dolu alış tavanı (satış fill sonrası yeniden açılır). */
  maxConsecutiveBuys: number;
  /** classic = çoklu yakın alış + üst SELL; breakeven_dip = tek alış + ort+% marj çıkış. */
  ladderMode: 'classic' | 'breakeven_dip';
  floorExitMarginPct: number;
  /** breakeven_dip: 0=hemen limit; N>0 fiyat hedefin N basamak üstüne inince emir. */
  dipBuyDeferSteps: number;
  /** Piyasa düşüş modu: yeni grid kurulumunu durdur. */
  marketDownturnEnabled: boolean;
  marketDownturnBreadthMaxPct: number;
  marketDownturnBtc24hPct: number;
  marketDownturnBtc15mReturnPct: number;
  marketDownturnScoutMinChangePct: number;
  marketDownturnBlockPanic: boolean;
  marketDownturnAllowManual: boolean;
  /** true → eşiklerden bağımsız düşüş modu aktif (manuel kilidi). */
  marketDownturnForceActive: boolean;
}

export async function getGridConfig(db: D1Database, env: Env): Promise<GridConfig> {
  const [
    enabled,
    liveGate,
    symbol,
    rangeMode,
    lookback,
    pctl,
    lower,
    upper,
    count,
    invest,
    fee,
    feeMult,
    stopBelow,
    recoveryMargin,
    stopAbove,
    rangeReset,
    recenterEnabled,
    recenterDrift,
    readinessTeardown,
    buyGuardEnabled,
    buyCancelOpen,
    buyBlockNew,
    buyCancelAnchorDd,
    buyLogAssessment,
    teardownOnReadinessBlockers,
    teardownReadinessBlockers,
    recenterRequiresReady,
    maxInv,
    useWatchlist,
    candidateCount,
    maxEr,
    minRw,
    maxRw,
    minAtr,
    readinessSpread,
    readinessLookback,
    excludeSymbols,
    maxConcurrent,
    flashEnabled,
    flashWarn,
    flashPause,
    flashRecovery,
    flashWindow,
    flashMaxFills,
    flashFillWindow,
    flashOverfill,
    flashScoutPanic,
    flashCooldown,
    readinessDownsideBars,
    readinessShortReturnBars,
    readinessMomentumWarn,
    readinessPostExitRelaxEnabled,
    readinessPostExitRelaxDays,
    readinessPostExitMomentumWarn,
    readinessMaxEntryBand,
    readinessMediumReturnBars,
    readinessMediumReturnWarn,
    readinessPostExitCooldownEnabled,
    readinessPostExitCooldownMin,
    readinessHourDeclineEnabled,
    readinessHourDeclineBars,
    allowNewWhileRecovering,
    readinessMaxPathRatio,
    readinessMaxBarPathRatio,
    readinessMaxStabRange,
    readinessStabilityBars,
    scoutRiskFilter,
    scoutMaxChange,
    scoutPoolMult,
    maxConsecutiveBuys,
    ladderMode,
    floorExitMargin,
    dipBuyDeferSteps,
    marketDownturnEnabled,
    marketDownturnBreadthMax,
    marketDownturnBtc24h,
    marketDownturnBtc15m,
    marketDownturnScoutMinChange,
    marketDownturnBlockPanic,
    marketDownturnAllowManual,
    marketDownturnForceActive,
  ] = await Promise.all([
    getConfig(db, 'grid_enabled', env),
    getConfig(db, 'live_gate', env),
    getConfig(db, 'grid_symbol', env),
    getConfig(db, 'grid_range_mode', env),
    getConfig(db, 'grid_range_lookback_days', env),
    getConfig(db, 'grid_range_pctl', env),
    getConfig(db, 'grid_lower_price', env),
    getConfig(db, 'grid_upper_price', env),
    getConfig(db, 'grid_count', env),
    getConfig(db, 'grid_investment_usdt', env),
    getConfig(db, 'grid_fee_roundtrip_pct', env),
    getConfig(db, 'grid_fee_wall_multiple', env),
    getConfig(db, 'grid_stop_below_pct', env),
    getConfig(db, 'grid_recovery_margin_pct', env),
    getConfig(db, 'grid_stop_above_pct', env),
    getConfig(db, 'grid_range_reset_enabled', env),
    getConfig(db, 'grid_recenter_enabled', env),
    getConfig(db, 'grid_recenter_drift_pct', env),
    getConfig(db, 'grid_readiness_teardown_enabled', env),
    getConfig(db, 'grid_buy_guard_enabled', env),
    getConfig(db, 'grid_buy_cancel_open_on_not_ready', env),
    getConfig(db, 'grid_buy_block_new_on_not_ready', env),
    getConfig(db, 'grid_buy_cancel_anchor_drawdown_pct', env),
    getConfig(db, 'grid_buy_log_assessment', env),
    getConfig(db, 'grid_teardown_on_readiness_blockers', env),
    getConfig(db, 'grid_teardown_readiness_blockers', env),
    getConfig(db, 'grid_recenter_requires_ready', env),
    getConfig(db, 'grid_max_inventory_usdt', env),
    getConfig(db, 'grid_use_watchlist', env),
    getConfig(db, 'grid_candidate_count', env),
    getConfig(db, 'grid_max_efficiency_ratio', env),
    getConfig(db, 'grid_min_range_width_pct', env),
    getConfig(db, 'grid_max_range_width_pct', env),
    getConfig(db, 'grid_min_atr_pct', env),
    getConfig(db, 'grid_readiness_max_spread_pct', env),
    getConfig(db, 'grid_readiness_lookback', env),
    getConfig(db, 'grid_exclude_symbols', env),
    getConfig(db, 'grid_max_concurrent', env),
    getConfig(db, 'grid_flash_drop_enabled', env),
    getConfig(db, 'grid_flash_drop_warn_pct', env),
    getConfig(db, 'grid_flash_drop_pause_pct', env),
    getConfig(db, 'grid_flash_drop_recovery_pct', env),
    getConfig(db, 'grid_flash_drop_window_min', env),
    getConfig(db, 'grid_flash_drop_max_fills', env),
    getConfig(db, 'grid_flash_drop_fill_window_min', env),
    getConfig(db, 'grid_flash_drop_overfill_mult', env),
    getConfig(db, 'grid_flash_drop_scout_block_panic', env),
    getConfig(db, 'grid_flash_drop_symbol_cooldown_min', env),
    getConfig(db, 'grid_readiness_downside_bars', env),
    getConfig(db, 'grid_readiness_short_return_bars', env),
    getConfig(db, 'grid_readiness_momentum_warn_pct', env),
    getConfig(db, 'grid_readiness_post_exit_relax_enabled', env),
    getConfig(db, 'grid_readiness_post_exit_relax_days', env),
    getConfig(db, 'grid_readiness_post_exit_momentum_warn_pct', env),
    getConfig(db, 'grid_readiness_max_entry_band_pct', env),
    getConfig(db, 'grid_readiness_medium_return_bars', env),
    getConfig(db, 'grid_readiness_medium_return_warn_pct', env),
    getConfig(db, 'grid_readiness_post_exit_cooldown_enabled', env),
    getConfig(db, 'grid_readiness_post_exit_cooldown_min', env),
    getConfig(db, 'grid_readiness_hour_decline_enabled', env),
    getConfig(db, 'grid_readiness_hour_decline_bars', env),
    getConfig(db, 'grid_allow_new_grid_while_recovering', env),
    getConfig(db, 'grid_readiness_max_path_range_ratio', env),
    getConfig(db, 'grid_readiness_max_bar_range_path_ratio', env),
    getConfig(db, 'grid_readiness_max_stability_range_pct', env),
    getConfig(db, 'grid_readiness_stability_bars', env),
    getConfig(db, 'grid_scout_risk_filter_enabled', env),
    getConfig(db, 'grid_scout_max_abs_change_pct', env),
    getConfig(db, 'grid_scout_pool_multiplier', env),
    getConfig(db, 'grid_max_consecutive_buys', env),
    getConfig(db, 'grid_ladder_mode', env),
    getConfig(db, 'grid_floor_exit_margin_pct', env),
    getConfig(db, 'grid_dip_buy_defer_steps', env),
    getConfig(db, 'grid_market_downturn_enabled', env),
    getConfig(db, 'grid_market_downturn_breadth_max_pct', env),
    getConfig(db, 'grid_market_downturn_btc_24h_pct', env),
    getConfig(db, 'grid_market_downturn_btc_15m_return_pct', env),
    getConfig(db, 'grid_market_downturn_scout_min_change_pct', env),
    getConfig(db, 'grid_market_downturn_block_panic', env),
    getConfig(db, 'grid_market_downturn_allow_manual', env),
    getConfig(db, 'grid_market_downturn_force_active', env),
  ]);
  const parsedLadder = String(ladderMode || 'breakeven_dip').toLowerCase();
  return {
    enabled: enabled === 'true',
    liveGate: liveGate === 'true',
    symbol: symbol.toUpperCase(),
    rangeMode: rangeMode === 'manual' ? 'manual' : 'auto',
    rangeLookbackDays: Math.max(1, Number(lookback) || 7),
    rangePctl: Math.min(40, Math.max(1, Number(pctl) || 15)),
    lowerPrice: Number(lower) || 0,
    upperPrice: Number(upper) || 0,
    gridCount: Math.max(2, Math.min(200, Number(count) || 20)),
    investmentUsdt: Math.max(10, Number(invest) || 200),
    feeRoundtripPct: Number(fee) || 0.15,
    feeWallMultiple: Math.max(1, Number(feeMult) || 2),
    stopBelowPct: Math.max(0, Number(stopBelow) || 2),
    recoveryMarginPct: Math.max(0, Number(recoveryMargin) || 0.3),
    stopAbovePct: Math.max(0, Number(stopAbove) || 2),
    rangeResetEnabled: rangeReset !== 'false',
    recenterEnabled: recenterEnabled !== 'false',
    recenterDriftPct: Math.min(100, Math.max(5, Number(recenterDrift) || 50)),
    readinessTeardownEnabled: readinessTeardown !== 'false',
    buyGuardEnabled: buyGuardEnabled !== 'false',
    buyCancelOpenOnNotReady: buyCancelOpen !== 'false',
    buyBlockNewOnNotReady: buyBlockNew !== 'false',
    buyCancelAnchorDrawdownPct: Math.max(0, Number(buyCancelAnchorDd) || 1),
    buyLogAssessment: buyLogAssessment !== 'false',
    teardownOnReadinessBlockers: teardownOnReadinessBlockers !== 'false',
    teardownReadinessBlockersCsv: String(teardownReadinessBlockers ?? '').trim(),
    recenterRequiresReady: recenterRequiresReady !== 'false',
    maxInventoryUsdt: Math.max(0, Number(maxInv) || 300),
    useWatchlist: useWatchlist !== 'false',
    candidateCount: Math.max(1, Math.min(50, Number(candidateCount) || 15)),
    maxEfficiencyRatio: Math.max(0.05, Math.min(1, Number(maxEr) || 0.35)),
    minRangeWidthPct: Math.max(0.5, Number(minRw) || 3),
    maxRangeWidthPct: Math.max(2, Number(maxRw) || 15),
    minAtrPct: Math.max(0, Number(minAtr) || 0.15),
    readinessMaxSpreadPct: Math.max(0.005, Number(readinessSpread) || 0.05),
    readinessLookback: Math.max(20, Math.min(500, Number(readinessLookback) || 96)),
    excludeSymbols: (excludeSymbols || '')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
    maxConcurrent: Math.max(1, Math.min(10, Number(maxConcurrent) || 3)),
    flashDropEnabled: flashEnabled !== 'false',
    flashDropWarnPct: Math.max(0, Number(flashWarn) || 2),
    flashDropPausePct: Math.max(0, Number(flashPause) || 3),
    flashDropRecoveryPct: Math.max(0, Number(flashRecovery) || 5),
    flashDropWindowMin: Math.max(5, Number(flashWindow) || 15),
    flashDropMaxFills: Math.max(1, Number(flashMaxFills) || 3),
    flashDropFillWindowMin: Math.max(1, Number(flashFillWindow) || 10),
    flashDropOverfillMult: Math.max(1, Number(flashOverfill) || 1.5),
    flashDropScoutBlockPanic: flashScoutPanic !== 'false',
    flashDropSymbolCooldownMin: Math.max(0, Number(flashCooldown) || 60),
    readinessDownsideBars: Math.max(0, Number(readinessDownsideBars) || 3),
    readinessShortReturnBars: Math.max(1, Number(readinessShortReturnBars) || 3),
    readinessMomentumWarnPct: Math.max(0, Number(readinessMomentumWarn) || 4),
    readinessPostExitRelaxEnabled: readinessPostExitRelaxEnabled !== 'false',
    readinessPostExitRelaxDays: Math.max(1, Number(readinessPostExitRelaxDays) || 10),
    readinessPostExitMomentumWarnPct: Math.max(
      0,
      Number(readinessPostExitMomentumWarn) || 7,
    ),
    readinessMaxEntryBandPct: Math.max(0, Math.min(100, Number(readinessMaxEntryBand) || 65)),
    readinessMediumReturnBars: Math.max(0, Number(readinessMediumReturnBars) || 36),
    readinessMediumReturnWarnPct: Math.max(0, Number(readinessMediumReturnWarn) || 2.5),
    readinessPostExitCooldownEnabled: readinessPostExitCooldownEnabled !== 'false',
    readinessPostExitCooldownMin: Math.max(0, Number(readinessPostExitCooldownMin) || 45),
    readinessHourDeclineEnabled: readinessHourDeclineEnabled !== 'false',
    readinessHourDeclineBars: Math.max(0, Math.min(96, Number(readinessHourDeclineBars) || 12)),
    allowNewGridWhileRecovering: allowNewWhileRecovering !== 'false',
    readinessMaxPathRangeRatio: Math.max(0, Number(readinessMaxPathRatio) || 12),
    readinessMaxBarRangePathRatio: Math.max(0, Number(readinessMaxBarPathRatio) || 18),
    readinessMaxStabilityRangePct: Math.max(0, Number(readinessMaxStabRange) || 28),
    readinessStabilityBars: Math.max(20, Math.min(500, Number(readinessStabilityBars) || 288)),
    scoutRiskFilterEnabled: scoutRiskFilter !== 'false',
    scoutMaxAbsChangePct: Math.max(0, Number(scoutMaxChange) || 12),
    scoutPoolMultiplier: Math.max(2, Math.min(10, Number(scoutPoolMult) || 4)),
    maxConsecutiveBuys: Math.max(1, Math.min(5, Number(maxConsecutiveBuys) || 2)),
    ladderMode: parsedLadder === 'classic' ? 'classic' : 'breakeven_dip',
    floorExitMarginPct: Math.max(0, Number(floorExitMargin) || 0.5),
    dipBuyDeferSteps: Math.max(0, Math.min(5, Math.floor(Number(dipBuyDeferSteps) || 1))),
    marketDownturnEnabled: marketDownturnEnabled !== 'false',
    marketDownturnBreadthMaxPct: Number(marketDownturnBreadthMax) || 38,
    marketDownturnBtc24hPct: Number(marketDownturnBtc24h) || -2.5,
    marketDownturnBtc15mReturnPct: Number(marketDownturnBtc15m) || -0.8,
    marketDownturnScoutMinChangePct: Number(marketDownturnScoutMinChange) || -2,
    marketDownturnBlockPanic: marketDownturnBlockPanic !== 'false',
    marketDownturnAllowManual: marketDownturnAllowManual === 'true',
    marketDownturnForceActive: marketDownturnForceActive === 'true',
  };
}

export async function getActiveGrid(db: D1Database): Promise<GridStateRow | null> {
  const row = await db
    .prepare("SELECT * FROM grid_state WHERE status = 'ACTIVE' ORDER BY id DESC LIMIT 1")
    .first<GridStateRow>();
  return row ?? null;
}

export async function getActiveGrids(db: D1Database): Promise<GridStateRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM grid_state WHERE status = 'ACTIVE' ORDER BY id ASC")
    .all<GridStateRow>();
  return results ?? [];
}

export async function getActiveGridForSymbol(
  db: D1Database,
  symbol: string,
): Promise<GridStateRow | null> {
  const row = await db
    .prepare("SELECT * FROM grid_state WHERE status = 'ACTIVE' AND symbol = ? ORDER BY id DESC LIMIT 1")
    .bind(symbol)
    .first<GridStateRow>();
  return row ?? null;
}

export async function createGrid(
  db: D1Database,
  params: {
    symbol: string;
    lower: number;
    upper: number;
    gridCount: number;
    investmentUsdt: number;
    anchorPrice: number;
  },
): Promise<GridStateRow> {
  await db
    .prepare(
      `INSERT INTO grid_state (symbol, lower_price, upper_price, grid_count, investment_usdt, anchor_price, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', datetime('now'), datetime('now'))`,
    )
    .bind(
      params.symbol,
      String(params.lower),
      String(params.upper),
      params.gridCount,
      String(params.investmentUsdt),
      String(params.anchorPrice),
    )
    .run();
  const created = await getActiveGridForSymbol(db, params.symbol);
  if (!created) throw new Error(`grid_not_found_after_insert:${params.symbol}`);
  return created;
}

export async function stopGrid(db: D1Database, gridId: number, reason: string): Promise<void> {
  await db
    .prepare(
      "UPDATE grid_state SET status = 'STOPPED', stop_reason = ?, updated_at = datetime('now') WHERE id = ?",
    )
    .bind(reason, gridId)
    .run();
}

export async function addGridRealized(
  db: D1Database,
  gridId: number,
  pnlDelta: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE grid_state
       SET realized_pnl = CAST(CAST(realized_pnl AS REAL) + CAST(? AS REAL) AS TEXT),
           cycles = cycles + 1,
           updated_at = datetime('now')
       WHERE id = ?`,
    )
    .bind(pnlDelta, gridId)
    .run();
}

export async function listGridOrders(
  db: D1Database,
  gridId: number,
  status?: GridOrderStatus,
): Promise<GridOrderRow[]> {
  if (status) {
    const { results } = await db
      .prepare('SELECT * FROM grid_orders WHERE grid_id = ? AND status = ? ORDER BY level_index')
      .bind(gridId, status)
      .all<GridOrderRow>();
    return results ?? [];
  }
  const { results } = await db
    .prepare('SELECT * FROM grid_orders WHERE grid_id = ? ORDER BY level_index')
    .bind(gridId)
    .all<GridOrderRow>();
  return results ?? [];
}

export async function insertGridOrder(
  db: D1Database,
  params: {
    gridId: number;
    levelIndex: number;
    side: GridOrderSide;
    price: string;
    qty: string;
    binanceOrderId?: string | null;
    buyCost?: string | null;
    cycleEntryPrice?: string | null;
    cycleTroughPrice?: string | null;
    cyclePeakPrice?: string | null;
  },
): Promise<number> {
  const entry = params.cycleEntryPrice ?? null;
  const trough = params.cycleTroughPrice ?? entry;
  const peak = params.cyclePeakPrice ?? entry;
  const result = await db
    .prepare(
      `INSERT INTO grid_orders (
         grid_id, level_index, side, price, qty, binance_order_id, status, buy_cost,
         cycle_entry_price, cycle_trough_price, cycle_peak_price,
         created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    )
    .bind(
      params.gridId,
      params.levelIndex,
      params.side,
      params.price,
      params.qty,
      params.binanceOrderId ?? null,
      params.buyCost ?? null,
      entry,
      trough,
      peak,
    )
    .run();
  return Number(result.meta.last_row_id);
}

/** Açık SELL emirlerinde cycle tepe/çukur güncelle (maintain turu). */
export async function updateOpenGridSellExcursions(
  db: D1Database,
  gridId: number,
  lastPrice: string,
): Promise<void> {
  const { results } = await db
    .prepare(
      `SELECT id, cycle_entry_price, cycle_trough_price, cycle_peak_price
       FROM grid_orders
       WHERE grid_id = ? AND side = 'SELL' AND status = 'OPEN' AND cycle_entry_price IS NOT NULL`,
    )
    .bind(gridId)
    .all<{
      id: number;
      cycle_entry_price: string;
      cycle_trough_price: string | null;
      cycle_peak_price: string | null;
    }>();

  for (const row of results ?? []) {
    const { peak, trough, changed } = computeGridCycleExcursionUpdate(
      lastPrice,
      row.cycle_entry_price,
      row.cycle_peak_price,
      row.cycle_trough_price,
    );
    if (!changed) continue;
    await db
      .prepare(
        `UPDATE grid_orders SET cycle_trough_price = ?, cycle_peak_price = ?, updated_at = datetime('now') WHERE id = ?`,
      )
      .bind(trough, peak, row.id)
      .run();
  }
}

/** Cycle satışına eşleşen son FILLED alış zamanı (hold süresi). */
export async function getPairedGridBuyFilledAt(
  db: D1Database,
  gridId: number,
  sellOrder: Pick<GridOrderRow, 'level_index' | 'buy_cost' | 'created_at'>,
): Promise<string | null> {
  const isFloor =
    sellOrder.buy_cost === FLOOR_EXIT_BUY_COST_TAG ||
    sellOrder.level_index === GRID_FLOOR_EXIT_LEVEL_INDEX;
  if (isFloor) {
    const row = await db
      .prepare(
        `SELECT updated_at FROM grid_orders
         WHERE grid_id = ? AND side = 'BUY' AND status = 'FILLED'
         ORDER BY id DESC LIMIT 1`,
      )
      .bind(gridId)
      .first<{ updated_at: string }>();
    return row?.updated_at ?? null;
  }
  const buyLevel = sellOrder.level_index - 1;
  if (buyLevel < 0) return null;
  const row = await db
    .prepare(
      `SELECT updated_at FROM grid_orders
       WHERE grid_id = ? AND side = 'BUY' AND level_index = ? AND status = 'FILLED'
       ORDER BY id DESC LIMIT 1`,
    )
    .bind(gridId, buyLevel)
    .first<{ updated_at: string }>();
  return row?.updated_at ?? null;
}

export async function markGridOrder(
  db: D1Database,
  orderId: number,
  status: GridOrderStatus,
): Promise<void> {
  await db
    .prepare("UPDATE grid_orders SET status = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(status, orderId)
    .run();
}

export async function setGridOrderBinanceId(
  db: D1Database,
  orderId: number,
  binanceOrderId: string,
): Promise<void> {
  await db
    .prepare("UPDATE grid_orders SET binance_order_id = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(binanceOrderId, orderId)
    .run();
}

export async function cancelAllGridOrders(db: D1Database, gridId: number): Promise<void> {
  await db
    .prepare("UPDATE grid_orders SET status = 'CANCELED', updated_at = datetime('now') WHERE grid_id = ? AND status = 'OPEN'")
    .bind(gridId)
    .run();
}

export async function cancelOpenGridOrdersBySide(
  db: D1Database,
  gridId: number,
  side: GridOrderSide,
): Promise<void> {
  await db
    .prepare(
      "UPDATE grid_orders SET status = 'CANCELED', updated_at = datetime('now') WHERE grid_id = ? AND status = 'OPEN' AND side = ?",
    )
    .bind(gridId, side)
    .run();
}

export async function updateGridRange(
  db: D1Database,
  gridId: number,
  lower: number,
  upper: number,
): Promise<void> {
  await db
    .prepare(
      "UPDATE grid_state SET lower_price = ?, upper_price = ?, updated_at = datetime('now') WHERE id = ?",
    )
    .bind(String(lower), String(upper), gridId)
    .run();
}

export async function setGridOrderLevelIndex(
  db: D1Database,
  orderId: number,
  levelIndex: number,
): Promise<void> {
  await db
    .prepare("UPDATE grid_orders SET level_index = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(levelIndex, orderId)
    .run();
}

export interface GridFilledStats {
  boughtQty: number;
  boughtCost: number;
  soldQty: number;
}

/** Bir gridin FILLED alış/satış toplamları (kalan bag + ortalama maliyet rekonstrüksiyonu için). */
/** Flash drop recovery sonrası yeni grid kurulmayacak semboller. */
/** Son N günde STOPPED olan grid sembolleri (sembol başına en son kayıt). */
export async function getRecentlyStoppedGridSymbols(
  db: D1Database,
  sinceDays: number,
): Promise<Map<string, { stopReason: string | null; stoppedAt: string }>> {
  if (sinceDays <= 0) return new Map();
  const { results } = await db
    .prepare(
      `SELECT symbol, stop_reason, updated_at AS stopped_at
       FROM grid_state
       WHERE status = 'STOPPED'
         AND updated_at >= datetime('now', ?)
       ORDER BY updated_at DESC`,
    )
    .bind(`-${sinceDays} days`)
    .all<{ symbol: string; stop_reason: string | null; stopped_at: string }>();
  const out = new Map<string, { stopReason: string | null; stoppedAt: string }>();
  for (const r of results ?? []) {
    const sym = String(r.symbol).toUpperCase();
    if (!out.has(sym)) {
      out.set(sym, {
        stopReason: r.stop_reason != null ? String(r.stop_reason) : null,
        stoppedAt: String(r.stopped_at),
      });
    }
  }
  return out;
}

/** Son N dakikada floor ile kapanan grid döngüleri (churn önleme). */
export async function getRecentFloorCycleSymbols(
  db: D1Database,
  sinceMinutes: number,
): Promise<Map<string, { cycledAt: string }>> {
  if (sinceMinutes <= 0) return new Map();
  const { results } = await db
    .prepare(
      `SELECT UPPER(json_extract(payload, '$.symbol')) AS symbol,
              MAX(created_at) AS cycled_at
       FROM trade_log
       WHERE event_type = 'GRID_CYCLE'
         AND json_extract(payload, '$.floorExit') = 1
         AND created_at >= datetime('now', ?)
       GROUP BY symbol`,
    )
    .bind(`-${sinceMinutes} minutes`)
    .all<{ symbol: string; cycled_at: string }>();
  const out = new Map<string, { cycledAt: string }>();
  for (const r of results ?? []) {
    const sym = String(r.symbol || '').toUpperCase();
    if (sym) out.set(sym, { cycledAt: String(r.cycled_at) });
  }
  return out;
}

export async function getFlashCooldownSymbols(
  db: D1Database,
  cooldownMin: number,
): Promise<Set<string>> {
  if (cooldownMin <= 0) return new Set();
  const { results } = await db
    .prepare(
      `SELECT DISTINCT symbol FROM grid_state
       WHERE updated_at >= datetime('now', ?)
         AND stop_reason LIKE '%flash_drop%'`,
    )
    .bind(`-${cooldownMin} minutes`)
    .all<{ symbol: string }>();
  return new Set((results ?? []).map((r) => r.symbol));
}

export async function getGridFilledStats(db: D1Database, gridId: number): Promise<GridFilledStats> {
  const row = await db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN side='BUY'  THEN CAST(qty AS REAL) END),0) bq,
         COALESCE(SUM(CASE WHEN side='BUY'  THEN CAST(qty AS REAL)*CAST(price AS REAL) END),0) bc,
         COALESCE(SUM(CASE WHEN side='SELL' THEN CAST(qty AS REAL) END),0) sq
       FROM grid_orders WHERE grid_id = ? AND status = 'FILLED'`,
    )
    .bind(gridId)
    .first<{ bq: number; bc: number; sq: number }>();
  return { boughtQty: row?.bq ?? 0, boughtCost: row?.bc ?? 0, soldQty: row?.sq ?? 0 };
}

/** Bir sembolün TÜM gridlerindeki FILLED alış/satış toplamları (öksüz bag maliyet bazı). */
export async function getGridFilledStatsBySymbol(
  db: D1Database,
  symbol: string,
): Promise<GridFilledStats> {
  const row = await db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN o.side='BUY'  THEN CAST(o.qty AS REAL) END),0) bq,
         COALESCE(SUM(CASE WHEN o.side='BUY'  THEN CAST(o.qty AS REAL)*CAST(o.price AS REAL) END),0) bc,
         COALESCE(SUM(CASE WHEN o.side='SELL' THEN CAST(o.qty AS REAL) END),0) sq
       FROM grid_orders o JOIN grid_state g ON o.grid_id = g.id
       WHERE g.symbol = ? AND o.status = 'FILLED'`,
    )
    .bind(symbol)
    .first<{ bq: number; bc: number; sq: number }>();
  return { boughtQty: row?.bq ?? 0, boughtCost: row?.bc ?? 0, soldQty: row?.sq ?? 0 };
}

/** Öksüz bag için doğrudan RECOVERING grid satırı oluştur (cron maintainRecovery izler). */
export async function createRecoveryGrid(
  db: D1Database,
  params: {
    symbol: string;
    investmentUsdt: number;
    recoveryOrderId: string;
    recoveryTargetPrice: string;
    recoveryQty: string;
    recoveryAvgCost: string;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO grid_state
         (symbol, lower_price, upper_price, grid_count, investment_usdt, status,
          recovery_order_id, recovery_target_price, recovery_qty, recovery_avg_cost,
          created_at, updated_at)
       VALUES (?, '0', '0', 0, ?, 'RECOVERING', ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    )
    .bind(
      params.symbol,
      String(params.investmentUsdt),
      params.recoveryOrderId,
      params.recoveryTargetPrice,
      params.recoveryQty,
      params.recoveryAvgCost,
    )
    .run();
}

export async function getRecoveringGrids(db: D1Database): Promise<GridStateRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM grid_state WHERE status = 'RECOVERING' ORDER BY id ASC")
    .all<GridStateRow>();
  return results ?? [];
}

export async function getGridById(db: D1Database, gridId: number): Promise<GridStateRow | null> {
  return db.prepare('SELECT * FROM grid_state WHERE id = ?').bind(gridId).first<GridStateRow>();
}

export async function setGridRecovering(
  db: D1Database,
  gridId: number,
  params: {
    recoveryOrderId: string;
    recoveryTargetPrice: string;
    recoveryQty: string;
    recoveryAvgCost: string;
    stopReason?: string;
  },
): Promise<void> {
  await db
    .prepare(
      `UPDATE grid_state
       SET status = 'RECOVERING',
           recovery_order_id = ?,
           recovery_target_price = ?,
           recovery_qty = ?,
           recovery_avg_cost = ?,
           stop_reason = COALESCE(?, stop_reason),
           updated_at = datetime('now')
       WHERE id = ?`,
    )
    .bind(
      params.recoveryOrderId,
      params.recoveryTargetPrice,
      params.recoveryQty,
      params.recoveryAvgCost,
      params.stopReason ?? null,
      gridId,
    )
    .run();
}

export async function closeRecoveredGrid(
  db: D1Database,
  gridId: number,
  pnlDelta: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE grid_state
       SET status = 'STOPPED',
           stop_reason = 'recovered',
           realized_pnl = CAST(CAST(realized_pnl AS REAL) + CAST(? AS REAL) AS TEXT),
           cycles = cycles + 1,
           recovery_order_id = NULL,
           recovery_target_price = NULL,
           recovery_qty = NULL,
           recovery_avg_cost = NULL,
           updated_at = datetime('now')
       WHERE id = ?`,
    )
    .bind(pnlDelta, gridId)
    .run();
}
