-- Aday readiness: daha seçici kapılar (daha az "Hazır")
UPDATE bot_config SET value = '0.25', updated_at = datetime('now')
WHERE key = 'grid_max_efficiency_ratio';

UPDATE bot_config SET value = '3.0', updated_at = datetime('now')
WHERE key = 'grid_min_range_width_pct';

UPDATE bot_config SET value = '0.25', updated_at = datetime('now')
WHERE key = 'grid_min_atr_pct';

UPDATE bot_config SET value = '3.0', updated_at = datetime('now')
WHERE key = 'grid_readiness_momentum_warn_pct';
