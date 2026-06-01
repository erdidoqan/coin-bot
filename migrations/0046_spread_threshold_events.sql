-- Spread eşik geçişleri: Binance'a göre ±0.1% bandı dışına çıkış sayıları.
CREATE TABLE spread_threshold_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  exchange TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('above', 'below')),
  spread_pct REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_spread_threshold_symbol_exchange ON spread_threshold_events (symbol, exchange);
