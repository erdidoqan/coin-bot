-- Tick size guard: coarse price-step symbols should not enter tick scalping

INSERT OR IGNORE INTO bot_config (key, value, updated_at)
VALUES ('tick_max_tick_size_pct', '0.02', datetime('now'));

UPDATE bot_config
SET value = '0.02',
    updated_at = datetime('now')
WHERE key = 'tick_max_tick_size_pct';
