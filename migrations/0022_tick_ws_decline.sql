-- WS mid geçmişi: önce düşüş, sonra 1m low’dan toparlanma bandı
INSERT OR IGNORE INTO bot_config (key, value) VALUES ('tick_decline_min_pct', '0.08');
INSERT OR IGNORE INTO bot_config (key, value) VALUES ('tick_require_ws_decline', 'true');
