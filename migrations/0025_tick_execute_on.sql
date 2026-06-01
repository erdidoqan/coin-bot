UPDATE bot_config SET value = 'true' WHERE key = 'tick_entry_execute_enabled';
INSERT OR IGNORE INTO bot_config (key, value) VALUES ('tick_entry_execute_enabled', 'true');
