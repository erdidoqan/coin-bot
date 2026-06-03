-- Dip Reversal Sniper — bağımsız strateji config satırları.
-- Düşüşte capitulation dip + bounce onayı ile al, Binance native trailing ile sat.
-- Grid'den tamamen izole (entry_mode='dip_reversal'). Varsayılan KAPALI (güvenlik).
-- Eşikler canlı gözleme göre kalibre (chop dip'lerinde windowDrop ~%1).
INSERT OR IGNORE INTO bot_config (key, value, updated_at) VALUES
  ('dip_reversal_enabled', 'false', datetime('now')),
  ('dip_reversal_buy_quote_usdt', '30', datetime('now')),
  ('dip_reversal_max_concurrent', '3', datetime('now')),
  ('dip_reversal_min_capitulation_drop_pct', '1.0', datetime('now')),
  ('dip_reversal_flash_window_min', '10', datetime('now')),
  ('dip_reversal_min_ws_decline_pct', '0.4', datetime('now')),
  ('dip_reversal_min_recovery_from_low_pct', '0.15', datetime('now')),
  ('dip_reversal_min_reversal_score', '1.0', datetime('now')),
  ('dip_reversal_max_sec_since_trough', '90', datetime('now')),
  ('dip_reversal_require_mid_slope', 'true', datetime('now')),
  ('dip_reversal_trailing_activation_pct', '0.5', datetime('now')),
  ('dip_reversal_trailing_callback_pct', '0.3', datetime('now')),
  ('dip_reversal_hard_stop_pct', '2', datetime('now')),
  ('dip_reversal_max_hold_min', '40', datetime('now')),
  ('dip_reversal_post_exit_cooldown_min', '30', datetime('now')),
  -- Boş = rejim kapısı kapalı (DO breadth ölçek uyuşmazlığı 'trend' verir; açık
  -- olsaydı savunma modunda tüm girişleri bloklardı). Giriş saf dip+bounce sinyaline bağlı.
  ('dip_reversal_regime_filter', '', datetime('now'));
