-- Çift kademeli trailing: aktivasyon % + dar takip %
INSERT OR IGNORE INTO bot_config (key, value)
  SELECT 'trailing_activation_pct', value FROM bot_config WHERE key = 'trailing_callback_rate';
INSERT OR IGNORE INTO bot_config (key, value) VALUES ('trailing_tight_callback_pct', '0.5');
