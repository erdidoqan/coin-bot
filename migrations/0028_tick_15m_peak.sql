-- Tick tepe filtresi: 5m → 15m (open→high)
INSERT OR IGNORE INTO bot_config (key, value, updated_at)
SELECT 'tick_15m_min_gain_pct', value, datetime('now') FROM bot_config WHERE key = 'tick_5m_min_gain_pct';

INSERT OR IGNORE INTO bot_config (key, value, updated_at)
SELECT 'tick_require_15m_min_gain', value, datetime('now') FROM bot_config WHERE key = 'tick_require_5m_min_gain';
