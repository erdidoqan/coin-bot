UPDATE bot_config SET value = '0.06', updated_at = datetime('now') WHERE key = 'tick_entry_gain_max_pct';
INSERT OR IGNORE INTO bot_config (key, value) VALUES ('tick_entry_gain_max_pct', '0.06');
