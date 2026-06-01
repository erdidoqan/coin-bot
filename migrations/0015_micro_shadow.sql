-- Shadow / counterfactual forward PnL for vetoed micro-scalp setups

CREATE TABLE IF NOT EXISTS micro_shadow_setups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  recorded_at_ms INTEGER NOT NULL,
  entry_ref_price TEXT NOT NULL,
  score TEXT NOT NULL,
  micro_ok INTEGER NOT NULL,
  pass INTEGER NOT NULL,
  fail_reason TEXT,
  regime TEXT,
  trend15m_ok INTEGER NOT NULL,
  regime_allowed INTEGER NOT NULL,
  would_pass_score_only INTEGER NOT NULL,
  volume_ratio TEXT,
  aggression_ratio TEXT,
  forward_5m_pct TEXT,
  forward_15m_pct TEXT,
  forward_30m_pct TEXT,
  hit_tp_5m INTEGER,
  hit_tp_15m INTEGER,
  hit_tp_30m INTEGER,
  resolved_5m_at TEXT,
  resolved_15m_at TEXT,
  resolved_30m_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
);

CREATE INDEX IF NOT EXISTS idx_shadow_status_time ON micro_shadow_setups(status, recorded_at_ms);
CREATE INDEX IF NOT EXISTS idx_shadow_symbol_time ON micro_shadow_setups(symbol, recorded_at_ms);

INSERT OR IGNORE INTO bot_config (key, value, updated_at) VALUES
  ('micro_shadow_enabled', 'true', datetime('now')),
  ('micro_shadow_min_score', '0.35', datetime('now')),
  ('micro_shadow_dedupe_minutes', '10', datetime('now')),
  ('micro_shadow_horizons_min', '5,15,30', datetime('now'));
