import type { EntryMode } from './bot-state';

export interface OpenPosition {
  id: number;
  symbol: string;
  entry_mode: EntryMode;
  net_base_qty: string;
  total_usdt_spent: string;
  total_base_qty: string;
  avg_cost: string;
  active_order_id: string | null;
  trailing_order_id: string | null;
  take_profit_price: string | null;
  scalp_stop_loss_pct: string | null;
  position_opened_at: string;
  watchlist_cursor: number;
  position_entry_context: string | null;
  position_peak_price: string | null;
  position_trough_price: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateOpenPositionParams {
  symbol: string;
  entry_mode: EntryMode;
  net_base_qty: string;
  total_usdt_spent: string;
  total_base_qty: string;
  avg_cost: string;
  active_order_id?: string | null;
  trailing_order_id?: string | null;
  take_profit_price?: string | null;
  scalp_stop_loss_pct?: string | null;
  position_opened_at?: string | null;
  watchlist_cursor?: number;
}

export async function listOpenPositions(
  db: D1Database,
  options?: { entryMode?: EntryMode },
): Promise<OpenPosition[]> {
  if (options?.entryMode) {
    const { results } = await db
      .prepare(
        `SELECT *
         FROM open_positions
         WHERE entry_mode = ?
         ORDER BY datetime(position_opened_at) ASC, id ASC`,
      )
      .bind(options.entryMode)
      .all<OpenPosition>();
    return results ?? [];
  }
  const { results } = await db
    .prepare(
      `SELECT *
       FROM open_positions
       ORDER BY datetime(position_opened_at) ASC, id ASC`,
    )
    .all<OpenPosition>();
  return results ?? [];
}

export async function countOpenPositions(
  db: D1Database,
  options?: { entryMode?: EntryMode },
): Promise<number> {
  if (options?.entryMode) {
    const row = await db
      .prepare('SELECT COUNT(1) AS n FROM open_positions WHERE entry_mode = ?')
      .bind(options.entryMode)
      .first<{ n: number }>();
    return Number(row?.n ?? 0);
  }
  const row = await db
    .prepare('SELECT COUNT(1) AS n FROM open_positions')
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export async function hasOpenPositionForSymbol(
  db: D1Database,
  symbol: string,
): Promise<boolean> {
  const row = await db
    .prepare('SELECT id FROM open_positions WHERE symbol = ? LIMIT 1')
    .bind(symbol)
    .first<{ id: number }>();
  return Boolean(row?.id);
}

export async function getOpenPositionById(
  db: D1Database,
  id: number,
): Promise<OpenPosition | null> {
  const row = await db
    .prepare('SELECT * FROM open_positions WHERE id = ?')
    .bind(id)
    .first<OpenPosition>();
  return row ?? null;
}

export async function createOpenPosition(
  db: D1Database,
  params: CreateOpenPositionParams,
): Promise<OpenPosition> {
  await db
    .prepare(
      `INSERT INTO open_positions (
        symbol,
        entry_mode,
        net_base_qty,
        total_usdt_spent,
        total_base_qty,
        avg_cost,
        active_order_id,
        trailing_order_id,
        take_profit_price,
        scalp_stop_loss_pct,
        position_opened_at,
        watchlist_cursor,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), ?, datetime('now'), datetime('now'))`,
    )
    .bind(
      params.symbol,
      params.entry_mode,
      params.net_base_qty,
      params.total_usdt_spent,
      params.total_base_qty,
      params.avg_cost,
      params.active_order_id ?? null,
      params.trailing_order_id ?? null,
      params.take_profit_price ?? null,
      params.scalp_stop_loss_pct ?? null,
      params.position_opened_at ?? null,
      params.watchlist_cursor ?? 0,
    )
    .run();

  const created = await db
    .prepare('SELECT * FROM open_positions WHERE symbol = ? LIMIT 1')
    .bind(params.symbol)
    .first<OpenPosition>();
  if (!created) {
    throw new Error(`open_position_not_found_after_insert:${params.symbol}`);
  }

  await syncPrimaryBotStateFromOpenPositions(db);
  return created;
}

export async function removeOpenPosition(db: D1Database, id: number): Promise<void> {
  await db
    .prepare('DELETE FROM open_positions WHERE id = ?')
    .bind(id)
    .run();
  await syncPrimaryBotStateFromOpenPositions(db);
}

export async function clearAllOpenPositions(db: D1Database): Promise<void> {
  await db.prepare('DELETE FROM open_positions').run();
  await syncPrimaryBotStateFromOpenPositions(db);
}

export async function syncPrimaryBotStateFromOpenPositions(db: D1Database): Promise<void> {
  const rows = await listOpenPositions(db);
  if (rows.length === 0) {
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
          updated_at = datetime('now')
        WHERE id = 1`,
      )
      .run();
    return;
  }

  const primary = rows[0]!;
  await db
    .prepare(
      `UPDATE bot_state SET
        status = 'TIER_1_BULL',
        net_base_qty = ?,
        active_symbol = ?,
        total_usdt_spent = ?,
        total_base_qty = ?,
        avg_cost = ?,
        active_order_id = ?,
        trailing_order_id = ?,
        entry_mode = ?,
        take_profit_price = ?,
        scalp_stop_loss_pct = ?,
        position_opened_at = ?,
        watchlist_cursor = ?,
        position_entry_context = ?,
        position_peak_price = ?,
        position_trough_price = ?,
        updated_at = datetime('now')
      WHERE id = 1`,
    )
    .bind(
      primary.net_base_qty,
      primary.symbol,
      primary.total_usdt_spent,
      primary.total_base_qty,
      primary.avg_cost,
      primary.active_order_id,
      primary.trailing_order_id,
      primary.entry_mode,
      primary.take_profit_price,
      primary.scalp_stop_loss_pct,
      primary.position_opened_at,
      primary.watchlist_cursor,
      primary.position_entry_context,
      primary.position_peak_price,
      primary.position_trough_price,
    )
    .run();
}
