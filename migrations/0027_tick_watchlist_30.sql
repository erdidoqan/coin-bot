-- Tick scalp gözcü: 30 sembol, mikro evren yerine gevşek tick filtreleri (scout.ts pickTickWatchlist)
UPDATE bot_config SET value = '30', updated_at = datetime('now') WHERE key = 'watchlist_size';
