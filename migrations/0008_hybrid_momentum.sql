-- Hibrit momentum scalp + pullback entry_mode
ALTER TABLE bot_state ADD COLUMN entry_mode TEXT;
ALTER TABLE bot_state ADD COLUMN take_profit_price TEXT;

ALTER TABLE watchlist ADD COLUMN momentum_ok INTEGER NOT NULL DEFAULT 0;
ALTER TABLE watchlist ADD COLUMN momentum_checked_at TEXT;
ALTER TABLE watchlist ADD COLUMN momentum_detail TEXT;

INSERT OR IGNORE INTO bot_config (key, value) VALUES
  ('hybrid_enabled', 'true'),
  ('scalp_take_profit_gross_pct', '0.65'),
  ('scalp_fee_roundtrip_pct', '0.15'),
  ('scalp_max_hold_minutes', '30'),
  ('scalp_hard_stop_loss_pct', '2'),
  ('momentum_min_window_gain_pct', '0.1'),
  ('momentum_require_all_windows', 'true'),
  ('momentum_max_daily_change_pct', '12');
