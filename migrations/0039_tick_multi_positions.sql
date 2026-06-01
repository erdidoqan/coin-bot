CREATE TABLE IF NOT EXISTS open_positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL UNIQUE,
  entry_mode TEXT NOT NULL,
  net_base_qty TEXT NOT NULL,
  total_usdt_spent TEXT NOT NULL,
  total_base_qty TEXT NOT NULL,
  avg_cost TEXT NOT NULL,
  active_order_id TEXT,
  trailing_order_id TEXT,
  take_profit_price TEXT,
  scalp_stop_loss_pct TEXT,
  position_opened_at TEXT NOT NULL DEFAULT (datetime('now')),
  watchlist_cursor INTEGER NOT NULL DEFAULT 0,
  position_entry_context TEXT,
  position_peak_price TEXT,
  position_trough_price TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_open_positions_entry_mode
  ON open_positions(entry_mode);

CREATE INDEX IF NOT EXISTS idx_open_positions_updated_at
  ON open_positions(updated_at);

INSERT OR IGNORE INTO bot_config (key, value, updated_at)
VALUES ('tick_max_open_positions', '2', datetime('now'));

INSERT INTO open_positions (
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
  position_entry_context,
  position_peak_price,
  position_trough_price,
  created_at,
  updated_at
)
SELECT
  active_symbol,
  COALESCE(entry_mode, 'tick_scalp'),
  net_base_qty,
  total_usdt_spent,
  total_base_qty,
  avg_cost,
  active_order_id,
  trailing_order_id,
  take_profit_price,
  scalp_stop_loss_pct,
  COALESCE(position_opened_at, datetime('now')),
  watchlist_cursor,
  position_entry_context,
  position_peak_price,
  position_trough_price,
  datetime('now'),
  datetime('now')
FROM bot_state
WHERE id = 1
  AND active_symbol IS NOT NULL
  AND CAST(net_base_qty AS REAL) > 0
  AND NOT EXISTS (SELECT 1 FROM open_positions);
