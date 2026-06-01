CREATE TABLE bot_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO bot_config (key, value) VALUES
  ('hard_stop_loss_pct', '4'),
  ('stable_max_volatility_pct', '0.1'),
  ('buy_quote_usdt', '175'),
  ('pullback_tolerance_pct', '0.5'),
  ('trailing_callback_rate', '1.5');
