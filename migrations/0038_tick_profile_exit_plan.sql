-- Tick profile-based exits: A/B/C entry quality, fail-fast, and step-lock controls

INSERT OR IGNORE INTO bot_config (key, value, updated_at) VALUES
  ('tick_profile_a_max_spread_pct', '0.020', datetime('now')),
  ('tick_profile_a_max_scout_vs_fill_pct', '0.00', datetime('now')),
  ('tick_profile_a_min_gain_pct', '0.08', datetime('now')),
  ('tick_profile_a_max_gain_pct', '0.20', datetime('now')),
  ('tick_profile_a_min_sec_since_trough', '40', datetime('now')),
  ('tick_profile_a_max_sec_since_trough', '60', datetime('now')),
  ('tick_profile_b_max_spread_pct', '0.030', datetime('now')),
  ('tick_profile_b_max_scout_vs_fill_pct', '0.10', datetime('now')),
  ('tick_profile_a_tp_pct', '0.50', datetime('now')),
  ('tick_profile_b_tp_pct', '0.35', datetime('now')),
  ('tick_profile_c_tp_pct', '0.22', datetime('now')),
  ('tick_profile_a_max_hold_minutes', '30', datetime('now')),
  ('tick_profile_b_max_hold_minutes', '20', datetime('now')),
  ('tick_profile_c_max_hold_minutes', '12', datetime('now')),
  ('tick_fail_fast_enabled', 'true', datetime('now')),
  ('tick_fail_fast_window_sec', '20', datetime('now')),
  ('tick_fail_fast_min_favorable_pct', '0.06', datetime('now')),
  ('tick_fail_fast_max_adverse_pct', '0.12', datetime('now')),
  ('tick_step_lock_enabled', 'true', datetime('now')),
  ('tick_step_lock_1_trigger_pct', '0.15', datetime('now')),
  ('tick_step_lock_1_lock_pct', '0.00', datetime('now')),
  ('tick_step_lock_2_trigger_pct', '0.25', datetime('now')),
  ('tick_step_lock_2_lock_pct', '0.08', datetime('now'));

UPDATE bot_config SET value = '0.020', updated_at = datetime('now')
WHERE key = 'tick_profile_a_max_spread_pct';
UPDATE bot_config SET value = '0.00', updated_at = datetime('now')
WHERE key = 'tick_profile_a_max_scout_vs_fill_pct';
UPDATE bot_config SET value = '0.08', updated_at = datetime('now')
WHERE key = 'tick_profile_a_min_gain_pct';
UPDATE bot_config SET value = '0.20', updated_at = datetime('now')
WHERE key = 'tick_profile_a_max_gain_pct';
UPDATE bot_config SET value = '40', updated_at = datetime('now')
WHERE key = 'tick_profile_a_min_sec_since_trough';
UPDATE bot_config SET value = '60', updated_at = datetime('now')
WHERE key = 'tick_profile_a_max_sec_since_trough';
UPDATE bot_config SET value = '0.030', updated_at = datetime('now')
WHERE key = 'tick_profile_b_max_spread_pct';
UPDATE bot_config SET value = '0.10', updated_at = datetime('now')
WHERE key = 'tick_profile_b_max_scout_vs_fill_pct';
UPDATE bot_config SET value = '0.50', updated_at = datetime('now')
WHERE key = 'tick_profile_a_tp_pct';
UPDATE bot_config SET value = '0.35', updated_at = datetime('now')
WHERE key = 'tick_profile_b_tp_pct';
UPDATE bot_config SET value = '0.22', updated_at = datetime('now')
WHERE key = 'tick_profile_c_tp_pct';
UPDATE bot_config SET value = '30', updated_at = datetime('now')
WHERE key = 'tick_profile_a_max_hold_minutes';
UPDATE bot_config SET value = '20', updated_at = datetime('now')
WHERE key = 'tick_profile_b_max_hold_minutes';
UPDATE bot_config SET value = '12', updated_at = datetime('now')
WHERE key = 'tick_profile_c_max_hold_minutes';
UPDATE bot_config SET value = 'true', updated_at = datetime('now')
WHERE key = 'tick_fail_fast_enabled';
UPDATE bot_config SET value = '20', updated_at = datetime('now')
WHERE key = 'tick_fail_fast_window_sec';
UPDATE bot_config SET value = '0.06', updated_at = datetime('now')
WHERE key = 'tick_fail_fast_min_favorable_pct';
UPDATE bot_config SET value = '0.12', updated_at = datetime('now')
WHERE key = 'tick_fail_fast_max_adverse_pct';
UPDATE bot_config SET value = 'true', updated_at = datetime('now')
WHERE key = 'tick_step_lock_enabled';
UPDATE bot_config SET value = '0.15', updated_at = datetime('now')
WHERE key = 'tick_step_lock_1_trigger_pct';
UPDATE bot_config SET value = '0.00', updated_at = datetime('now')
WHERE key = 'tick_step_lock_1_lock_pct';
UPDATE bot_config SET value = '0.25', updated_at = datetime('now')
WHERE key = 'tick_step_lock_2_trigger_pct';
UPDATE bot_config SET value = '0.08', updated_at = datetime('now')
WHERE key = 'tick_step_lock_2_lock_pct';
