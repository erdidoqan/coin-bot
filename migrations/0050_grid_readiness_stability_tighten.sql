-- ALLO tipi: tam 24s bar + sıkı eşikler (mevcut 10 → 8 güncellenir).

INSERT OR IGNORE INTO bot_config (key, value, updated_at) VALUES
  ('grid_readiness_max_bar_range_path_ratio', '14', datetime('now')),
  ('grid_readiness_max_stability_range_pct', '22', datetime('now'));

UPDATE bot_config SET value = '8', updated_at = datetime('now')
  WHERE key = 'grid_readiness_max_path_range_ratio' AND value IN ('10', '');
