-- Grid re-center + readiness teardown: yalnız config seed (şema değişikliği yok).
-- lower_price/upper_price mevcut kolonlar; re-center bunları günceller.

INSERT OR IGNORE INTO bot_config (key, value, updated_at) VALUES
  ('grid_recenter_enabled', 'true', datetime('now')),
  ('grid_recenter_drift_pct', '50', datetime('now')),
  ('grid_readiness_teardown_enabled', 'true', datetime('now'));
