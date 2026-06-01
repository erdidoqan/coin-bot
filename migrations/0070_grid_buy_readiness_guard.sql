-- Grid alım readiness koruması (P0–P4): açık BUY iptal, yeni alış bloke, teardown, recenter.

INSERT OR IGNORE INTO bot_config (key, value, updated_at) VALUES
  ('grid_buy_guard_enabled', 'true', datetime('now')),
  ('grid_buy_cancel_open_on_not_ready', 'true', datetime('now')),
  ('grid_buy_block_new_on_not_ready', 'true', datetime('now')),
  ('grid_buy_cancel_anchor_drawdown_pct', '1.0', datetime('now')),
  ('grid_buy_log_assessment', 'true', datetime('now')),
  ('grid_teardown_on_readiness_blockers', 'true', datetime('now')),
  ('grid_teardown_readiness_blockers', 'downside_momentum,hour_decline,flash_drop', datetime('now')),
  ('grid_recenter_requires_ready', 'true', datetime('now'));
