-- Gözcü: 1h tepe filtresi; tick girişte 15m tepe kontrolü kapalı
INSERT OR IGNORE INTO bot_config (key, value, updated_at) VALUES
  ('scout_1h_min_peak_pct', '0.5', datetime('now')),
  ('scout_require_1h_peak', 'true', datetime('now'));

UPDATE bot_config SET value = 'false', updated_at = datetime('now') WHERE key = 'tick_require_15m_min_gain';
