INSERT OR IGNORE INTO bot_config (key, value) VALUES ('grid_market_downturn_force_active', 'false');
UPDATE bot_config SET value = 'true' WHERE key = 'grid_market_downturn_force_active';
