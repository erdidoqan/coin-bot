/**
 * Dip Reversal Sniper — config katmanı.
 *
 * Bağımsız strateji: yüksek dalgalı düşüşte capitulation dip + bounce onayı ile
 * tek market alım, Binance native trailing (TAKE_PROFIT) emriyle çıkış, hard-stop
 * koruması. Grid'den tamamen izole (kendi entry_mode='dip_reversal').
 */
import { getConfig } from './bot-config';

export interface DipReversalConfig {
  enabled: boolean;
  /** İşlem başına harcanacak USDT (quoteOrderQty). */
  buyQuoteUsdt: string;
  /** Aynı anda en fazla açık dip_reversal pozisyonu. */
  maxConcurrent: number;
  /** Flash-drop: pencere içi tepe→son düşüş % alt sınırı (capitulation). */
  minCapitulationDropPct: number;
  /** Flash-drop penceresi (dakika; 5m kapanışlardan). */
  flashWindowMin: number;
  /** WS tick düşüşü % alt sınırı (dip gerçekten oldu mu). */
  minWsDeclinePct: number;
  /** Diptan toparlanma % alt sınırı (bounce onayı). */
  minRecoveryFromLowPct: number;
  /** Reversal skoru alt sınırı. */
  minReversalScore: number;
  /** Dipten bu kadar saniyeden fazla geçtiyse giriş yok (geç kalma). */
  maxSecSinceTrough: number;
  /** Yükselen mid eğimi şartı. */
  requireMidSlope: boolean;
  /** Native trailing aktivasyon % (stopPrice = avgCost*(1+%)). */
  trailingActivationPct: string;
  /** Native trailing geri çekilme (callback) %. */
  trailingCallbackPct: string;
  /** Hard-stop zarar % (bounce başarısız olursa bag koruması). */
  hardStopPct: string;
  /** Zaman-stop: bu kadar dk açık kalıp hâlâ kârda değilse market çıkış (0=kapalı). */
  maxHoldMin: number;
  /** Çıkış sonrası aynı sembolde bekleme (dakika). */
  postExitCooldownMin: number;
  /** İzin verilen rejimler (CSV → liste; boş = tüm rejimler). */
  regimeFilter: string[];
}

function num(value: string, fallback: number, min?: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return min != null ? Math.max(min, n) : n;
}

export async function getDipReversalConfig(
  db: D1Database,
  env: Env,
): Promise<DipReversalConfig> {
  const [
    enabled,
    buyQuoteUsdt,
    maxConcurrent,
    minCapitulationDropPct,
    flashWindowMin,
    minWsDeclinePct,
    minRecoveryFromLowPct,
    minReversalScore,
    maxSecSinceTrough,
    requireMidSlope,
    trailingActivationPct,
    trailingCallbackPct,
    hardStopPct,
    maxHoldMin,
    postExitCooldownMin,
    regimeFilter,
  ] = await Promise.all([
    getConfig(db, 'dip_reversal_enabled', env),
    getConfig(db, 'dip_reversal_buy_quote_usdt', env),
    getConfig(db, 'dip_reversal_max_concurrent', env),
    getConfig(db, 'dip_reversal_min_capitulation_drop_pct', env),
    getConfig(db, 'dip_reversal_flash_window_min', env),
    getConfig(db, 'dip_reversal_min_ws_decline_pct', env),
    getConfig(db, 'dip_reversal_min_recovery_from_low_pct', env),
    getConfig(db, 'dip_reversal_min_reversal_score', env),
    getConfig(db, 'dip_reversal_max_sec_since_trough', env),
    getConfig(db, 'dip_reversal_require_mid_slope', env),
    getConfig(db, 'dip_reversal_trailing_activation_pct', env),
    getConfig(db, 'dip_reversal_trailing_callback_pct', env),
    getConfig(db, 'dip_reversal_hard_stop_pct', env),
    getConfig(db, 'dip_reversal_max_hold_min', env),
    getConfig(db, 'dip_reversal_post_exit_cooldown_min', env),
    getConfig(db, 'dip_reversal_regime_filter', env),
  ]);

  return {
    enabled: enabled === 'true',
    buyQuoteUsdt,
    maxConcurrent: Math.max(1, Math.round(num(maxConcurrent, 3, 1))),
    minCapitulationDropPct: num(minCapitulationDropPct, 1.0, 0),
    flashWindowMin: Math.max(5, Math.round(num(flashWindowMin, 10, 5))),
    minWsDeclinePct: num(minWsDeclinePct, 0.4, 0),
    minRecoveryFromLowPct: num(minRecoveryFromLowPct, 0.15, 0),
    minReversalScore: num(minReversalScore, 6, 0),
    maxSecSinceTrough: Math.max(1, Math.round(num(maxSecSinceTrough, 90, 1))),
    requireMidSlope: requireMidSlope !== 'false',
    trailingActivationPct,
    trailingCallbackPct,
    hardStopPct,
    maxHoldMin: Math.max(0, Math.round(num(maxHoldMin, 40, 0))),
    postExitCooldownMin: Math.max(0, Math.round(num(postExitCooldownMin, 30, 0))),
    regimeFilter: regimeFilter
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  };
}
