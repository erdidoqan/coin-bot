-- Üst üste kırmızı 5m mum eşiği: 3 (0060'da 2'ye inmişti)
UPDATE bot_config SET value = '3', updated_at = datetime('now')
WHERE key = 'grid_readiness_downside_bars';
