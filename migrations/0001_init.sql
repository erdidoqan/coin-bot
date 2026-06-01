CREATE TABLE bot_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT NOT NULL DEFAULT 'IDLE',
  net_base_qty TEXT NOT NULL DEFAULT '0',
  active_symbol TEXT,
  total_usdt_spent TEXT NOT NULL DEFAULT '0',
  total_base_qty TEXT NOT NULL DEFAULT '0',
  avg_cost TEXT NOT NULL DEFAULT '0',
  active_order_id TEXT,
  trailing_order_id TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO bot_state (id, status) VALUES (1, 'IDLE');

CREATE TABLE watchlist (
  symbol TEXT PRIMARY KEY,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  price_at_addition TEXT NOT NULL,
  target_sma TEXT
);

CREATE TABLE trade_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_trade_log_created ON trade_log(created_at);
