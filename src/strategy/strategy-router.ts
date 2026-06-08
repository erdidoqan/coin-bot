/**
 * Rejim-bazlı strateji router — saf/test edilebilir.
 *
 * Botun çalıştığı ölçek dakikalardır; bu yüzden router INTRADAY çoklu-pencere
 * (15/30/60dk) BTC momentumuna bakar — günlük/haftalık trend (lagging) DEĞİL.
 * Tüm eşikler ATR-ölçekli (volatiliteye uyum). Hizalanmış pencereler whipsaw'ı önler.
 *
 *   - momentum     → hizalı yükseliş + geniş katılım (yükselen coine bin)
 *   - dip_reversal → kısa sert düşüş sonrası toparlanma (flash-crash bounce)
 *   - pause        → zayıf katılım / süren satış / belirsiz → giriş yok
 *
 * Açık pozisyonları ETKİLEMEZ; sadece yeni giriş yönlendirmesi.
 */
export type StrategyChoice = 'momentum' | 'dip_reversal' | 'pause';

export interface StrategyRouterInput {
  /** BTC son 15dk kümülatif momentum %. */
  btcM15Pct: number | null;
  /** BTC son 30dk kümülatif momentum %. */
  btcM30Pct: number | null;
  /** BTC son 60dk kümülatif momentum %. */
  btcM60Pct: number | null;
  /** BTC 15m ATR % (eşik ölçeklemesi için). */
  atrPct: number | null;
  /** Watchlist breadth % (0-100). */
  breadthPct: number;
}

export interface StrategyRouterThresholds {
  /** Momentum için minimum breadth (geniş katılım). */
  momentumBreadthMin: number;
  /** Bunun altı = zayıf katılım/panik → dur. */
  dipBreadthMin: number;
  /** Dip penceresi için minimum ATR (volatilite). */
  volatileAtrMin: number;
  /** Sert satış eşiği: m30 ≤ −ATR×bu → kill-switch. */
  killAtrMult: number;
  /** Güçlü yukarı eşiği: m30 ≥ ATR×bu → momentum. */
  momentumAtrMult: number;
  /** Toparlanma eşiği: m15 ≥ ATR×bu → dip bounce. */
  recoverAtrMult: number;
}

export interface StrategyDecision {
  strategy: StrategyChoice;
  reason: string;
}

/** ATR verisi yoksa makul taban (BTC 15m tipik ~0.8%). */
const ATR_FALLBACK = 0.8;

export function selectStrategy(
  i: StrategyRouterInput,
  thr: StrategyRouterThresholds,
): StrategyDecision {
  const atr = i.atrPct != null && i.atrPct > 0 ? i.atrPct : ATR_FALLBACK;
  const m15 = i.btcM15Pct ?? 0;
  const m30 = i.btcM30Pct ?? 0;
  // Çoklu-pencere ortalaması: tek pencereye takılma (büyük resmi yakala + gürültüyü yumuşat).
  const moms = [i.btcM15Pct, i.btcM30Pct, i.btcM60Pct].filter(
    (x): x is number => x != null,
  );
  const avgMom = moms.length > 0 ? moms.reduce((a, b) => a + b, 0) / moms.length : 0;

  // 1) Zayıf katılım / risk-off → dur. (Altların geneli katılmıyorsa girme.)
  if (i.breadthPct < thr.dipBreadthMin) {
    return { strategy: 'pause', reason: 'weak_breadth_riskoff' };
  }

  // 2) Süren sert satış (intraday kill-switch) → dur.
  //    30dk ATR'nin katından fazla düştü VE 15dk hâlâ toparlanmıyor.
  if (m30 <= -atr * thr.killAtrMult && m15 <= 0) {
    return { strategy: 'pause', reason: 'intraday_selloff' };
  }

  // 3) Yükseliş + geniş katılım → momentum.
  //    Kısa vade pozitif (m15>0) + çoklu-pencere ortalama momentum eşiği aşıyor.
  //    Ortalama, tek pencere (m30) yatay olsa bile büyük resmi (m60) yakalar.
  if (m15 > 0 && avgMom >= atr * thr.momentumAtrMult && i.breadthPct >= thr.momentumBreadthMin) {
    return { strategy: 'momentum', reason: 'intraday_uptrend' };
  }

  // 4) Düştü ama toparlanıyor (flash-crash bounce) + yeterli volatilite → dip.
  if (
    m30 < 0 &&
    m15 >= atr * thr.recoverAtrMult &&
    (i.atrPct ?? 0) >= thr.volatileAtrMin
  ) {
    return { strategy: 'dip_reversal', reason: 'dip_recovery' };
  }

  // 5) Belirsiz → dur (güvenli).
  return { strategy: 'pause', reason: 'no_clear_regime' };
}
