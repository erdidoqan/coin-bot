-- Dip Reversal — volatile risk-off giriş blok (breadth çok düşükken downtrend_volatile).
INSERT OR IGNORE INTO bot_config (key, value, updated_at) VALUES
  ('dip_reversal_adapt_volatile_block_enabled', 'true', datetime('now')),
  ('dip_reversal_adapt_volatile_block_breadth_max', '10', datetime('now'));
