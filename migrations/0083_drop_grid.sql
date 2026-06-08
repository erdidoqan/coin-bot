-- Grid sistemi tamamen kaldırıldı (Dip Reversal + router ile devam).
-- Tablolar ve grid_* config key'leri DROP/DELETE. Eski grid migration'ları geçmiş kayıt olarak kalır.
DROP TABLE IF EXISTS grid_orders;
DROP TABLE IF EXISTS grid_state;
DELETE FROM bot_config WHERE key LIKE 'grid_%';
