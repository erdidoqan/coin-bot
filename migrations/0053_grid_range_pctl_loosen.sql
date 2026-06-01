-- price_in_range: daha geniş kabul bandı (p15–p85 → p10–p90)
UPDATE bot_config SET value = '10', updated_at = datetime('now') WHERE key = 'grid_range_pctl';
