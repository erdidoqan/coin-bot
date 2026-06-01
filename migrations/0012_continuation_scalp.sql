INSERT OR REPLACE INTO bot_config (key, value, updated_at) VALUES
  ('scalp_take_profit_gross_pct', '1.0', datetime('now')),
  ('scalp_hard_stop_loss_pct', '1.0', datetime('now')),
  ('momentum_max_daily_change_pct', '8', datetime('now')),
  ('momentum_switch_enabled', 'false', datetime('now')),
  ('momentum_min_green_windows', '4', datetime('now')),
  ('momentum_min_window_gain_pct', '0.1', datetime('now')),
  ('momentum_max_pullback_pct', '0.15', datetime('now')),
  ('momentum_require_short_tf', 'true', datetime('now')),
  ('scout_max_15m_pump_pct', '2.5', datetime('now'));
