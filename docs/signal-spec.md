# Sinyal Spesifikasyonu (Faz 1 — kanıt madenciliği çıktısı)

Üretim: `scripts/analyze-edge.mjs` · fee_roundtrip=%0.15 (maker), stop_fee=%0.075 (market).

## Genel (gerçekleşmiş tick_scalp işlemleri)

| Metrik | Değer |
| --- | --- |
| İşlem | 918 |
| Win-rate | 49.1% |
| Ort. PnL (USDT) | -0.047 |
| Ort. kazanç çıkış % | 0.269 |
| Ort. kayıp çıkış % | -0.727 |
| Ort. MFE % | 0.117 |
| Ort. MAE % | -0.350 |

> Uyarı: MFE/MAE 1-dk reconcile excursion kayıtlarından; kaba/altörneklenmiş olabilir. Sweep birinci-derece tahmin.

## TP/SL/EV grid sweep (kayıtlı MFE/MAE, stop-first konservatif)

| TP % | SL % | net EV %/işlem | win-rate | n |
| --- | --- | --- | --- | --- |
| 0.4 | 0.2 | -0.2502 | 26.1% | 918 |
| 0.3 | 0.2 | -0.2520 | 26.9% | 918 |
| 0.2 | 0.2 | -0.2529 | 30.6% | 918 |
| 0.5 | 0.2 | -0.2534 | 25.8% | 918 |
| 0.6 | 0.2 | -0.2534 | 25.8% | 918 |
| 0.8 | 0.2 | -0.2534 | 25.8% | 918 |
| 1 | 0.2 | -0.2534 | 25.8% | 918 |
| 0.25 | 0.2 | -0.2537 | 28.2% | 918 |
| 0.4 | 0.25 | -0.2701 | 28.1% | 918 |
| 0.2 | 0.25 | -0.2719 | 33.1% | 918 |
| 0.25 | 0.25 | -0.2721 | 30.6% | 918 |
| 0.3 | 0.25 | -0.2722 | 29.0% | 918 |

**En iyi (kayıtlı sweep):** TP=%0.4, SL=%0.2 → net EV -0.2502%/işlem, win-rate 26.1%.

## Sinyal keşfi — feature kovaları (realized win-rate)

### gainPct

| Aralık | n | win-rate | avg PnL |
| --- | --- | --- | --- |
| 0.010..0.085 | 183 | 55.7% | -0.013 |
| 0.086..0.155 | 184 | 55.4% | -0.033 |
| 0.155..0.170 | 183 | 44.8% | -0.057 |
| 0.171..0.211 | 184 | 43.5% | -0.068 |
| 0.211..0.681 | 184 | 46.2% | -0.063 |

### recoveryPct

| Aralık | n | win-rate | avg PnL |
| --- | --- | --- | --- |
| 0.050..0.087 | 182 | 57.7% | -0.011 |
| 0.088..0.155 | 180 | 55.0% | -0.034 |
| 0.155..0.171 | 185 | 44.9% | -0.056 |
| 0.171..0.211 | 183 | 43.2% | -0.070 |
| 0.211..0.681 | 183 | 46.4% | -0.062 |

### secSinceTrough

| Aralık | n | win-rate | avg PnL |
| --- | --- | --- | --- |
| 10.006..17.024 | 182 | 52.2% | -0.032 |
| 17.108..27.232 | 183 | 50.3% | -0.052 |
| 27.286..38.882 | 182 | 37.9% | -0.053 |
| 38.951..50.765 | 183 | 50.3% | -0.063 |
| 50.785..59.955 | 183 | 56.3% | -0.035 |

### reversalScore

| Aralık | n | win-rate | avg PnL |
| --- | --- | --- | --- |
| 2.155..2.443 | 182 | 58.8% | -0.010 |
| 2.445..2.540 | 183 | 49.7% | -0.040 |
| 2.540..2.709 | 182 | 42.9% | -0.045 |
| 2.709..3.058 | 183 | 51.4% | -0.032 |
| 3.059..170.231 | 183 | 44.3% | -0.107 |

### spreadPct

| Aralık | n | win-rate | avg PnL |
| --- | --- | --- | --- |
| 0.000..0.010 | 183 | 49.2% | -0.145 |
| 0.010..0.013 | 184 | 43.5% | -0.036 |
| 0.013..0.021 | 183 | 55.7% | -0.014 |
| 0.021..0.028 | 184 | 49.5% | -0.018 |
| 0.028..0.077 | 184 | 47.8% | -0.022 |

### bidAskRatio

| Aralık | n | win-rate | avg PnL |
| --- | --- | --- | --- |
| 0.152..0.863 | 182 | 51.6% | -0.033 |
| 0.869..1.100 | 185 | 51.4% | -0.028 |
| 1.100..1.378 | 183 | 49.2% | -0.030 |
| 1.379..1.825 | 184 | 48.4% | -0.040 |
| 1.840..168.340 | 184 | 45.1% | -0.103 |

### scoutVsFillPct

| Aralık | n | win-rate | avg PnL |
| --- | --- | --- | --- |
| -3.818..-0.375 | 183 | 50.3% | -0.040 |
| -0.374..-0.154 | 184 | 48.9% | -0.057 |
| -0.154..-0.022 | 183 | 56.3% | -0.030 |
| -0.022..0.065 | 184 | 51.1% | -0.029 |
| 0.065..1.146 | 184 | 39.1% | -0.079 |

### hour

| Aralık | n | win-rate | avg PnL |
| --- | --- | --- | --- |
| 0..2 | 149 | 49.0% | -0.064 |
| 3..6 | 217 | 38.2% | -0.079 |
| 7..12 | 151 | 61.6% | -0.003 |
| 13..19 | 195 | 59.5% | -0.014 |
| 20..23 | 206 | 41.7% | -0.064 |

## Shadow çapraz-doğrulama (forward-60s pozitif oranı)

### gainPct (shadow)

| Aralık | n | pozitif oranı |
| --- | --- | --- |
| 0.050..0.105 | 862 | 47.3% |
| 0.105..0.163 | 857 | 47.8% |
| 0.163..0.185 | 868 | 47.2% |
| 0.185..0.235 | 864 | 46.1% |
| 0.235..0.793 | 863 | 51.0% |

### recoveryPct (shadow)

| Aralık | n | pozitif oranı |
| --- | --- | --- |
| 0.050..0.105 | 861 | 47.4% |
| 0.105..0.163 | 858 | 47.8% |
| 0.163..0.185 | 868 | 47.2% |
| 0.185..0.235 | 864 | 46.1% |
| 0.235..0.793 | 863 | 51.0% |

### reversalScore (shadow)

| Aralık | n | pozitif oranı |
| --- | --- | --- |
| 0.773..2.466 | 859 | 48.2% |
| 2.467..2.594 | 864 | 46.1% |
| 2.595..2.775 | 865 | 46.8% |
| 2.775..3.090 | 863 | 48.9% |
| 3.092..512.848 | 863 | 49.5% |

## Kategori kırılımları

### Çıkış kaynağı

| source | n | win-rate | toplam PnL |
| --- | --- | --- | --- |
| scalp_take_profit_oco | 322 | 94.7% | 15.259 |
| scalp_take_profit | 1 | 100.0% | 0.065 |
| scalp_step_lock | 2 | 0.0% | -0.065 |
| scalp_hard_stop | 7 | 0.0% | -0.472 |
| force_close_market_sell | 18 | 5.6% | -3.286 |
| scalp_fail_fast_oco | 100 | 9.0% | -3.579 |
| scalp_max_hold_oco | 159 | 50.3% | -5.288 |
| scalp_loss_recovery_retrace_oco | 69 | 0.0% | -14.443 |
| scalp_hard_stop_oco | 240 | 22.9% | -31.130 |

### Profil

| profil | n | win-rate | toplam PnL |
| --- | --- | --- | --- |
| — | 121 | 51.2% | -1.353 |
| A | 77 | 55.8% | -5.876 |
| B | 720 | 48.1% | -35.710 |

### Sektör (top 12 / bottom 5 PnL)

| sektör | n | win-rate | toplam PnL |
| --- | --- | --- | --- |
| defi | 5 | 20.0% | -0.129 |
| meme | 33 | 39.4% | -1.425 |
| ai | 61 | 44.3% | -2.736 |
| l1 | 107 | 40.2% | -6.383 |
| other | 712 | 51.5% | -32.266 |
| defi | 5 | 20.0% | -0.129 |
| meme | 33 | 39.4% | -1.425 |
| ai | 61 | 44.3% | -2.736 |
| l1 | 107 | 40.2% | -6.383 |
| other | 712 | 51.5% | -32.266 |

## Faz 3 için öneri (otomatik taslak — insan doğrulaması şart)

- take_profit_pct ≈ %0.4, stop_loss_pct ≈ %0.2 (sweep en iyi EV).
- Net EV -0.2502%/işlem NEGATİF — sinyali sıkılaştır / Spot Grid B-planı.
- Sinyal eşikleri: yukarıdaki kovalarda win-rate (ve shadow pozitif oranı) >%55 olan aralıkları AND ile birleştir.
- Overfit koruması: train/validation zaman ayrımı ile bu spec doğrulanmadan canlı açılmaz.
