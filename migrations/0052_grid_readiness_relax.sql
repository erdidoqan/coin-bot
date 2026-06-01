-- Aday uygunluk: sakin piyasa / ince spread için gevşetme (2026-05)
UPDATE bot_config SET value = '2.5', updated_at = datetime('now') WHERE key = 'grid_min_range_width_pct';
UPDATE bot_config SET value = '10', updated_at = datetime('now') WHERE key = 'grid_readiness_max_path_range_ratio';
UPDATE bot_config SET value = '0.08', updated_at = datetime('now') WHERE key = 'grid_readiness_max_spread_pct';
UPDATE bot_config SET value = '26', updated_at = datetime('now') WHERE key = 'grid_readiness_max_stability_range_pct';
