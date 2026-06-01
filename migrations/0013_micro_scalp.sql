-- Mikro-scalp strateji: watchlist skorları, trade features, pozisyon stop %

ALTER TABLE watchlist ADD COLUMN micro_score TEXT;
ALTER TABLE watchlist ADD COLUMN micro_ok INTEGER NOT NULL DEFAULT 0;
ALTER TABLE watchlist ADD COLUMN micro_checked_at TEXT;
ALTER TABLE watchlist ADD COLUMN micro_detail TEXT;
ALTER TABLE watchlist ADD COLUMN sector_tag TEXT;

ALTER TABLE bot_state ADD COLUMN scalp_stop_loss_pct TEXT;

CREATE TABLE IF NOT EXISTS trade_features (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  phase TEXT NOT NULL,
  entry_mode TEXT,
  features TEXT NOT NULL,
  outcome TEXT,
  pnl TEXT,
  regime TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_trade_features_created ON trade_features(created_at);

CREATE TABLE IF NOT EXISTS regime_cache (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  regime TEXT NOT NULL DEFAULT 'trend',
  detail TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO regime_cache (id, regime) VALUES (1, 'trend');

INSERT OR IGNORE INTO bot_config (key, value, updated_at) VALUES
  ('micro_scalp_enabled', 'true', datetime('now')),
  ('hybrid_enabled', 'false', datetime('now')),
  ('micro_universe_size', '80', datetime('now')),
  ('micro_min_quote_volume_usdt', '50000000', datetime('now')),
  ('micro_max_spread_pct', '0.08', datetime('now')),
  ('micro_min_15m_move_pct', '0.15', datetime('now')),
  ('micro_entry_min_score', '0.75', datetime('now')),
  ('micro_exit_score_floor', '0.35', datetime('now')),
  ('micro_scan_batch_size', '8', datetime('now')),
  ('micro_scan_cursor', '0', datetime('now')),
  ('micro_min_net_tp_pct', '0.25', datetime('now')),
  ('micro_volume_ratio_min', '2.2', datetime('now')),
  ('micro_orderbook_ratio_min', '1.4', datetime('now')),
  ('micro_phase2_enabled', 'true', datetime('now')),
  ('micro_phase3_enabled', 'true', datetime('now')),
  ('micro_aggression_min', '0.65', datetime('now')),
  ('micro_ob_persistence_seconds', '5', datetime('now')),
  ('max_open_scalp_positions', '1', datetime('now')),
  ('scalp_take_profit_gross_pct', '0.7', datetime('now')),
  ('scalp_hard_stop_loss_pct', '0.3', datetime('now')),
  ('scalp_max_hold_minutes', '15', datetime('now')),
  ('scalp_fee_roundtrip_pct', '0.20', datetime('now')),
  ('watchlist_size', '80', datetime('now'));
