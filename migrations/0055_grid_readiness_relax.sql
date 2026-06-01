-- Aday readiness: biraz daha fazla coin hazır (scout ile uyumlu max range)
UPDATE bot_config SET value = '8', updated_at = datetime('now') WHERE key = 'grid_range_pctl';
UPDATE bot_config SET value = '2.0', updated_at = datetime('now') WHERE key = 'grid_min_range_width_pct';
UPDATE bot_config SET value = '18', updated_at = datetime('now') WHERE key = 'grid_max_range_width_pct';
UPDATE bot_config SET value = '0.10', updated_at = datetime('now') WHERE key = 'grid_readiness_max_spread_pct';
UPDATE bot_config SET value = '12', updated_at = datetime('now') WHERE key = 'grid_readiness_max_path_range_ratio';
UPDATE bot_config SET value = '18', updated_at = datetime('now') WHERE key = 'grid_readiness_max_bar_range_path_ratio';
UPDATE bot_config SET value = '28', updated_at = datetime('now') WHERE key = 'grid_readiness_max_stability_range_pct';

INSERT OR IGNORE INTO bot_config (key, value, updated_at) VALUES
  ('grid_readiness_momentum_warn_pct', '3.0', datetime('now'));
