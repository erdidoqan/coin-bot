import type { BotState, EntryMode } from '../db/bot-state';
import type { WatchlistEntry } from '../db/watchlist';
import { bn } from '../math/decimal';

/** Maliyete göre fiyat değişimi (%); negatif = maliyetin altında. */
export function pctFromBase(base: string, price: string): string {
  const b = bn(base);
  if (b.lte(0)) return '0';
  return bn(price).minus(b).dividedBy(b).times(100).toFixed(4);
}

export interface PositionEntryContext {
  symbol: string;
  entryMode: EntryMode;
  fillPrice: string;
  scoutPrice: string | null;
  scoutAddedAt: string | null;
  /** (fill - gözcü) / gözcü × 100 */
  scoutVsFillPct: string | null;
  gainPct: string | null;
  wsDeclinePct: string | null;
  wsDeclineOk: boolean | null;
  candleOpen: string | null;
  candleLow: string | null;
  mid: string | null;
  bidAskRatio: string | null;
  spreadPct: string | null;
  referenceWindowSec: number | null;
  recoveryFromWsLowPct: string | null;
  secSinceTrough: number | null;
  reversalScore: number | null;
  takeProfitPrice: string | null;
  takeProfitGrossPct: string | null;
  stopLossGrossPct: string | null;
  sector: string | null;
  protectiveExitType?: 'oco' | null;
  ocoOrderListId?: number | null;
  ocoTakeProfitOrderId?: number | null;
  ocoStopLossOrderId?: number | null;
  entryProfile?: TickEntryProfile | null;
  profileMaxHoldMinutes?: number | null;
  failFastUntilMs?: number | null;
  failFastMinFavorablePct?: string | null;
  failFastMaxAdversePct?: string | null;
  maxHoldDeferredAtMs?: number | null;
  maxHoldDeferredAtPrice?: string | null;
  maxHoldDeferredMarkPct?: string | null;
  maxHoldDeferredPeakPrice?: string | null;
  stepLockStage?: number;
  lockedStopPrice?: string | null;
  lockedStopPct?: string | null;
  stepLockConfig?: TickStepLockConfig | null;
}

export type TickEntryProfile = 'A' | 'B' | 'C';

export interface TickStepLockConfig {
  enabled: boolean;
  stage1TriggerPct: string;
  stage1LockPct: string;
  stage2TriggerPct: string;
  stage2LockPct: string;
}

export function buildPositionEntryContext(
  entry: WatchlistEntry,
  entryMode: EntryMode,
  fillPrice: string,
  extras: {
    tickDetail?: Record<string, unknown>;
    takeProfitPrice?: string;
    takeProfitGrossPct?: string;
    stopLossGrossPct?: string;
    protectiveOco?: {
      orderListId: number;
      takeProfitOrderId: number;
      stopLossOrderId: number;
    } | null;
    tickEntryProfile?: TickEntryProfile | null;
    profileMaxHoldMinutes?: number | null;
    failFastUntilMs?: number | null;
    failFastMinFavorablePct?: string | null;
    failFastMaxAdversePct?: string | null;
    maxHoldDeferredAtMs?: number | null;
    maxHoldDeferredAtPrice?: string | null;
    maxHoldDeferredMarkPct?: string | null;
    maxHoldDeferredPeakPrice?: string | null;
    stepLockStage?: number;
    lockedStopPrice?: string | null;
    lockedStopPct?: string | null;
    stepLockConfig?: TickStepLockConfig | null;
  },
): PositionEntryContext {
  const tick = extras.tickDetail ?? {};
  const scoutPrice = entry.price_at_addition || null;
  const scoutVsFillPct =
    scoutPrice && bn(scoutPrice).gt(0) ? pctFromBase(scoutPrice, fillPrice) : null;

  return {
    symbol: entry.symbol,
    entryMode,
    fillPrice,
    scoutPrice,
    scoutAddedAt: entry.added_at ?? null,
    scoutVsFillPct,
    gainPct: tick.gainPct != null ? String(tick.gainPct) : null,
    wsDeclinePct: tick.wsDeclinePct != null ? String(tick.wsDeclinePct) : null,
    wsDeclineOk: tick.wsDeclineOk === true || tick.wsDeclineOk === false ? tick.wsDeclineOk : null,
    candleOpen: tick.candleOpen != null ? String(tick.candleOpen) : null,
    candleLow: tick.candleLow != null ? String(tick.candleLow) : null,
    mid: tick.mid != null ? String(tick.mid) : null,
    bidAskRatio: tick.bidAskRatio != null ? String(tick.bidAskRatio) : null,
    spreadPct: tick.spreadPct != null ? String(tick.spreadPct) : null,
    referenceWindowSec:
      tick.referenceWindowSec != null ? Number(tick.referenceWindowSec) : null,
    recoveryFromWsLowPct:
      tick.recoveryFromWsLowPct != null ? String(tick.recoveryFromWsLowPct) : null,
    secSinceTrough: tick.secSinceTrough != null ? Number(tick.secSinceTrough) : null,
    reversalScore: tick.reversalScore != null ? Number(tick.reversalScore) : null,
    takeProfitPrice: extras.takeProfitPrice ?? null,
    takeProfitGrossPct: extras.takeProfitGrossPct ?? null,
    stopLossGrossPct: extras.stopLossGrossPct ?? null,
    sector: entry.sector_tag,
    protectiveExitType: extras.protectiveOco ? 'oco' : null,
    ocoOrderListId: extras.protectiveOco?.orderListId ?? null,
    ocoTakeProfitOrderId: extras.protectiveOco?.takeProfitOrderId ?? null,
    ocoStopLossOrderId: extras.protectiveOco?.stopLossOrderId ?? null,
    entryProfile: extras.tickEntryProfile ?? null,
    profileMaxHoldMinutes: extras.profileMaxHoldMinutes ?? null,
    failFastUntilMs: extras.failFastUntilMs ?? null,
    failFastMinFavorablePct: extras.failFastMinFavorablePct ?? null,
    failFastMaxAdversePct: extras.failFastMaxAdversePct ?? null,
    maxHoldDeferredAtMs: extras.maxHoldDeferredAtMs ?? null,
    maxHoldDeferredAtPrice: extras.maxHoldDeferredAtPrice ?? null,
    maxHoldDeferredMarkPct: extras.maxHoldDeferredMarkPct ?? null,
    maxHoldDeferredPeakPrice: extras.maxHoldDeferredPeakPrice ?? null,
    stepLockStage: extras.stepLockStage ?? 0,
    lockedStopPrice: extras.lockedStopPrice ?? null,
    lockedStopPct: extras.lockedStopPct ?? null,
    stepLockConfig: extras.stepLockConfig ?? null,
  };
}

export function parsePositionEntryContext(raw: string | null): PositionEntryContext | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PositionEntryContext;
  } catch {
    return null;
  }
}

export interface TradeOutcomePayload {
  symbol: string;
  entry_mode: EntryMode | null;
  source: string;
  pnl: string;
  spent: string;
  proceeds: string;
  avg_cost: string;
  exit_price: string;
  exit_pct_from_cost: string;
  max_favorable_pct: string;
  max_adverse_pct: string;
  peak_price: string;
  trough_price: string;
  entry: PositionEntryContext | null;
}

export function buildTradeOutcome(
  state: BotState,
  opts: {
    source: string;
    pnl: string;
    proceeds: string;
    exitPrice: string;
  },
): TradeOutcomePayload {
  const avgCost = state.avg_cost;
  const peak = state.position_peak_price ?? opts.exitPrice;
  const trough = state.position_trough_price ?? opts.exitPrice;
  const entry = parsePositionEntryContext(state.position_entry_context ?? null);

  return {
    symbol: state.active_symbol ?? entry?.symbol ?? '—',
    entry_mode: state.entry_mode,
    source: opts.source,
    pnl: opts.pnl,
    spent: state.total_usdt_spent,
    proceeds: opts.proceeds,
    avg_cost: avgCost,
    exit_price: opts.exitPrice,
    exit_pct_from_cost: pctFromBase(avgCost, opts.exitPrice),
    max_favorable_pct: pctFromBase(avgCost, peak),
    max_adverse_pct: pctFromBase(avgCost, trough),
    peak_price: peak,
    trough_price: trough,
    entry,
  };
}

export async function initPositionAnalytics(
  db: D1Database,
  context: PositionEntryContext,
  fillPrice: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE bot_state SET
        position_entry_context = ?,
        position_peak_price = ?,
        position_trough_price = ?
       WHERE id = 1`,
    )
    .bind(JSON.stringify(context), fillPrice, fillPrice)
    .run();
}

export async function initOpenPositionAnalytics(
  db: D1Database,
  positionId: number,
  context: PositionEntryContext,
  fillPrice: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE open_positions SET
        position_entry_context = ?,
        position_peak_price = ?,
        position_trough_price = ?,
        updated_at = datetime('now')
       WHERE id = ?`,
    )
    .bind(JSON.stringify(context), fillPrice, fillPrice, positionId)
    .run();
}

export async function patchPositionEntryContext(
  db: D1Database,
  patch: Partial<PositionEntryContext>,
): Promise<PositionEntryContext | null> {
  const row = await db
    .prepare('SELECT position_entry_context FROM bot_state WHERE id = 1')
    .first<{ position_entry_context: string | null }>();
  const current = parsePositionEntryContext(row?.position_entry_context ?? null);
  if (!current) return null;
  const next: PositionEntryContext = { ...current, ...patch };
  await db
    .prepare(
      `UPDATE bot_state SET
        position_entry_context = ?,
        updated_at = datetime('now')
       WHERE id = 1`,
    )
    .bind(JSON.stringify(next))
    .run();
  return next;
}

export async function patchOpenPositionEntryContext(
  db: D1Database,
  positionId: number,
  patch: Partial<PositionEntryContext>,
): Promise<PositionEntryContext | null> {
  const row = await db
    .prepare('SELECT position_entry_context FROM open_positions WHERE id = ?')
    .bind(positionId)
    .first<{ position_entry_context: string | null }>();
  const current = parsePositionEntryContext(row?.position_entry_context ?? null);
  if (!current) return null;
  const next: PositionEntryContext = { ...current, ...patch };
  await db
    .prepare(
      `UPDATE open_positions SET
        position_entry_context = ?,
        updated_at = datetime('now')
       WHERE id = ?`,
    )
    .bind(JSON.stringify(next), positionId)
    .run();
  return next;
}

export async function updatePositionExcursion(
  db: D1Database,
  avgCost: string,
  lastPrice: string,
  currentPeak: string | null,
  currentTrough: string | null,
): Promise<{ peak: string; trough: string; newHigh: boolean; newLow: boolean }> {
  let peak = currentPeak && bn(currentPeak).gt(0) ? currentPeak : avgCost;
  let trough = currentTrough && bn(currentTrough).gt(0) ? currentTrough : avgCost;
  let newHigh = false;
  let newLow = false;

  if (bn(lastPrice).gt(peak)) {
    peak = lastPrice;
    newHigh = true;
  }
  if (bn(lastPrice).lt(trough)) {
    trough = lastPrice;
    newLow = true;
  }

  if (newHigh || newLow) {
    await db
      .prepare(
        `UPDATE bot_state SET position_peak_price = ?, position_trough_price = ?, updated_at = datetime('now') WHERE id = 1`,
      )
      .bind(peak, trough)
      .run();
  }

  return { peak, trough, newHigh, newLow };
}

export async function updateOpenPositionExcursion(
  db: D1Database,
  positionId: number,
  avgCost: string,
  lastPrice: string,
  currentPeak: string | null,
  currentTrough: string | null,
): Promise<{ peak: string; trough: string; newHigh: boolean; newLow: boolean }> {
  let peak = currentPeak && bn(currentPeak).gt(0) ? currentPeak : avgCost;
  let trough = currentTrough && bn(currentTrough).gt(0) ? currentTrough : avgCost;
  let newHigh = false;
  let newLow = false;

  if (bn(lastPrice).gt(peak)) {
    peak = lastPrice;
    newHigh = true;
  }
  if (bn(lastPrice).lt(trough)) {
    trough = lastPrice;
    newLow = true;
  }

  if (newHigh || newLow) {
    await db
      .prepare(
        `UPDATE open_positions
         SET position_peak_price = ?, position_trough_price = ?, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .bind(peak, trough, positionId)
      .run();
  }

  return { peak, trough, newHigh, newLow };
}

export function entryContextToLogPayload(ctx: PositionEntryContext): Record<string, unknown> {
  return { ...ctx };
}

export function outcomeToFeatureRecord(outcome: TradeOutcomePayload): Record<string, unknown> {
  const e = outcome.entry;
  return {
    source: outcome.source,
    pnl: outcome.pnl,
    spent: outcome.spent,
    proceeds: outcome.proceeds,
    avg_cost: outcome.avg_cost,
    exit_price: outcome.exit_price,
    exit_pct_from_cost: outcome.exit_pct_from_cost,
    max_favorable_pct: outcome.max_favorable_pct,
    max_adverse_pct: outcome.max_adverse_pct,
    peak_price: outcome.peak_price,
    trough_price: outcome.trough_price,
    gainPctAtEntry: e?.gainPct ?? null,
    wsDeclinePctAtEntry: e?.wsDeclinePct ?? null,
    scoutPrice: e?.scoutPrice ?? null,
    scoutVsFillPct: e?.scoutVsFillPct ?? null,
    fillPrice: e?.fillPrice ?? outcome.avg_cost,
    entryProfile: e?.entryProfile ?? null,
    lockedStopPrice: e?.lockedStopPrice ?? null,
    lockedStopPct: e?.lockedStopPct ?? null,
  };
}
