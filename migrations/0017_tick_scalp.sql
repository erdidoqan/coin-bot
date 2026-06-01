-- Tick scalp: basit fiyat tetikli giriş (+0.01%), TP (+0.65%), SL (-0.1%)

INSERT OR REPLACE INTO bot_config (key, value, updated_at) VALUES
  ('tick_scalp_enabled', 'true', datetime('now')),
  ('micro_scalp_enabled', 'false', datetime('now')),
  ('tick_entry_gain_pct', '0.01', datetime('now')),
  ('tick_take_profit_pct', '0.65', datetime('now')),
  ('tick_stop_loss_pct', '0.1', datetime('now')),
  ('tick_reference_window_sec', '120', datetime('now'));
