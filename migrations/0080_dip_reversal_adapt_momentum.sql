-- Dip Reversal Adapt v2 — volatilite-ölçekli dinamik filtre + kademeli/shadow.
-- #1 momentum breadth (shadow), #3 BTC trend momentum (shadow), #2 akıllı exit (canlı).
-- Sadece çarpanlar + flag'ler sabit; eşik sayıları runtime'da ATR'den türetilir.
INSERT OR IGNORE INTO bot_config (key, value, updated_at) VALUES
  -- #1 momentum breadth (default shadow: karar hâlâ 24h)
  ('dip_reversal_adapt_breadth_basis', '24h', datetime('now')),
  ('dip_reversal_adapt_momentum_breadth_interval', '5m', datetime('now')),
  ('dip_reversal_adapt_momentum_breadth_atr_mult', '0.5', datetime('now')),
  -- #3 BTC trend momentum override (default shadow: karar hâlâ EMA)
  ('dip_reversal_adapt_btc_momentum_enabled', 'false', datetime('now')),
  ('dip_reversal_adapt_btc_momentum_atr_mult', '1.0', datetime('now')),
  -- #2 akıllı exit (default canlı)
  ('dip_reversal_adapt_smart_exit_enabled', 'true', datetime('now')),
  ('dip_reversal_adapt_exit_momentum_atr_mult', '0.5', datetime('now'));
