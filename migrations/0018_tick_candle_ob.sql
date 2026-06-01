INSERT OR IGNORE INTO bot_config (key, value, updated_at) VALUES
  ('tick_orderbook_ratio_min', '1.05', datetime('now')),
  ('tick_max_spread_pct', '0.08', datetime('now'));
