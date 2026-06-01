-- Daha geniş evren (50M → 20M USDT 24h hacim); rejim chop yalnızca breadth ile

UPDATE bot_config SET value = '20000000', updated_at = datetime('now')
WHERE key = 'micro_min_quote_volume_usdt';
