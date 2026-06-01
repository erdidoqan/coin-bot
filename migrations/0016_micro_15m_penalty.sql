INSERT OR IGNORE INTO bot_config (key, value, updated_at) VALUES
  ('micro_15m_gate_mode', 'penalty', datetime('now')),
  ('micro_15m_penalty', '0.10', datetime('now'));
