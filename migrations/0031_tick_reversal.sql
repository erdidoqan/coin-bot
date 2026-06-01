-- Tick reversal entry filters + 60s shadow forward tracking

CREATE TABLE IF NOT EXISTS tick_shadow_setups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  recorded_at_ms INTEGER NOT NULL,
  entry_ref_price TEXT NOT NULL,
  gain_pct TEXT,
  ws_decline_pct TEXT,
  recovery_pct TEXT,
  reversal_score REAL,
  scout_price TEXT,
  scout_vs_fill_pct TEXT,
  would_pass_reversal INTEGER NOT NULL DEFAULT 0,
  forward_60s_pct TEXT,
  forward_60s_positive INTEGER,
  resolved_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
);

CREATE INDEX IF NOT EXISTS idx_tick_shadow_status_time ON tick_shadow_setups(status, recorded_at_ms);
CREATE INDEX IF NOT EXISTS idx_tick_shadow_symbol_time ON tick_shadow_setups(symbol, recorded_at_ms);

INSERT OR IGNORE INTO bot_config (key, value, updated_at) VALUES
  ('tick_recovery_min_pct', '0.05', datetime('now')),
  ('tick_min_sec_after_trough', '10', datetime('now')),
  ('tick_max_sec_after_trough', '45', datetime('now')),
  ('tick_scout_max_below_pct', '1.0', datetime('now')),
  ('tick_scout_max_above_pct', '1.5', datetime('now')),
  ('tick_require_5m_light', 'true', datetime('now')),
  ('tick_require_spread_tightening', 'true', datetime('now')),
  ('tick_ob_ratio_at_recovery_min', '1.0', datetime('now')),
  ('tick_reversal_score_enabled', 'true', datetime('now')),
  ('tick_mid_slope_sample_count', '5', datetime('now')),
  ('tick_mid_slope_min_rising', '3', datetime('now')),
  ('tick_no_new_low_sec', '30', datetime('now')),
  ('tick_shadow_enabled', 'true', datetime('now')),
  ('tick_shadow_horizon_sec', '60', datetime('now')),
  ('tick_shadow_dedupe_minutes', '5', datetime('now'));
