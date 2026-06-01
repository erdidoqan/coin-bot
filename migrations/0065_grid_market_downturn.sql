-- Piyasa düşüş modu: yeni grid kurulumu + scout zayıf coin filtresi
INSERT OR IGNORE INTO bot_config (key, value) VALUES ('grid_market_downturn_enabled', 'true');
INSERT OR IGNORE INTO bot_config (key, value) VALUES ('grid_market_downturn_breadth_max_pct', '38');
INSERT OR IGNORE INTO bot_config (key, value) VALUES ('grid_market_downturn_btc_24h_pct', '-2.5');
INSERT OR IGNORE INTO bot_config (key, value) VALUES ('grid_market_downturn_btc_15m_return_pct', '-0.8');
INSERT OR IGNORE INTO bot_config (key, value) VALUES ('grid_market_downturn_scout_min_change_pct', '-2');
INSERT OR IGNORE INTO bot_config (key, value) VALUES ('grid_market_downturn_block_panic', 'true');
INSERT OR IGNORE INTO bot_config (key, value) VALUES ('grid_market_downturn_allow_manual', 'false');
