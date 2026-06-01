-- Son 1 saat (12×5m) üst üste düşüş: watchlist ve aday listesinden çıkar
INSERT OR IGNORE INTO bot_config (key, value) VALUES
  ('grid_readiness_hour_decline_enabled', 'true'),
  ('grid_readiness_hour_decline_bars', '12');

UPDATE bot_config SET value = 'true', updated_at = datetime('now')
WHERE key = 'grid_readiness_hour_decline_enabled';

UPDATE bot_config SET value = '12', updated_at = datetime('now')
WHERE key = 'grid_readiness_hour_decline_bars';
