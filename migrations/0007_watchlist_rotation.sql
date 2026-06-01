ALTER TABLE bot_state ADD COLUMN position_opened_at TEXT;
ALTER TABLE bot_state ADD COLUMN watchlist_cursor INTEGER NOT NULL DEFAULT 0;

INSERT OR IGNORE INTO bot_config (key, value) VALUES
  ('rotation_window_minutes', '15'),
  ('rotation_min_improvement_pct', '0.2');
