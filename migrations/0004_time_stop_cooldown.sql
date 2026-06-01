-- Pozisyon giriş zamanı (updated_at'ten bağımsız)
ALTER TABLE bot_state ADD COLUMN position_opened_at TEXT;

-- Scout watchlist silinse bile kalır
CREATE TABLE symbol_cooldown (
  symbol TEXT PRIMARY KEY,
  ignored_until TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT 'time_stop',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_symbol_cooldown_until ON symbol_cooldown(ignored_until);

INSERT OR IGNORE INTO bot_config (key, value) VALUES
  ('time_stop_minutes', '15'),
  ('time_stop_band_pct', '0.5'),
  ('cooldown_minutes', '60');
