-- Dip Watch: paper izleme listesi (giriş = listeye ekleme anı fiyatı)
CREATE TABLE dip_watch_entry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  entry_price REAL NOT NULL,
  entry_at TEXT NOT NULL,
  entry_low24h REAL,
  entry_high24h REAL,
  entry_position_pct REAL,
  last_price REAL,
  last_at TEXT,
  unrealized_pct REAL,
  max_gain_pct REAL DEFAULT 0,
  max_draw_pct REAL DEFAULT 0,
  exit_price REAL,
  exit_at TEXT,
  exit_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_dip_watch_entry_status ON dip_watch_entry (status);
CREATE INDEX idx_dip_watch_entry_symbol ON dip_watch_entry (symbol);
CREATE UNIQUE INDEX idx_dip_watch_entry_active_symbol ON dip_watch_entry (symbol) WHERE status = 'active';

INSERT OR IGNORE INTO bot_config (key, value) VALUES ('dip_watch_max_position_pct', '5');
INSERT OR IGNORE INTO bot_config (key, value) VALUES ('dip_watch_scan_pool_size', '80');
INSERT OR IGNORE INTO bot_config (key, value) VALUES ('dip_watch_max_tracked', '30');
INSERT OR IGNORE INTO bot_config (key, value) VALUES ('dip_watch_min_quote_volume_usdt', '500000');
