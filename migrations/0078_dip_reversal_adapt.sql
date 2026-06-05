-- Dip Reversal — rejim-adaptasyon config (opt-in, varsayılan KAPALI).
INSERT OR IGNORE INTO bot_config (key, value, updated_at) VALUES
  ('dip_reversal_adapt_enabled', 'false', datetime('now')),
  ('dip_reversal_adapt_downtrend_mode', 'tighten', datetime('now')),
  ('dip_reversal_adapt_ema_min_sep_pct', '0.1', datetime('now')),
  ('dip_reversal_adapt_calm_atr_max', '0.5', datetime('now')),
  ('dip_reversal_adapt_volatile_atr_min', '1.0', datetime('now')),
  ('dip_reversal_adapt_downtrend_breadth_max', '40', datetime('now')),
  ('dip_reversal_adapt_calm_drop_mult', '0.7', datetime('now')),
  ('dip_reversal_adapt_dtvol_drop_mult', '1.15', datetime('now')),
  ('dip_reversal_adapt_dtvol_reversal_mult', '1.25', datetime('now')),
  ('dip_reversal_adapt_dtvol_recovery_mult', '1.25', datetime('now')),
  ('dip_reversal_adapt_dtgrind_drop_mult', '1.4', datetime('now')),
  ('dip_reversal_adapt_dtgrind_reversal_mult', '1.6', datetime('now')),
  ('dip_reversal_adapt_dtgrind_recovery_mult', '1.6', datetime('now'));
