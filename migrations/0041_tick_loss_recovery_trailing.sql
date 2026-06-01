-- 20. dakikadan sonra zarardaki pozisyonlarda tepeyi takip ederek çıkış
INSERT OR IGNORE INTO bot_config (key, value, updated_at)
VALUES ('tick_loss_recovery_start_minutes', '20', datetime('now'));

INSERT OR IGNORE INTO bot_config (key, value, updated_at)
VALUES ('tick_loss_recovery_retrace_pct', '0.35', datetime('now'));
