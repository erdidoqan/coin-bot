-- Tick scalp stop-loss oranını gevşet: %0.40

UPDATE bot_config
SET value = '0.40',
    updated_at = datetime('now')
WHERE key = 'tick_stop_loss_pct';

INSERT OR IGNORE INTO bot_config (key, value, updated_at)
VALUES ('tick_stop_loss_pct', '0.40', datetime('now'));
