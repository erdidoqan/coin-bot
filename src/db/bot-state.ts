import { bn } from '../math/decimal';
import { clearMockTrailingSim } from './mock-sim';

export type BotStatus = 'IDLE' | 'TIER_1_BULL' | 'MANUAL_INTERVENTION' | 'ERROR';

export type EntryMode =
  | 'pullback'
  | 'momentum_scalp'
  | 'micro_scalp'
  | 'tick_scalp'
  | 'dip_reversal';

export interface BotState {
  id: number;
  status: BotStatus;
  net_base_qty: string;
  active_symbol: string | null;
  total_usdt_spent: string;
  total_base_qty: string;
  avg_cost: string;
  active_order_id: string | null;
  trailing_order_id: string | null;
  position_opened_at: string | null;
  watchlist_cursor: number;
  entry_mode: EntryMode | null;
  take_profit_price: string | null;
  scalp_stop_loss_pct: string | null;
  position_entry_context: string | null;
  position_peak_price: string | null;
  position_trough_price: string | null;
  updated_at: string;
}

export function resolveEntryMode(state: BotState): EntryMode {
  return state.entry_mode ?? 'pullback';
}

export function isScalpEntryMode(mode: EntryMode | null): boolean {
  return mode === 'momentum_scalp' || mode === 'micro_scalp' || mode === 'tick_scalp';
}

export async function getBotState(db: D1Database): Promise<BotState> {
  const row = await db.prepare('SELECT * FROM bot_state WHERE id = 1').first<BotState>();
  if (!row) throw new Error('bot_state seed missing');
  return row;
}

export async function setStatus(db: D1Database, status: BotStatus): Promise<void> {
  await db
    .prepare("UPDATE bot_state SET status = ?, updated_at = datetime('now') WHERE id = 1")
    .bind(status)
    .run();
}

export interface OpenPositionParams {
  status: BotStatus;
  active_symbol: string;
  net_base_qty: string;
  total_usdt_spent: string;
  total_base_qty: string;
  avg_cost: string;
  trailing_order_id?: string | null;
  active_order_id?: string | null;
  watchlist_cursor?: number;
  entry_mode?: EntryMode | null;
  take_profit_price?: string | null;
  scalp_stop_loss_pct?: string | null;
}

export async function openPosition(db: D1Database, params: OpenPositionParams): Promise<void> {
  await db
    .prepare(
      `UPDATE bot_state SET
        status = ?,
        active_symbol = ?,
        net_base_qty = ?,
        total_usdt_spent = ?,
        total_base_qty = ?,
        avg_cost = ?,
        trailing_order_id = ?,
        active_order_id = ?,
        entry_mode = ?,
        take_profit_price = ?,
        scalp_stop_loss_pct = ?,
        position_opened_at = datetime('now'),
        watchlist_cursor = COALESCE(?, watchlist_cursor),
        updated_at = datetime('now')
      WHERE id = 1`,
    )
    .bind(
      params.status,
      params.active_symbol,
      params.net_base_qty,
      params.total_usdt_spent,
      params.total_base_qty,
      params.avg_cost,
      params.trailing_order_id ?? null,
      params.active_order_id ?? null,
      params.entry_mode ?? null,
      params.take_profit_price ?? null,
      params.scalp_stop_loss_pct ?? null,
      params.watchlist_cursor ?? null,
    )
    .run();
}

export interface ResetToIdleOptions {
  /** Rotasyon sonrası hedef indeks; normal kapanışta 0 */
  watchlistCursor?: number;
}

export async function resetToIdle(db: D1Database, options?: ResetToIdleOptions): Promise<void> {
  const cursor = options?.watchlistCursor ?? 0;
  await db
    .prepare(
      `UPDATE bot_state SET
        status = 'IDLE',
        net_base_qty = '0',
        active_symbol = NULL,
        total_usdt_spent = '0',
        total_base_qty = '0',
        avg_cost = '0',
        active_order_id = NULL,
        trailing_order_id = NULL,
        entry_mode = NULL,
        take_profit_price = NULL,
        scalp_stop_loss_pct = NULL,
        position_opened_at = NULL,
        position_entry_context = NULL,
        position_peak_price = NULL,
        position_trough_price = NULL,
        watchlist_cursor = ?,
        updated_at = datetime('now')
      WHERE id = 1`,
    )
    .bind(cursor)
    .run();
  await clearMockTrailingSim(db);
}

export async function updateNetBaseQty(db: D1Database, net_base_qty: string): Promise<void> {
  await db
    .prepare("UPDATE bot_state SET net_base_qty = ?, updated_at = datetime('now') WHERE id = 1")
    .bind(net_base_qty)
    .run();
}

export async function setTrailingOrderId(db: D1Database, orderId: string): Promise<void> {
  await db
    .prepare("UPDATE bot_state SET trailing_order_id = ?, updated_at = datetime('now') WHERE id = 1")
    .bind(orderId)
    .run();
}

export async function clearTrailingOrderId(db: D1Database): Promise<void> {
  await db
    .prepare("UPDATE bot_state SET trailing_order_id = NULL WHERE id = 1")
    .run();
}

export async function setActiveOrderId(db: D1Database, orderId: string | null): Promise<void> {
  await db
    .prepare("UPDATE bot_state SET active_order_id = ?, updated_at = datetime('now') WHERE id = 1")
    .bind(orderId)
    .run();
}

/** Alım zamanı; eski pozisyonlarda position_opened_at boşsa updated_at kullanılır. */
export function resolvePositionOpenedAt(state: BotState): string | null {
  return state.position_opened_at ?? state.updated_at ?? null;
}

/**
 * Eksik position_opened_at (eski alım / migration) → şimdi yazılır;
 * rotasyon bekleme süresi yeniden başlar.
 */
export async function ensurePositionOpenedAt(db: D1Database, state: BotState): Promise<void> {
  if (state.status !== 'TIER_1_BULL' || state.position_opened_at || !state.active_symbol) return;
  await db
    .prepare(
      `UPDATE bot_state SET position_opened_at = datetime('now') WHERE id = 1 AND position_opened_at IS NULL`,
    )
    .run();
}

export function computeAvgCost(usdtSpent: string, baseQty: string): string {
  const qty = bn(baseQty);
  if (qty.isZero()) return '0';
  return bn(usdtSpent).dividedBy(qty).toFixed(8);
}
