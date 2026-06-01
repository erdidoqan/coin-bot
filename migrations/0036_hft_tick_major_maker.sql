-- HFT tick profil: major-only universe + maker entry + aggTrade burst gate

INSERT OR IGNORE INTO bot_config (key, value, updated_at) VALUES
  ('tick_major_only', 'true', datetime('now')),
  ('tick_major_symbols', 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT', datetime('now')),
  ('tick_use_limit_maker', 'true', datetime('now')),
  ('tick_limit_buy_offset_pct', '0.05', datetime('now')),
  ('tick_entry_order_ttl_sec', '8', datetime('now')),
  ('tick_stop_limit_buffer_pct', '0.05', datetime('now')),
  ('tick_agg_burst_enabled', 'true', datetime('now')),
  ('tick_agg_window_sec', '10', datetime('now')),
  ('tick_agg_buy_count_min', '4', datetime('now')),
  ('tick_agg_buy_quote_min_usdt', '1000', datetime('now')),
  ('tick_agg_imbalance_min', '0.05', datetime('now'));

UPDATE bot_config SET value = '5', updated_at = datetime('now') WHERE key = 'watchlist_size';
UPDATE bot_config SET value = '0.08', updated_at = datetime('now') WHERE key = 'tick_entry_gain_pct';
UPDATE bot_config SET value = '0.80', updated_at = datetime('now') WHERE key = 'tick_entry_gain_max_pct';
UPDATE bot_config SET value = '0.50', updated_at = datetime('now') WHERE key = 'tick_take_profit_pct';
UPDATE bot_config SET value = '0.40', updated_at = datetime('now') WHERE key = 'tick_stop_loss_pct';
UPDATE bot_config SET value = '0.20', updated_at = datetime('now') WHERE key = 'tick_orderbook_ratio_min';
UPDATE bot_config SET value = '0.03', updated_at = datetime('now') WHERE key = 'tick_max_spread_pct';
UPDATE bot_config SET value = '0.00', updated_at = datetime('now') WHERE key = 'tick_recovery_fee_margin_pct';
UPDATE bot_config SET value = '3', updated_at = datetime('now') WHERE key = 'tick_min_sec_after_trough';
UPDATE bot_config SET value = '60', updated_at = datetime('now') WHERE key = 'tick_max_sec_after_trough';
