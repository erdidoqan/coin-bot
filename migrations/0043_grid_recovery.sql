-- Grid break-even recovery: stop_below'da zararına satma yerine LIMIT_MAKER kârlı çıkış.

ALTER TABLE grid_state ADD COLUMN recovery_order_id TEXT;
ALTER TABLE grid_state ADD COLUMN recovery_target_price TEXT;
ALTER TABLE grid_state ADD COLUMN recovery_qty TEXT;
ALTER TABLE grid_state ADD COLUMN recovery_avg_cost TEXT;

INSERT OR IGNORE INTO bot_config (key, value, updated_at) VALUES
  ('grid_recovery_margin_pct', '0.3', datetime('now'));
