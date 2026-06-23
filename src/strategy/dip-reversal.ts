/**
 * Dip Reversal Sniper — saf/test edilebilir hibrit sinyal.
 *
 * Hibrit: (1) flash-drop ile capitulation şiddeti (windowDropPct), (2) WS tick
 * düşüşü gerçekleşti mi, (3) diptan erken bounce onayı (recovery + mid eğimi +
 * reversal skoru + dipten geçen süre). Hepsi geçerse giriş uygun.
 *
 * Karar mantığı saftır; canlı veri (klines/WS) job katmanında toplanır.
 */

/**
 * Capitulation derinliği — pencere içinde SIRALI tepe→dip max drawdown (`low` üzerinden).
 *
 * `windowDropPctFromCloses` (grid) tepe→ŞU AN ölçer; fiyat toparlayınca düşüş 0'a iner ve
 * bounce kapısıyla aynı anda kapanır. Burada amaç farklı: "son N dakikada gerçek bir dip
 * yaşandı mı?" Bunu mum LOW'ları üzerinden, koşan tepeye göre max düşüş olarak hesaplarız;
 * fiyat geri toparlasa bile dip pencere kayana dek KAYITLI kalır. Böylece capitulation
 * kapısı bounce kapısından bağımsızlaşır ve intra-candle fitiller de yakalanır.
 *
 * Sıralı (peak-then-trough) hesap, yükseliş trendindeki low-önce-high-sonra dizilimini
 * yanlışlıkla "düşüş" saymaz. Grid'in shared fonksiyonuna DOKUNMAZ (izole).
 */
export function windowDrawdownPct(
  highs: number[],
  lows: number[],
  lastPrice: number,
  windowMin: number,
): number {
  if (windowMin <= 0) return 0;
  const bars = Math.max(1, Math.ceil(windowMin / 5));
  const hi = highs.slice(-bars);
  const lo = lows.slice(-bars);
  const n = Math.min(hi.length, lo.length);
  let peak = 0;
  let maxDd = 0;
  for (let i = 0; i < n; i++) {
    if (hi[i] > peak) peak = hi[i];
    if (peak > 0 && lo[i] > 0) {
      const dd = ((peak - lo[i]) / peak) * 100;
      if (dd > maxDd) maxDd = dd;
    }
  }
  if (lastPrice > 0) {
    if (lastPrice > peak) peak = lastPrice;
    if (peak > 0) {
      const dd = ((peak - lastPrice) / peak) * 100;
      if (dd > maxDd) maxDd = dd;
    }
  }
  return maxDd > 0 ? maxDd : 0;
}

export interface DipReversalThresholds {
  minCapitulationDropPct: number;
  minWsDeclinePct: number;
  minRecoveryFromLowPct: number;
  minReversalScore: number;
  maxSecSinceTrough: number;
  requireMidSlope: boolean;
}

export interface DipReversalSignalInput {
  /** Flash-drop penceresinde tepe→son fiyat düşüşü % (capitulation şiddeti). */
  windowDropPct: number;
  /** WS tick düşüşü % (tepe→dip). null = veri yok. */
  wsDeclinePct: number | null;
  /** Diptan toparlanma % (mid - low)/low. null = veri yok. */
  recoveryFromWsLowPct: number | null;
  /** Reversal skoru (recovery*3 + slope*2 + ...). */
  reversalScore: number;
  /** Dipten bu yana geçen saniye. null = dip yok. */
  secSinceTrough: number | null;
  /** Yükselen mid eğimi onaylandı mı. */
  midSlopeOk: boolean;
  /** Çok-zaman-dilimli momentum (multi-TF dönüş kapıları). null = veri yok. */
  change1mPct: number | null;
  change3mPct: number | null;
  change10mPct: number | null;
  change30mPct: number | null;
}

export interface DipReversalGate {
  id: string;
  pass: boolean;
  actual: number | null;
  threshold: string;
}

export interface DipReversalSignal {
  eligible: boolean;
  score: number;
  gates: DipReversalGate[];
  primaryBlocker: string | null;
}

/** Tepe filtresi: 30dk bu eşikten fazla yükseldiyse "uzamış/geç" → girme (ZEC +3.42 dersi). */
export const MULTI_TF_MAX_30M_GAIN_PCT = 1.5;
/** Dead-cat filtresi: 30dk bunun altındaysa hâlâ sert düşüş trendinde → girme. */
export const MULTI_TF_MIN_30M_GAIN_PCT = -0.5;
/** Minimum düşüş: backtest (2.7g) gösterdi ki derinlik önemsiz (derin=dead-cat); düşük
 *  daha iyi. Sadece minik gürültüyü eler. */
export const MULTI_TF_MIN_DROP_PCT = 0.4;
/** 10dk üst sınır: coin son 10dk'da bu kadar yükseldiyse toparlanmanın TEPESİNE yakın →
 *  girme (NEAR/OPG dipten %1 çıkmışken alınıp düştü). Dönüşün başını yakala, tepesini değil. */
export const MULTI_TF_MAX_10M_GAIN_PCT = 0.8;
/** Maksimum recovery: coin dipten bu kadardan FAZLA toparlandıysa GEÇ giriş → girme.
 *  Backtest: recovery 0.5-1.0 en kötü bin (-0.20); 0.15-0.40 "tam dönüş anı" en iyi. */
export const MULTI_TF_MAX_RECOVERY_PCT = 0.40;

/**
 * Skor (multi-TF): kısa+orta pencere momentum toplamı + reversal gücü.
 * Daha güçlü ve hizalı dönüş = daha iyi aday.
 */
export function dipReversalScore(input: DipReversalSignalInput): number {
  const tf =
    (input.change1mPct ?? 0) + (input.change3mPct ?? 0) + (input.change10mPct ?? 0);
  return Number((input.reversalScore + tf).toFixed(2));
}

/**
 * Multi-TF Dönüş değerlendirmesi (eski capitulation 6-kapı YERİNE).
 *
 * Mantık: coin ÖNCE kırmızıydı (dipten toparlanıyor) → 1dk+3dk+10dk pencereleri
 * AYNI ANDA yeşile döndü (teyitli dönüş) → ama henüz tavana vurmadı (30dk tepe filtresi).
 * Tek pencere yanıltır; 3 pencerenin hizalı yukarı dönmesi gerçek dönüştür.
 */
export function evaluateDipReversalSignal(
  input: DipReversalSignalInput,
  thr: DipReversalThresholds,
): DipReversalSignal {
  const c1 = input.change1mPct;
  const c3 = input.change3mPct;
  const c10 = input.change10mPct;
  const c30 = input.change30mPct;

  const gates: DipReversalGate[] = [
    {
      id: 'min_drop',
      pass: input.windowDropPct >= MULTI_TF_MIN_DROP_PCT,
      actual: input.windowDropPct,
      threshold: `son 10dk düşüş >= ${MULTI_TF_MIN_DROP_PCT}% (ciddi kırmızı)`,
    },
    {
      id: 'prior_dip',
      pass:
        input.recoveryFromWsLowPct != null &&
        input.recoveryFromWsLowPct >= thr.minRecoveryFromLowPct &&
        input.recoveryFromWsLowPct < MULTI_TF_MAX_RECOVERY_PCT,
      actual: input.recoveryFromWsLowPct,
      threshold: `${thr.minRecoveryFromLowPct} <= recovery < ${MULTI_TF_MAX_RECOVERY_PCT}% (tam dönüş anı, geç değil)`,
    },
    {
      id: 'tf_1m',
      pass: c1 != null && c1 > 0,
      actual: c1,
      threshold: '1dk > 0',
    },
    {
      id: 'tf_3m',
      pass: c3 != null && c3 > 0,
      actual: c3,
      threshold: '3dk > 0',
    },
    {
      id: 'tf_10m',
      pass: c10 != null && c10 > 0 && c10 < MULTI_TF_MAX_10M_GAIN_PCT,
      actual: c10,
      threshold: `0 < 10dk < ${MULTI_TF_MAX_10M_GAIN_PCT}% (tepeye yakın değil)`,
    },
    {
      id: 'not_extended',
      pass:
        c30 != null &&
        c30 > MULTI_TF_MIN_30M_GAIN_PCT &&
        c30 < MULTI_TF_MAX_30M_GAIN_PCT,
      actual: c30,
      threshold: `${MULTI_TF_MIN_30M_GAIN_PCT} < 30dk < ${MULTI_TF_MAX_30M_GAIN_PCT}% (dead-cat & tepe değil)`,
    },
    {
      // Dönüş GÜCÜ: anlık 1/3/10dk pozitifliği düşüş trendinde geçici sıçrama olabilir;
      // reversalScore (eğim+hacim+süreklilik) zayıfsa dönüş sürmez → sahte girişi eler.
      id: 'reversal_score',
      pass: input.reversalScore >= thr.minReversalScore,
      actual: input.reversalScore,
      threshold: `reversalScore >= ${thr.minReversalScore} (güçlü dönüş)`,
    },
  ];

  const eligible = gates.every((g) => g.pass);
  const primaryBlocker = gates.find((g) => !g.pass)?.id ?? null;

  return {
    eligible,
    score: dipReversalScore(input),
    gates,
    primaryBlocker,
  };
}
