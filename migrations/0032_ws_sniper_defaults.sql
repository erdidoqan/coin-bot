-- WebSocket sniper: komisyon-uyumlu giriş bandı ve recovery eşikleri

UPDATE bot_config SET value = '0.15', updated_at = datetime('now') WHERE key = 'tick_entry_gain_pct';
UPDATE bot_config SET value = '0.45', updated_at = datetime('now') WHERE key = 'tick_entry_gain_max_pct';
UPDATE bot_config SET value = '0.10', updated_at = datetime('now') WHERE key = 'tick_recovery_min_pct';
UPDATE bot_config SET value = '0.15', updated_at = datetime('now') WHERE key = 'scalp_fee_roundtrip_pct';

INSERT OR IGNORE INTO bot_config (key, value, updated_at) VALUES
  ('tick_entry_gain_pct', '0.15', datetime('now')),
  ('tick_entry_gain_max_pct', '0.45', datetime('now')),
  ('tick_recovery_min_pct', '0.10', datetime('now')),
  ('tick_recovery_fee_margin_pct', '0.05', datetime('now')),
  ('scalp_fee_roundtrip_pct', '0.15', datetime('now'));
