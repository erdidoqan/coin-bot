-- Testere / whipsaw filtresi (yüksek path/range → ALLO tipi grafikler elenir).

INSERT OR IGNORE INTO bot_config (key, value, updated_at) VALUES
  ('grid_readiness_max_path_range_ratio', '10', datetime('now')),
  ('grid_readiness_stability_bars', '288', datetime('now'));
