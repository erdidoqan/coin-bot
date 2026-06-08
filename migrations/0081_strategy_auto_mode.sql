-- Rejim-bazlı otomatik strateji router. Master flag + eşikler.
-- auto_mode=false iken mevcut davranış birebir korunur (router baypas).
INSERT OR IGNORE INTO bot_config (key, value, updated_at) VALUES
  ('strategy_auto_mode', 'false', datetime('now')),
  ('strategy_router_momentum_breadth_min', '55', datetime('now')),
  ('strategy_router_dip_breadth_min', '25', datetime('now')),
  ('strategy_router_volatile_atr_min', '1.0', datetime('now')),
  ('strategy_router_daily_trend_lookback_days', '7', datetime('now'));
