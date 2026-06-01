-- Flash Drop Guard: config + anchor_price (kurulum referans fiyatı).

ALTER TABLE grid_state ADD COLUMN anchor_price TEXT;

INSERT OR IGNORE INTO bot_config (key, value, updated_at) VALUES
  ('grid_flash_drop_enabled', 'true', datetime('now')),
  ('grid_flash_drop_warn_pct', '2.0', datetime('now')),
  ('grid_flash_drop_pause_pct', '3.0', datetime('now')),
  ('grid_flash_drop_recovery_pct', '5.0', datetime('now')),
  ('grid_flash_drop_window_min', '15', datetime('now')),
  ('grid_flash_drop_max_fills', '3', datetime('now')),
  ('grid_flash_drop_fill_window_min', '10', datetime('now')),
  ('grid_flash_drop_overfill_mult', '1.5', datetime('now')),
  ('grid_flash_drop_scout_block_panic', 'true', datetime('now')),
  ('grid_flash_drop_symbol_cooldown_min', '60', datetime('now'));
