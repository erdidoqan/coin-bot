-- Strateji router: günlük trend (lagging) → intraday çoklu-pencere (15/30/60dk).
-- Yeni ATR-ölçekli eşik çarpanları. daily_trend_lookback artık kullanılmıyor (bırakıldı).
INSERT OR IGNORE INTO bot_config (key, value, updated_at) VALUES
  ('strategy_router_kill_atr_mult', '1.0', datetime('now')),
  ('strategy_router_momentum_atr_mult', '0.4', datetime('now')),
  ('strategy_router_recover_atr_mult', '0.3', datetime('now'));
-- Mevcut eşikleri intraday'e göre güncelle (önceki değerler makro içindi).
UPDATE bot_config SET value='50', updated_at=datetime('now')
  WHERE key='strategy_router_momentum_breadth_min' AND value='55';
UPDATE bot_config SET value='20', updated_at=datetime('now')
  WHERE key='strategy_router_dip_breadth_min' AND value='25';
UPDATE bot_config SET value='0.8', updated_at=datetime('now')
  WHERE key='strategy_router_volatile_atr_min' AND value='1.0';
