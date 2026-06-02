-- Kısa düşüş eşiği %2; sürekli düşüş 8×5m (~40 dk)
UPDATE bot_config SET value = '2.0', updated_at = datetime('now') WHERE key = 'grid_readiness_momentum_warn_pct';
UPDATE bot_config SET value = '8', updated_at = datetime('now') WHERE key = 'grid_readiness_hour_decline_bars';
