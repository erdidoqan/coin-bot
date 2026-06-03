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

/**
 * Skor: bounce gücü (reversalScore) + capitulation derinliği bonusu.
 * Daha derin dip + daha güçlü bounce = daha iyi aday.
 */
export function dipReversalScore(input: DipReversalSignalInput): number {
  const depthBonus = Math.max(0, input.windowDropPct) * 2;
  return Number((input.reversalScore + depthBonus).toFixed(2));
}

export function evaluateDipReversalSignal(
  input: DipReversalSignalInput,
  thr: DipReversalThresholds,
): DipReversalSignal {
  const gates: DipReversalGate[] = [
    {
      id: 'capitulation',
      pass: input.windowDropPct >= thr.minCapitulationDropPct,
      actual: input.windowDropPct,
      threshold: `windowDrop >= ${thr.minCapitulationDropPct}%`,
    },
    {
      id: 'ws_decline',
      pass: input.wsDeclinePct != null && input.wsDeclinePct >= thr.minWsDeclinePct,
      actual: input.wsDeclinePct,
      threshold: `wsDecline >= ${thr.minWsDeclinePct}%`,
    },
    {
      id: 'recovery',
      pass:
        input.recoveryFromWsLowPct != null &&
        input.recoveryFromWsLowPct >= thr.minRecoveryFromLowPct,
      actual: input.recoveryFromWsLowPct,
      threshold: `recovery >= ${thr.minRecoveryFromLowPct}%`,
    },
    {
      id: 'reversal_score',
      pass: input.reversalScore >= thr.minReversalScore,
      actual: input.reversalScore,
      threshold: `reversalScore >= ${thr.minReversalScore}`,
    },
    {
      id: 'trough_recency',
      pass: input.secSinceTrough != null && input.secSinceTrough <= thr.maxSecSinceTrough,
      actual: input.secSinceTrough,
      threshold: `secSinceTrough <= ${thr.maxSecSinceTrough}`,
    },
  ];

  if (thr.requireMidSlope) {
    gates.push({
      id: 'mid_slope',
      pass: input.midSlopeOk,
      actual: null,
      threshold: 'yükselen mid eğimi',
    });
  }

  const eligible = gates.every((g) => g.pass);
  const primaryBlocker = gates.find((g) => !g.pass)?.id ?? null;

  return {
    eligible,
    score: dipReversalScore(input),
    gates,
    primaryBlocker,
  };
}
