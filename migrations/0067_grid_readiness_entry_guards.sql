-- Readiness: üst band girişi, orta vadeli düşüş, floor/stop sonrası bekleme
INSERT OR IGNORE INTO bot_config (key, value) VALUES
  ('grid_readiness_max_entry_band_pct', '65'),
  ('grid_readiness_medium_return_bars', '36'),
  ('grid_readiness_medium_return_warn_pct', '2.5'),
  ('grid_readiness_post_exit_cooldown_enabled', 'true'),
  ('grid_readiness_post_exit_cooldown_min', '45');

UPDATE bot_config SET value = '65', updated_at = datetime('now')
WHERE key = 'grid_readiness_max_entry_band_pct';

UPDATE bot_config SET value = '36', updated_at = datetime('now')
WHERE key = 'grid_readiness_medium_return_bars';

UPDATE bot_config SET value = '2.5', updated_at = datetime('now')
WHERE key = 'grid_readiness_medium_return_warn_pct';

UPDATE bot_config SET value = 'true', updated_at = datetime('now')
WHERE key = 'grid_readiness_post_exit_cooldown_enabled';

UPDATE bot_config SET value = '45', updated_at = datetime('now')
WHERE key = 'grid_readiness_post_exit_cooldown_min';

-- Floor churn: çıkış sonrası gevşetme kapalı (cooldown ile birlikte)
UPDATE bot_config SET value = 'false', updated_at = datetime('now')
WHERE key = 'grid_readiness_post_exit_relax_enabled';
