INSERT OR IGNORE INTO bot_config (key, value, updated_at) VALUES
  ('grid_ladder_mode', 'breakeven_dip', datetime('now')),
  ('grid_floor_exit_margin_pct', '0.5', datetime('now'));
