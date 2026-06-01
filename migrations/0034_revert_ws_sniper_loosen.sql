-- 0033 gevşetmesini geri al

UPDATE bot_config SET value = '0.45', updated_at = datetime('now') WHERE key = 'tick_entry_gain_max_pct';
UPDATE bot_config SET value = '0.95', updated_at = datetime('now') WHERE key = 'tick_orderbook_ratio_min';
