import { WATCHLIST_SIZE_DEFAULT } from '../config/filters';

export type BotConfigKey =
  | 'hard_stop_loss_pct'
  | 'stable_max_volatility_pct'
  | 'buy_quote_usdt'
  | 'pullback_tolerance_pct'
  | 'trailing_activation_pct'
  | 'trailing_tight_callback_pct'
  | 'rotation_window_minutes'
  | 'rotation_min_improvement_pct'
  | 'hybrid_enabled'
  | 'scalp_take_profit_gross_pct'
  | 'scalp_fee_roundtrip_pct'
  | 'scalp_max_hold_minutes'
  | 'scalp_hard_stop_loss_pct'
  | 'momentum_min_window_gain_pct'
  | 'momentum_require_all_windows'
  | 'momentum_max_daily_change_pct'
  | 'momentum_min_green_windows'
  | 'momentum_max_pullback_pct'
  | 'momentum_require_short_tf'
  | 'scout_max_15m_pump_pct'
  | 'watchlist_size'
  | 'momentum_switch_enabled'
  | 'momentum_switch_min_score_pct'
  | 'momentum_switch_min_minutes'
  | 'momentum_scan_cursor'
  | 'micro_scalp_enabled'
  | 'micro_universe_size'
  | 'micro_min_quote_volume_usdt'
  | 'micro_max_spread_pct'
  | 'micro_min_15m_move_pct'
  | 'micro_entry_min_score'
  | 'micro_exit_score_floor'
  | 'micro_scan_batch_size'
  | 'micro_scan_cursor'
  | 'micro_min_net_tp_pct'
  | 'micro_volume_ratio_min'
  | 'micro_orderbook_ratio_min'
  | 'micro_phase2_enabled'
  | 'micro_phase3_enabled'
  | 'micro_aggression_min'
  | 'micro_ob_persistence_seconds'
  | 'max_open_scalp_positions'
  | 'micro_shadow_enabled'
  | 'micro_shadow_min_score'
  | 'micro_shadow_dedupe_minutes'
  | 'micro_shadow_horizons_min'
  | 'micro_15m_gate_mode'
  | 'micro_15m_penalty'
  | 'tick_scalp_enabled'
  | 'tick_entry_gain_pct'
  | 'tick_entry_gain_max_pct'
  | 'tick_max_open_positions'
  | 'tick_max_hold_only_if_profitable'
  | 'tick_loss_recovery_start_minutes'
  | 'tick_loss_recovery_retrace_pct'
  | 'tick_take_profit_pct'
  | 'tick_stop_loss_pct'
  | 'tick_max_tick_size_pct'
  | 'tick_reference_window_sec'
  | 'tick_orderbook_ratio_min'
  | 'tick_max_spread_pct'
  | 'tick_require_5m_alignment'
  | 'tick_decline_min_pct'
  | 'tick_require_ws_decline'
  | 'tick_5m_min_gain_pct'
  | 'tick_require_5m_min_gain'
  | 'tick_15m_min_gain_pct'
  | 'tick_require_15m_min_gain'
  | 'scout_1h_min_peak_pct'
  | 'scout_require_1h_peak'
  | 'tick_major_only'
  | 'tick_major_symbols'
  | 'tick_use_limit_maker'
  | 'tick_limit_buy_offset_pct'
  | 'tick_entry_order_ttl_sec'
  | 'tick_stop_limit_buffer_pct'
  | 'tick_entry_execute_enabled'
  | 'tick_recovery_min_pct'
  | 'tick_recovery_fee_margin_pct'
  | 'tick_min_sec_after_trough'
  | 'tick_max_sec_after_trough'
  | 'tick_scout_max_below_pct'
  | 'tick_scout_max_above_pct'
  | 'tick_require_5m_light'
  | 'tick_require_spread_tightening'
  | 'tick_ob_ratio_at_recovery_min'
  | 'tick_reversal_score_enabled'
  | 'tick_mid_slope_sample_count'
  | 'tick_mid_slope_min_rising'
  | 'tick_no_new_low_sec'
  | 'tick_agg_burst_enabled'
  | 'tick_agg_window_sec'
  | 'tick_agg_buy_count_min'
  | 'tick_agg_buy_quote_min_usdt'
  | 'tick_agg_imbalance_min'
  | 'tick_profile_a_max_spread_pct'
  | 'tick_profile_a_max_scout_vs_fill_pct'
  | 'tick_profile_a_min_gain_pct'
  | 'tick_profile_a_max_gain_pct'
  | 'tick_profile_a_min_sec_since_trough'
  | 'tick_profile_a_max_sec_since_trough'
  | 'tick_profile_b_max_spread_pct'
  | 'tick_profile_b_max_scout_vs_fill_pct'
  | 'tick_profile_a_tp_pct'
  | 'tick_profile_b_tp_pct'
  | 'tick_profile_c_tp_pct'
  | 'tick_profile_a_max_hold_minutes'
  | 'tick_profile_b_max_hold_minutes'
  | 'tick_profile_c_max_hold_minutes'
  | 'tick_fail_fast_enabled'
  | 'tick_fail_fast_window_sec'
  | 'tick_fail_fast_min_favorable_pct'
  | 'tick_fail_fast_max_adverse_pct'
  | 'tick_step_lock_enabled'
  | 'tick_step_lock_1_trigger_pct'
  | 'tick_step_lock_1_lock_pct'
  | 'tick_step_lock_2_trigger_pct'
  | 'tick_step_lock_2_lock_pct'
  | 'tick_shadow_enabled'
  | 'tick_shadow_horizon_sec'
  | 'tick_shadow_dedupe_minutes'
  // --- Spot Grid (yeni strateji) ---
  | 'grid_enabled'
  | 'live_gate'
  | 'grid_symbol'
  | 'grid_range_mode'
  | 'grid_range_lookback_days'
  | 'grid_range_pctl'
  | 'grid_lower_price'
  | 'grid_upper_price'
  | 'grid_count'
  | 'grid_investment_usdt'
  | 'grid_fee_roundtrip_pct'
  | 'grid_fee_wall_multiple'
  | 'grid_stop_below_pct'
  | 'grid_recovery_margin_pct'
  | 'grid_stop_above_pct'
  | 'grid_range_reset_enabled'
  | 'grid_recenter_enabled'
  | 'grid_recenter_drift_pct'
  | 'grid_readiness_teardown_enabled'
  | 'grid_buy_guard_enabled'
  | 'grid_buy_cancel_open_on_not_ready'
  | 'grid_buy_block_new_on_not_ready'
  | 'grid_buy_cancel_anchor_drawdown_pct'
  | 'grid_buy_log_assessment'
  | 'grid_teardown_on_readiness_blockers'
  | 'grid_teardown_readiness_blockers'
  | 'grid_recenter_requires_ready'
  | 'grid_max_inventory_usdt'
  | 'grid_flash_drop_enabled'
  | 'grid_flash_drop_warn_pct'
  | 'grid_flash_drop_pause_pct'
  | 'grid_flash_drop_recovery_pct'
  | 'grid_flash_drop_window_min'
  | 'grid_flash_drop_max_fills'
  | 'grid_flash_drop_fill_window_min'
  | 'grid_flash_drop_overfill_mult'
  | 'grid_flash_drop_scout_block_panic'
  | 'grid_flash_drop_symbol_cooldown_min'
  | 'grid_readiness_downside_bars'
  | 'grid_readiness_short_return_bars'
  | 'grid_readiness_momentum_warn_pct'
  | 'grid_readiness_post_exit_relax_enabled'
  | 'grid_readiness_post_exit_relax_days'
  | 'grid_readiness_post_exit_momentum_warn_pct'
  | 'grid_readiness_max_entry_band_pct'
  | 'grid_readiness_medium_return_bars'
  | 'grid_readiness_medium_return_warn_pct'
  | 'grid_readiness_post_exit_cooldown_enabled'
  | 'grid_readiness_post_exit_cooldown_min'
  | 'grid_readiness_hour_decline_enabled'
  | 'grid_readiness_hour_decline_bars'
  | 'grid_allow_new_grid_while_recovering'
  | 'grid_readiness_max_path_range_ratio'
  | 'grid_readiness_max_bar_range_path_ratio'
  | 'grid_readiness_max_stability_range_pct'
  | 'grid_readiness_stability_bars'
  | 'grid_scout_risk_filter_enabled'
  | 'grid_scout_max_abs_change_pct'
  | 'grid_scout_pool_multiplier'
  // Grid readiness (körü körüne girme — ranging/uygunluk gate'leri)
  | 'grid_use_watchlist'
  | 'grid_candidate_count'
  | 'grid_max_efficiency_ratio'
  | 'grid_min_range_width_pct'
  | 'grid_max_range_width_pct'
  | 'grid_min_atr_pct'
  | 'grid_readiness_max_spread_pct'
  | 'grid_readiness_lookback'
  | 'grid_exclude_symbols'
  | 'grid_max_concurrent'
  | 'grid_max_consecutive_buys'
  | 'grid_ladder_mode'
  | 'grid_floor_exit_margin_pct'
  | 'grid_dip_buy_defer_steps'
  | 'grid_market_downturn_enabled'
  | 'grid_market_downturn_breadth_max_pct'
  | 'grid_market_downturn_btc_24h_pct'
  | 'grid_market_downturn_btc_15m_return_pct'
  | 'grid_market_downturn_scout_min_change_pct'
  | 'grid_market_downturn_block_panic'
  | 'grid_market_downturn_allow_manual'
  | 'grid_market_downturn_force_active'
  | 'grid_defensive_mode_enabled'
  | 'grid_recovery_ladder_auto_enabled'
  | 'grid_defensive_recovery_stop_pct'
  | 'grid_defensive_exempt_grid_ids'
  | 'grid_defensive_exempt_initialized'
  | 'grid_setup_market_entry'
  | 'grid_run_lock'

const ENV_FALLBACK: Partial<Record<BotConfigKey, keyof Env>> = {
  hard_stop_loss_pct: 'HARD_STOP_LOSS_PCT',
  stable_max_volatility_pct: 'STABLE_MAX_VOLATILITY_PCT',
  buy_quote_usdt: 'BUY_QUOTE_USDT',
  pullback_tolerance_pct: 'PULLBACK_TOLERANCE_PCT',
  trailing_activation_pct: 'TRAILING_ACTIVATION_PCT',
  trailing_tight_callback_pct: 'TRAILING_TIGHT_CALLBACK_PCT',
};

const DEFAULTS: Record<BotConfigKey, string> = {
  hard_stop_loss_pct: '4',
  stable_max_volatility_pct: '0.1',
  buy_quote_usdt: '175',
  pullback_tolerance_pct: '0.5',
  trailing_activation_pct: '1.5',
  trailing_tight_callback_pct: '0.5',
  rotation_window_minutes: '15',
  rotation_min_improvement_pct: '0.2',
  hybrid_enabled: 'false',
  tick_scalp_enabled: 'true',
  micro_scalp_enabled: 'false',
  tick_entry_gain_pct: '0.08',
  tick_entry_gain_max_pct: '0.80',
  tick_max_open_positions: '2',
  tick_max_hold_only_if_profitable: 'true',
  tick_loss_recovery_start_minutes: '20',
  tick_loss_recovery_retrace_pct: '0.35',
  tick_take_profit_pct: '0.50',
  tick_stop_loss_pct: '0.40',
  tick_max_tick_size_pct: '0.02',
  tick_reference_window_sec: '120',
  tick_orderbook_ratio_min: '0.20',
  tick_max_spread_pct: '0.03',
  tick_require_5m_alignment: 'false',
  tick_decline_min_pct: '0.08',
  tick_require_ws_decline: 'true',
  tick_5m_min_gain_pct: '0.5',
  tick_require_5m_min_gain: 'true',
  tick_15m_min_gain_pct: '0.5',
  tick_require_15m_min_gain: 'false',
  scout_1h_min_peak_pct: '0.5',
  scout_require_1h_peak: 'true',
  tick_major_only: 'true',
  tick_major_symbols: 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT',
  tick_use_limit_maker: 'true',
  tick_limit_buy_offset_pct: '0.05',
  tick_entry_order_ttl_sec: '8',
  tick_stop_limit_buffer_pct: '0.05',
  tick_entry_execute_enabled: 'true',
  tick_recovery_min_pct: '0.10',
  tick_recovery_fee_margin_pct: '0.00',
  tick_min_sec_after_trough: '3',
  tick_max_sec_after_trough: '60',
  tick_scout_max_below_pct: '1.0',
  tick_scout_max_above_pct: '1.5',
  tick_require_5m_light: 'true',
  tick_require_spread_tightening: 'true',
  tick_ob_ratio_at_recovery_min: '1.0',
  tick_reversal_score_enabled: 'true',
  tick_mid_slope_sample_count: '5',
  tick_mid_slope_min_rising: '3',
  tick_no_new_low_sec: '30',
  tick_agg_burst_enabled: 'true',
  tick_agg_window_sec: '10',
  tick_agg_buy_count_min: '4',
  tick_agg_buy_quote_min_usdt: '1000',
  tick_agg_imbalance_min: '0.05',
  tick_profile_a_max_spread_pct: '0.020',
  tick_profile_a_max_scout_vs_fill_pct: '0.00',
  tick_profile_a_min_gain_pct: '0.08',
  tick_profile_a_max_gain_pct: '0.20',
  tick_profile_a_min_sec_since_trough: '40',
  tick_profile_a_max_sec_since_trough: '60',
  tick_profile_b_max_spread_pct: '0.030',
  tick_profile_b_max_scout_vs_fill_pct: '0.10',
  tick_profile_a_tp_pct: '0.50',
  tick_profile_b_tp_pct: '0.35',
  tick_profile_c_tp_pct: '0.22',
  tick_profile_a_max_hold_minutes: '30',
  tick_profile_b_max_hold_minutes: '20',
  tick_profile_c_max_hold_minutes: '12',
  tick_fail_fast_enabled: 'true',
  tick_fail_fast_window_sec: '20',
  tick_fail_fast_min_favorable_pct: '0.06',
  tick_fail_fast_max_adverse_pct: '0.12',
  tick_step_lock_enabled: 'true',
  tick_step_lock_1_trigger_pct: '0.15',
  tick_step_lock_1_lock_pct: '0.00',
  tick_step_lock_2_trigger_pct: '0.25',
  tick_step_lock_2_lock_pct: '0.08',
  tick_shadow_enabled: 'true',
  tick_shadow_horizon_sec: '60',
  tick_shadow_dedupe_minutes: '5',
  micro_universe_size: '80',
  micro_min_quote_volume_usdt: '20000000',
  micro_max_spread_pct: '0.08',
  micro_min_15m_move_pct: '0.15',
  micro_entry_min_score: '0.75',
  micro_exit_score_floor: '0.35',
  micro_scan_batch_size: '8',
  micro_scan_cursor: '0',
  micro_min_net_tp_pct: '0.25',
  micro_volume_ratio_min: '2.2',
  micro_orderbook_ratio_min: '1.4',
  micro_phase2_enabled: 'true',
  micro_phase3_enabled: 'true',
  micro_aggression_min: '0.65',
  micro_ob_persistence_seconds: '5',
  max_open_scalp_positions: '1',
  scalp_max_hold_minutes: '15',
  momentum_min_window_gain_pct: '0.1',
  momentum_require_all_windows: 'true',
  momentum_max_daily_change_pct: '8',
  momentum_min_green_windows: '4',
  momentum_max_pullback_pct: '0.15',
  momentum_require_short_tf: 'true',
  scout_max_15m_pump_pct: '2.5',
  watchlist_size: '30',
  momentum_switch_enabled: 'false',
  momentum_switch_min_score_pct: '0.15',
  momentum_switch_min_minutes: '5',
  scalp_take_profit_gross_pct: '0.7',
  scalp_hard_stop_loss_pct: '0.3',
  scalp_fee_roundtrip_pct: '0.20',
  momentum_scan_cursor: '0',
  micro_shadow_enabled: 'true',
  micro_shadow_min_score: '0.35',
  micro_shadow_dedupe_minutes: '10',
  micro_shadow_horizons_min: '5,15,30',
  micro_15m_gate_mode: 'penalty',
  micro_15m_penalty: '0.10',
  // --- Spot Grid ---
  grid_enabled: 'false',
  live_gate: 'false',
  grid_symbol: 'BNBUSDT',
  grid_range_mode: 'auto',
  grid_range_lookback_days: '7',
  grid_range_pctl: '8',
  grid_lower_price: '0',
  grid_upper_price: '0',
  grid_count: '20',
  grid_investment_usdt: '200',
  grid_fee_roundtrip_pct: '0.15',
  grid_fee_wall_multiple: '2',
  grid_stop_below_pct: '2.0',
  grid_recovery_margin_pct: '0.3',
  grid_stop_above_pct: '2.0',
  grid_range_reset_enabled: 'true',
  grid_recenter_enabled: 'true',
  grid_recenter_drift_pct: '50',
  grid_readiness_teardown_enabled: 'true',
  grid_buy_guard_enabled: 'true',
  grid_buy_cancel_open_on_not_ready: 'true',
  grid_buy_block_new_on_not_ready: 'true',
  grid_buy_cancel_anchor_drawdown_pct: '1.0',
  grid_buy_log_assessment: 'true',
  grid_teardown_on_readiness_blockers: 'true',
  grid_teardown_readiness_blockers: 'downside_momentum,hour_decline,flash_drop',
  grid_recenter_requires_ready: 'true',
  grid_max_inventory_usdt: '300',
  grid_flash_drop_enabled: 'true',
  grid_flash_drop_warn_pct: '2.0',
  grid_flash_drop_pause_pct: '3.0',
  grid_flash_drop_recovery_pct: '5.0',
  grid_flash_drop_window_min: '15',
  grid_flash_drop_max_fills: '3',
  grid_flash_drop_fill_window_min: '10',
  grid_flash_drop_overfill_mult: '1.5',
  grid_flash_drop_scout_block_panic: 'true',
  grid_flash_drop_symbol_cooldown_min: '60',
  grid_readiness_downside_bars: '3',
  grid_readiness_short_return_bars: '3',
  grid_readiness_momentum_warn_pct: '2.0',
  grid_readiness_post_exit_relax_enabled: 'false',
  grid_readiness_post_exit_relax_days: '10',
  grid_readiness_post_exit_momentum_warn_pct: '7',
  grid_readiness_max_entry_band_pct: '65',
  grid_readiness_medium_return_bars: '36',
  grid_readiness_medium_return_warn_pct: '2.5',
  grid_readiness_post_exit_cooldown_enabled: 'true',
  grid_readiness_post_exit_cooldown_min: '45',
  grid_readiness_hour_decline_enabled: 'true',
  grid_readiness_hour_decline_bars: '8',
  grid_readiness_max_path_range_ratio: '12',
  grid_readiness_max_bar_range_path_ratio: '18',
  grid_readiness_max_stability_range_pct: '28',
  grid_readiness_stability_bars: '288',
  grid_scout_risk_filter_enabled: 'true',
  grid_scout_max_abs_change_pct: '12',
  grid_scout_pool_multiplier: '4',
  grid_use_watchlist: 'true',
  grid_candidate_count: '15',
  grid_max_efficiency_ratio: '0.25',
  grid_min_range_width_pct: '3.0',
  grid_max_range_width_pct: '18',
  grid_min_atr_pct: '0.25',
  grid_readiness_max_spread_pct: '0.10',
  grid_allow_new_grid_while_recovering: 'true',
  grid_readiness_lookback: '96',
  grid_exclude_symbols: 'BNBUSDT',
  grid_max_concurrent: '3',
  grid_max_consecutive_buys: '2',
  grid_ladder_mode: 'breakeven_dip',
  grid_floor_exit_margin_pct: '0.5',
  grid_dip_buy_defer_steps: '1',
  grid_market_downturn_enabled: 'false',
  grid_market_downturn_breadth_max_pct: '38',
  grid_market_downturn_btc_24h_pct: '-2.5',
  grid_market_downturn_btc_15m_return_pct: '-0.8',
  grid_market_downturn_scout_min_change_pct: '-2',
  grid_market_downturn_block_panic: 'true',
  grid_market_downturn_allow_manual: 'false',
  grid_market_downturn_force_active: 'false',
  grid_defensive_mode_enabled: 'true',
  grid_recovery_ladder_auto_enabled: 'true',
  grid_defensive_recovery_stop_pct: '1.0',
  grid_defensive_exempt_grid_ids: '[]',
  grid_defensive_exempt_initialized: 'false',
  grid_setup_market_entry: 'false',
  grid_run_lock: '0',
};

export async function getConfig(
  db: D1Database,
  key: BotConfigKey,
  env: Env,
): Promise<string> {
  const row = await db
    .prepare('SELECT value FROM bot_config WHERE key = ?')
    .bind(key)
    .first<{ value: string }>();

  if (row?.value) return row.value;

  const envKey = ENV_FALLBACK[key];
  if (envKey) {
    const fromEnv = env[envKey];
    if (fromEnv !== undefined) return String(fromEnv);
  }

  return DEFAULTS[key];
}

export async function isHybridEnabled(db: D1Database, env: Env): Promise<boolean> {
  return (await getConfig(db, 'hybrid_enabled', env)) === 'true';
}

export async function isMicroScalpEnabled(db: D1Database, env: Env): Promise<boolean> {
  return (await getConfig(db, 'micro_scalp_enabled', env)) === 'true';
}

export async function isTickScalpEnabled(db: D1Database, env: Env): Promise<boolean> {
  return (await getConfig(db, 'tick_scalp_enabled', env)) === 'true';
}

/** false = yalnızca TICK_ENTRY_SIGNAL; market buy / SCALP_ENTER yok */
export async function isTickEntryExecuteEnabled(db: D1Database, env: Env): Promise<boolean> {
  return (await getConfig(db, 'tick_entry_execute_enabled', env)) === 'true';
}

export interface TickScalpConfig {
  entryGainPct: string;
  entryGainMaxPct: string;
  maxOpenPositions: number;
  maxHoldOnlyIfProfitable: boolean;
  takeProfitPct: string;
  stopLossPct: string;
  maxTickSizePct: string;
  majorOnly: boolean;
  majorSymbols: string[];
  useLimitMaker: boolean;
  limitBuyOffsetPct: string;
  entryOrderTtlSec: number;
  stopLimitBufferPct: string;
  referenceWindowSec: number;
  orderbookRatioMin: number;
  maxSpreadPct: string;
  maxObAgeMs: number;
  require5mAlignment: boolean;
  require5mLight: boolean;
  declineMinPct: string;
  requireWsDecline: boolean;
  feeRoundtripPct: string;
  minNetTpPct: string;
  recoveryMinPct: string;
  recoveryFeeMarginPct: string;
  minSecAfterTrough: number;
  maxSecAfterTrough: number;
  scoutMaxBelowPct: string;
  scoutMaxAbovePct: string;
  requireSpreadTightening: boolean;
  obRatioAtRecoveryMin: string;
  reversalScoreEnabled: boolean;
  midSlopeSampleCount: number;
  midSlopeMinRising: number;
  noNewLowSec: number;
  aggBurstEnabled: boolean;
  aggWindowSec: number;
  aggBuyCountMin: number;
  aggBuyQuoteMinUsdt: string;
  aggImbalanceMin: string;
  profileGate: {
    a: {
      maxSpreadPct: string;
      maxScoutVsFillPct: string;
      minGainPct: string;
      maxGainPct: string;
      minSecSinceTrough: number;
      maxSecSinceTrough: number;
    };
    b: {
      maxSpreadPct: string;
      maxScoutVsFillPct: string;
    };
  };
  profileExit: {
    a: {
      takeProfitPct: string;
      maxHoldMinutes: number;
    };
    b: {
      takeProfitPct: string;
      maxHoldMinutes: number;
    };
    c: {
      takeProfitPct: string;
      maxHoldMinutes: number;
    };
  };
  failFast: {
    enabled: boolean;
    windowSec: number;
    minFavorablePct: string;
    maxAdversePct: string;
  };
  lossRecovery: {
    startMinutes: number;
    retracePct: string;
  };
  stepLock: {
    enabled: boolean;
    stage1TriggerPct: string;
    stage1LockPct: string;
    stage2TriggerPct: string;
    stage2LockPct: string;
  };
}

export interface TickShadowConfig {
  enabled: boolean;
  horizonSec: number;
  dedupeMinutes: number;
}

export interface ScoutTickConfig {
  min1hPeakPct: string;
  require1hPeak: boolean;
}

export async function getScoutTickConfig(db: D1Database, env: Env): Promise<ScoutTickConfig> {
  const [min1hPeakPct, require1hPeak] = await Promise.all([
    getConfig(db, 'scout_1h_min_peak_pct', env),
    getConfig(db, 'scout_require_1h_peak', env),
  ]);
  return {
    min1hPeakPct,
    require1hPeak: require1hPeak !== 'false',
  };
}

export async function getTickScalpConfig(db: D1Database, env: Env): Promise<TickScalpConfig> {
  const [
    entryGainPct,
    entryGainMaxPct,
    maxOpenPositionsRaw,
    maxHoldOnlyIfProfitableRaw,
    lossRecoveryStartMinutesRaw,
    lossRecoveryRetracePct,
    takeProfitPct,
    stopLossPct,
    maxTickSizePct,
    majorOnlyRaw,
    majorSymbolsRaw,
    useLimitMakerRaw,
    limitBuyOffsetPct,
    entryOrderTtlRaw,
    stopLimitBufferPct,
    windowRaw,
    obRatio,
    maxSpread,
    req5m,
    req5mLight,
    declineMin,
    reqDecline,
    fee,
    minNet,
    recoveryMin,
    recoveryFeeMargin,
    minSecTrough,
    maxSecTrough,
    scoutBelow,
    scoutAbove,
    spreadTight,
    obRecovery,
    revScore,
    slopeN,
    slopeMin,
    noNewLow,
    aggBurstEnabledRaw,
    aggWindowSecRaw,
    aggBuyCountMinRaw,
    aggBuyQuoteMinUsdt,
    aggImbalanceMin,
    profileAMaxSpreadPct,
    profileAMaxScoutVsFillPct,
    profileAMinGainPct,
    profileAMaxGainPct,
    profileAMinSecSinceTroughRaw,
    profileAMaxSecSinceTroughRaw,
    profileBMaxSpreadPct,
    profileBMaxScoutVsFillPct,
    profileATpPct,
    profileBTpPct,
    profileCTpPct,
    profileAMaxHoldMinutesRaw,
    profileBMaxHoldMinutesRaw,
    profileCMaxHoldMinutesRaw,
    failFastEnabledRaw,
    failFastWindowSecRaw,
    failFastMinFavorablePct,
    failFastMaxAdversePct,
    stepLockEnabledRaw,
    stepLock1TriggerPct,
    stepLock1LockPct,
    stepLock2TriggerPct,
    stepLock2LockPct,
  ] = await Promise.all([
      getConfig(db, 'tick_entry_gain_pct', env),
      getConfig(db, 'tick_entry_gain_max_pct', env),
      getConfig(db, 'tick_max_open_positions', env),
      getConfig(db, 'tick_max_hold_only_if_profitable', env),
      getConfig(db, 'tick_loss_recovery_start_minutes', env),
      getConfig(db, 'tick_loss_recovery_retrace_pct', env),
      getConfig(db, 'tick_take_profit_pct', env),
      getConfig(db, 'tick_stop_loss_pct', env),
      getConfig(db, 'tick_max_tick_size_pct', env),
      getConfig(db, 'tick_major_only', env),
      getConfig(db, 'tick_major_symbols', env),
      getConfig(db, 'tick_use_limit_maker', env),
      getConfig(db, 'tick_limit_buy_offset_pct', env),
      getConfig(db, 'tick_entry_order_ttl_sec', env),
      getConfig(db, 'tick_stop_limit_buffer_pct', env),
      getConfig(db, 'tick_reference_window_sec', env),
      getConfig(db, 'tick_orderbook_ratio_min', env),
      getConfig(db, 'tick_max_spread_pct', env),
      getConfig(db, 'tick_require_5m_alignment', env),
      getConfig(db, 'tick_require_5m_light', env),
      getConfig(db, 'tick_decline_min_pct', env),
      getConfig(db, 'tick_require_ws_decline', env),
      getConfig(db, 'scalp_fee_roundtrip_pct', env),
      getConfig(db, 'micro_min_net_tp_pct', env),
      getConfig(db, 'tick_recovery_min_pct', env),
      getConfig(db, 'tick_recovery_fee_margin_pct', env),
      getConfig(db, 'tick_min_sec_after_trough', env),
      getConfig(db, 'tick_max_sec_after_trough', env),
      getConfig(db, 'tick_scout_max_below_pct', env),
      getConfig(db, 'tick_scout_max_above_pct', env),
      getConfig(db, 'tick_require_spread_tightening', env),
      getConfig(db, 'tick_ob_ratio_at_recovery_min', env),
      getConfig(db, 'tick_reversal_score_enabled', env),
      getConfig(db, 'tick_mid_slope_sample_count', env),
      getConfig(db, 'tick_mid_slope_min_rising', env),
      getConfig(db, 'tick_no_new_low_sec', env),
      getConfig(db, 'tick_agg_burst_enabled', env),
      getConfig(db, 'tick_agg_window_sec', env),
      getConfig(db, 'tick_agg_buy_count_min', env),
      getConfig(db, 'tick_agg_buy_quote_min_usdt', env),
      getConfig(db, 'tick_agg_imbalance_min', env),
      getConfig(db, 'tick_profile_a_max_spread_pct', env),
      getConfig(db, 'tick_profile_a_max_scout_vs_fill_pct', env),
      getConfig(db, 'tick_profile_a_min_gain_pct', env),
      getConfig(db, 'tick_profile_a_max_gain_pct', env),
      getConfig(db, 'tick_profile_a_min_sec_since_trough', env),
      getConfig(db, 'tick_profile_a_max_sec_since_trough', env),
      getConfig(db, 'tick_profile_b_max_spread_pct', env),
      getConfig(db, 'tick_profile_b_max_scout_vs_fill_pct', env),
      getConfig(db, 'tick_profile_a_tp_pct', env),
      getConfig(db, 'tick_profile_b_tp_pct', env),
      getConfig(db, 'tick_profile_c_tp_pct', env),
      getConfig(db, 'tick_profile_a_max_hold_minutes', env),
      getConfig(db, 'tick_profile_b_max_hold_minutes', env),
      getConfig(db, 'tick_profile_c_max_hold_minutes', env),
      getConfig(db, 'tick_fail_fast_enabled', env),
      getConfig(db, 'tick_fail_fast_window_sec', env),
      getConfig(db, 'tick_fail_fast_min_favorable_pct', env),
      getConfig(db, 'tick_fail_fast_max_adverse_pct', env),
      getConfig(db, 'tick_step_lock_enabled', env),
      getConfig(db, 'tick_step_lock_1_trigger_pct', env),
      getConfig(db, 'tick_step_lock_1_lock_pct', env),
      getConfig(db, 'tick_step_lock_2_trigger_pct', env),
      getConfig(db, 'tick_step_lock_2_lock_pct', env),
    ]);
  const referenceWindowSec = Math.min(600, Math.max(30, Number(windowRaw) || 120));
  const majorSymbols = majorSymbolsRaw
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.endsWith('USDT'));
  return {
    entryGainPct,
    entryGainMaxPct,
    maxOpenPositions: Math.max(1, Math.min(10, Number(maxOpenPositionsRaw) || 2)),
    maxHoldOnlyIfProfitable: maxHoldOnlyIfProfitableRaw !== 'false',
    takeProfitPct,
    stopLossPct,
    maxTickSizePct,
    majorOnly: majorOnlyRaw !== 'false',
    majorSymbols: majorSymbols.length > 0
      ? [...new Set(majorSymbols)]
      : ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'],
    useLimitMaker: useLimitMakerRaw !== 'false',
    limitBuyOffsetPct,
    entryOrderTtlSec: Math.max(2, Number(entryOrderTtlRaw) || 8),
    stopLimitBufferPct,
    referenceWindowSec,
    orderbookRatioMin: Number(obRatio) || 1.05,
    maxSpreadPct: maxSpread,
    maxObAgeMs: 30_000,
    require5mAlignment: req5m === 'true',
    require5mLight: req5mLight !== 'false',
    declineMinPct: declineMin,
    requireWsDecline: reqDecline !== 'false',
    feeRoundtripPct: fee,
    minNetTpPct: minNet,
    recoveryMinPct: recoveryMin,
    recoveryFeeMarginPct: recoveryFeeMargin,
    minSecAfterTrough: Math.max(0, Number(minSecTrough) || 10),
    maxSecAfterTrough: Math.max(1, Number(maxSecTrough) || 45),
    scoutMaxBelowPct: scoutBelow,
    scoutMaxAbovePct: scoutAbove,
    requireSpreadTightening: spreadTight !== 'false',
    obRatioAtRecoveryMin: obRecovery,
    reversalScoreEnabled: revScore !== 'false',
    midSlopeSampleCount: Math.max(2, Number(slopeN) || 5),
    midSlopeMinRising: Math.max(1, Number(slopeMin) || 3),
    noNewLowSec: Math.max(5, Number(noNewLow) || 30),
    aggBurstEnabled: aggBurstEnabledRaw !== 'false',
    aggWindowSec: Math.max(3, Number(aggWindowSecRaw) || 10),
    aggBuyCountMin: Math.max(1, Number(aggBuyCountMinRaw) || 12),
    aggBuyQuoteMinUsdt,
    aggImbalanceMin,
    profileGate: {
      a: {
        maxSpreadPct: profileAMaxSpreadPct,
        maxScoutVsFillPct: profileAMaxScoutVsFillPct,
        minGainPct: profileAMinGainPct,
        maxGainPct: profileAMaxGainPct,
        minSecSinceTrough: Math.max(0, Number(profileAMinSecSinceTroughRaw) || 40),
        maxSecSinceTrough: Math.max(1, Number(profileAMaxSecSinceTroughRaw) || 60),
      },
      b: {
        maxSpreadPct: profileBMaxSpreadPct,
        maxScoutVsFillPct: profileBMaxScoutVsFillPct,
      },
    },
    profileExit: {
      a: {
        takeProfitPct: profileATpPct,
        maxHoldMinutes: Math.max(1, Number(profileAMaxHoldMinutesRaw) || 30),
      },
      b: {
        takeProfitPct: profileBTpPct,
        maxHoldMinutes: Math.max(1, Number(profileBMaxHoldMinutesRaw) || 20),
      },
      c: {
        takeProfitPct: profileCTpPct,
        maxHoldMinutes: Math.max(1, Number(profileCMaxHoldMinutesRaw) || 12),
      },
    },
    failFast: {
      enabled: failFastEnabledRaw !== 'false',
      windowSec: Math.max(1, Number(failFastWindowSecRaw) || 20),
      minFavorablePct: failFastMinFavorablePct,
      maxAdversePct: failFastMaxAdversePct,
    },
    lossRecovery: {
      startMinutes: Math.max(1, Number(lossRecoveryStartMinutesRaw) || 20),
      retracePct: lossRecoveryRetracePct,
    },
    stepLock: {
      enabled: stepLockEnabledRaw !== 'false',
      stage1TriggerPct: stepLock1TriggerPct,
      stage1LockPct: stepLock1LockPct,
      stage2TriggerPct: stepLock2TriggerPct,
      stage2LockPct: stepLock2LockPct,
    },
  };
}

export async function getTickShadowConfig(db: D1Database, env: Env): Promise<TickShadowConfig> {
  const [enabled, horizon, dedupe] = await Promise.all([
    getConfig(db, 'tick_shadow_enabled', env),
    getConfig(db, 'tick_shadow_horizon_sec', env),
    getConfig(db, 'tick_shadow_dedupe_minutes', env),
  ]);
  return {
    enabled: enabled !== 'false',
    horizonSec: Math.max(30, Number(horizon) || 60),
    dedupeMinutes: Math.max(1, Number(dedupe) || 5),
  };
}

export interface MicroScalpRuntimeConfig {
  universeSize: number;
  minQuoteVolumeUsdt: number;
  maxSpreadPct: string;
  min15mMovePct: string;
  entryMinScore: number;
  exitScoreFloor: number;
  scanBatchSize: number;
  minNetTpPct: string;
  volumeRatioMin: number;
  orderbookRatioMin: number;
  phase2Enabled: boolean;
  phase3Enabled: boolean;
  aggressionMin: number;
  feeRoundtripPct: string;
  trend15mGateMode: 'hard_veto' | 'penalty';
  trend15mPenalty: number;
}

export interface MicroShadowConfig {
  enabled: boolean;
  minScore: number;
  dedupeMinutes: number;
  horizonsMin: string;
  tpGrossPct: string;
}

export async function getMicroShadowConfig(db: D1Database, env: Env): Promise<MicroShadowConfig> {
  const [enabled, minScore, dedupe, horizons, tp] = await Promise.all([
    getConfig(db, 'micro_shadow_enabled', env),
    getConfig(db, 'micro_shadow_min_score', env),
    getConfig(db, 'micro_shadow_dedupe_minutes', env),
    getConfig(db, 'micro_shadow_horizons_min', env),
    getConfig(db, 'scalp_take_profit_gross_pct', env),
  ]);
  return {
    enabled: enabled === 'true',
    minScore: Number(minScore) || 0.35,
    dedupeMinutes: Math.max(1, Number(dedupe) || 10),
    horizonsMin: horizons || '5,15,30',
    tpGrossPct: tp || '0.7',
  };
}

export async function getMicroScalpConfig(
  db: D1Database,
  env: Env,
): Promise<MicroScalpRuntimeConfig> {
  const [
    universeRaw,
    minVol,
    maxSpread,
    min15m,
    entryScore,
    exitFloor,
    batchRaw,
    minNet,
    volRatio,
    obRatio,
    p2,
    p3,
    agg,
    fee,
    gateMode,
    gatePenalty,
  ] = await Promise.all([
    getConfig(db, 'micro_universe_size', env),
    getConfig(db, 'micro_min_quote_volume_usdt', env),
    getConfig(db, 'micro_max_spread_pct', env),
    getConfig(db, 'micro_min_15m_move_pct', env),
    getConfig(db, 'micro_entry_min_score', env),
    getConfig(db, 'micro_exit_score_floor', env),
    getConfig(db, 'micro_scan_batch_size', env),
    getConfig(db, 'micro_min_net_tp_pct', env),
    getConfig(db, 'micro_volume_ratio_min', env),
    getConfig(db, 'micro_orderbook_ratio_min', env),
    getConfig(db, 'micro_phase2_enabled', env),
    getConfig(db, 'micro_phase3_enabled', env),
    getConfig(db, 'micro_aggression_min', env),
    getConfig(db, 'scalp_fee_roundtrip_pct', env),
    getConfig(db, 'micro_15m_gate_mode', env),
    getConfig(db, 'micro_15m_penalty', env),
  ]);
  const universeSize = Math.min(100, Math.max(10, Number(universeRaw) || 80));
  const scanBatchSize = Math.min(12, Math.max(3, Number(batchRaw) || 8));
  return {
    universeSize,
    minQuoteVolumeUsdt: Number(minVol) || 50_000_000,
    maxSpreadPct: maxSpread,
    min15mMovePct: min15m,
    entryMinScore: Number(entryScore) || 0.75,
    exitScoreFloor: Number(exitFloor) || 0.35,
    scanBatchSize,
    minNetTpPct: minNet,
    volumeRatioMin: Number(volRatio) || 2.2,
    orderbookRatioMin: Number(obRatio) || 1.4,
    phase2Enabled: p2 === 'true',
    phase3Enabled: p3 === 'true',
    aggressionMin: Number(agg) || 0.65,
    feeRoundtripPct: fee,
    trend15mGateMode: gateMode === 'hard_veto' ? 'hard_veto' : 'penalty',
    trend15mPenalty: Number(gatePenalty) || 0.1,
  };
}

/** Gözcü + sniper tarama boyutu. Mikro: evren 10–100; tick: watchlist_size 10–100; hibrit: 1–25. */
export async function getWatchlistSize(db: D1Database, env: Env): Promise<number> {
  if (await isMicroScalpEnabled(db, env)) {
    const micro = await getMicroScalpConfig(db, env);
    return micro.universeSize;
  }
  const raw = await getConfig(db, 'watchlist_size', env);
  const n = Number(raw);
  const fallback = (await isTickScalpEnabled(db, env)) ? 30 : WATCHLIST_SIZE_DEFAULT;
  if (!Number.isFinite(n) || n < 1) return fallback;
  if (await isTickScalpEnabled(db, env)) {
    return Math.min(100, Math.max(10, Math.floor(n)));
  }
  return Math.min(25, Math.floor(n));
}

export async function getTradingConfig(
  db: D1Database,
  env: Env,
): Promise<{
  buyQuoteUsdt: string;
  pullbackTolerancePct: string;
  trailingActivationPct: string;
  trailingTightCallbackPct: string;
}> {
  const [buyQuoteUsdt, pullbackTolerancePct, trailingActivationPct, trailingTightCallbackPct] =
    await Promise.all([
      getConfig(db, 'buy_quote_usdt', env),
      getConfig(db, 'pullback_tolerance_pct', env),
      getConfig(db, 'trailing_activation_pct', env),
      getConfig(db, 'trailing_tight_callback_pct', env),
    ]);
  return {
    buyQuoteUsdt,
    pullbackTolerancePct,
    trailingActivationPct,
    trailingTightCallbackPct,
  };
}

export interface ScalpConfig {
  takeProfitGrossPct: string;
  feeRoundtripPct: string;
  maxHoldMinutes: string;
  hardStopLossPct: string;
}

export async function getScalpConfig(db: D1Database, env: Env): Promise<ScalpConfig> {
  const [takeProfitGrossPct, feeRoundtripPct, maxHoldMinutes, hardStopLossPct] = await Promise.all([
    getConfig(db, 'scalp_take_profit_gross_pct', env),
    getConfig(db, 'scalp_fee_roundtrip_pct', env),
    getConfig(db, 'scalp_max_hold_minutes', env),
    getConfig(db, 'scalp_hard_stop_loss_pct', env),
  ]);
  return { takeProfitGrossPct, feeRoundtripPct, maxHoldMinutes, hardStopLossPct };
}

export interface MomentumConfig {
  minWindowGainPct: string;
  requireAllWindows: boolean;
  maxDailyChangePct: string;
}

export interface MomentumSwitchConfig {
  enabled: boolean;
  minScoreImprovementPct: string;
  minMinutes: string;
}

export async function getMomentumSwitchConfig(
  db: D1Database,
  env: Env,
): Promise<MomentumSwitchConfig> {
  const [enabledRaw, minScoreImprovementPct, minMinutes] = await Promise.all([
    getConfig(db, 'momentum_switch_enabled', env),
    getConfig(db, 'momentum_switch_min_score_pct', env),
    getConfig(db, 'momentum_switch_min_minutes', env),
  ]);
  return {
    enabled: enabledRaw === 'true',
    minScoreImprovementPct,
    minMinutes,
  };
}

export async function getMomentumConfig(db: D1Database, env: Env): Promise<MomentumConfig> {
  const [minWindowGainPct, requireAllRaw, maxDailyChangePct] = await Promise.all([
    getConfig(db, 'momentum_min_window_gain_pct', env),
    getConfig(db, 'momentum_require_all_windows', env),
    getConfig(db, 'momentum_max_daily_change_pct', env),
  ]);
  return {
    minWindowGainPct,
    requireAllWindows: requireAllRaw === 'true',
    maxDailyChangePct,
  };
}

export async function getMomentumContinuationExtras(
  db: D1Database,
  env: Env,
): Promise<{
  minGreenWindows: number;
  maxPullbackPct: string;
  requireShortTf: boolean;
}> {
  const [minGreenRaw, maxPullbackPct, requireShortTfRaw] = await Promise.all([
    getConfig(db, 'momentum_min_green_windows', env),
    getConfig(db, 'momentum_max_pullback_pct', env),
    getConfig(db, 'momentum_require_short_tf', env),
  ]);
  const minGreen = Number(minGreenRaw);
  return {
    minGreenWindows: Number.isFinite(minGreen) && minGreen >= 1 ? Math.min(6, Math.floor(minGreen)) : 4,
    maxPullbackPct,
    requireShortTf: requireShortTfRaw === 'true',
  };
}

export interface BotConfigRow {
  key: string;
  value: string;
  updated_at: string;
}

export async function listAllConfig(db: D1Database): Promise<BotConfigRow[]> {
  const { results } = await db
    .prepare('SELECT key, value, updated_at FROM bot_config ORDER BY key')
    .all<BotConfigRow>();
  return results ?? [];
}

export async function setConfigs(
  db: D1Database,
  updates: Record<string, string>,
): Promise<void> {
  const stmts = Object.entries(updates).map(([key, value]) =>
    db
      .prepare(
        `INSERT INTO bot_config (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
      )
      .bind(key, value),
  );
  if (stmts.length > 0) await db.batch(stmts);
}

export async function getRotationConfig(
  db: D1Database,
  env: Env,
): Promise<{
  rotationWindowMinutes: string;
  rotationMinImprovementPct: string;
}> {
  const [rotationWindowMinutes, rotationMinImprovementPct] = await Promise.all([
    getConfig(db, 'rotation_window_minutes', env),
    getConfig(db, 'rotation_min_improvement_pct', env),
  ]);
  return { rotationWindowMinutes, rotationMinImprovementPct };
}

export async function setConfig(db: D1Database, key: BotConfigKey, value: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO bot_config (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    )
    .bind(key, value)
    .run();
}
