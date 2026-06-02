-- Chop / düşüş savunma modu — mevcut gridler muaf (deploy anı snapshot)
INSERT OR IGNORE INTO bot_config (key, value, updated_at) VALUES
  ('grid_defensive_mode_enabled', 'true', datetime('now')),
  ('grid_defensive_recovery_stop_pct', '1.0', datetime('now')),
  ('grid_defensive_exempt_grid_ids', '[243,255,257,392,394,425]', datetime('now')),
  ('grid_defensive_exempt_initialized', 'true', datetime('now'));
