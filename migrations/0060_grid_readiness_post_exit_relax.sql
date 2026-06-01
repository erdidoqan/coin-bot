-- Grid readiness: çıkış sonrası düşüşte gevşetme + genel momentum eşiği
INSERT OR IGNORE INTO bot_config (key, value) VALUES ('grid_readiness_post_exit_relax_enabled', 'true');
INSERT OR IGNORE INTO bot_config (key, value) VALUES ('grid_readiness_post_exit_relax_days', '10');
INSERT OR IGNORE INTO bot_config (key, value) VALUES ('grid_readiness_post_exit_momentum_warn_pct', '7');

UPDATE bot_config SET value = '4.0' WHERE key = 'grid_readiness_momentum_warn_pct';
UPDATE bot_config SET value = '2' WHERE key = 'grid_readiness_downside_bars';
