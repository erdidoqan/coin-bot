-- Spot Grid stratejisi: aktif grid durumu + grid emirleri + config.
-- Additive: grid_enabled=false iken mevcut davranış değişmez.

CREATE TABLE IF NOT EXISTS grid_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  lower_price TEXT NOT NULL,
  upper_price TEXT NOT NULL,
  grid_count INTEGER NOT NULL,
  investment_usdt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',     -- ACTIVE | STOPPED
  realized_pnl TEXT NOT NULL DEFAULT '0',
  cycles INTEGER NOT NULL DEFAULT 0,
  stop_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_grid_state_status ON grid_state (status);

CREATE TABLE IF NOT EXISTS grid_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  grid_id INTEGER NOT NULL,
  level_index INTEGER NOT NULL,
  side TEXT NOT NULL,                          -- BUY | SELL
  price TEXT NOT NULL,
  qty TEXT NOT NULL,
  binance_order_id TEXT,
  status TEXT NOT NULL DEFAULT 'OPEN',         -- OPEN | FILLED | CANCELED
  buy_cost TEXT,                               -- SELL için kaynak alış maliyeti (realize hesabı)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_grid_orders_grid ON grid_orders (grid_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_grid_orders_level ON grid_orders (grid_id, level_index, status)
  WHERE status = 'OPEN';

-- Grid config anahtarları (sade set)
INSERT OR IGNORE INTO bot_config (key, value, updated_at) VALUES
  ('grid_enabled', 'false', datetime('now')),
  ('live_gate', 'false', datetime('now')),
  ('grid_symbol', 'BNBUSDT', datetime('now')),
  ('grid_range_mode', 'auto', datetime('now')),         -- auto | manual
  ('grid_range_lookback_days', '7', datetime('now')),
  ('grid_range_pctl', '15', datetime('now')),
  ('grid_lower_price', '0', datetime('now')),           -- manual mod
  ('grid_upper_price', '0', datetime('now')),           -- manual mod
  ('grid_count', '20', datetime('now')),
  ('grid_investment_usdt', '200', datetime('now')),
  ('grid_fee_roundtrip_pct', '0.15', datetime('now')),
  ('grid_fee_wall_multiple', '2', datetime('now')),
  ('grid_stop_below_pct', '2.0', datetime('now')),      -- alt sınırın bu kadar altında stop-out
  ('grid_stop_above_pct', '2.0', datetime('now')),      -- üst sınırın bu kadar üstünde stop-out (kâr al)
  ('grid_range_reset_enabled', 'true', datetime('now')),
  ('grid_max_inventory_usdt', '300', datetime('now'));  -- envanter (bag) tavanı guard
