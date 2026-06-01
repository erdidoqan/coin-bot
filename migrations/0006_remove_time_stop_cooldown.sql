DELETE FROM bot_config WHERE key IN (
  'time_stop_minutes',
  'time_stop_band_pct',
  'cooldown_minutes'
);
DROP TABLE IF EXISTS symbol_cooldown;
ALTER TABLE bot_state DROP COLUMN position_opened_at;
