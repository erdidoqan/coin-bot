# Spot Grid — Çalıştırma Kılavuzu (Go-Live Protokolü)

Faz 1 kanıtı: yön-tahminli scalp sinyalinin edge'i yok (shadow forward-60s ~%48 düz,
ort. MFE %0.12 < fee duvarı). Pivot: **Spot Grid** — tahmin gerektirmeyen, aralıkta
al-sat. Backtest: grid mekaniği realize-pozitif (spacing > fee duvarı), tek risk
trend envanteri (bag) → motorda stop-out + range-reset + envanter guard var.

## Mimari (additive)

- `grid_enabled=false` iken eski davranış aynen korunur (hiçbir şey değişmez).
- `grid_enabled=true` iken dakikalık cron `runGridMaintenance` çalışır:
  - Aktif grid yoksa: aralık (auto percentile / manual) + fee-wall'a göre sınırlı
    grid sayısı + fiyat altına LIMIT alış merdiveni kurar.
  - Aktif grid varsa: fill tespiti → realize + karşı emir arm; trend koruması.
- **Gerçek emir YALNIZCA `TRADING_ENABLED=true` VE `live_gate=true`.** Aksi halde
  motor "paper" çalışır (mock fill, fiyat-kesişimi) ve `GRID_*` shadow verisi üretir.

## Kademeli canlıya geçiş

1. **Paper (varsayılan):** `grid_enabled=true`, `live_gate=false`. Motor mock fill ile
   döner; `GRID_SETUP`, `GRID_CYCLE`, `GRID_MAINTAIN`, `GRID_STOPPED` loglanır.
2. **İzleme:** birkaç gün `GRID_CYCLE` realize pnl + `GRID_STOPPED` (stop_below/above)
   dağılımına bak. `realized_pnl` net pozitif ve envanter (bag) kontrollü mü?
3. **Küçük canlı:** pozitifse `live_gate=true`, `grid_investment_usdt` küçük (örn. 100–200).
4. **İzle + ölçek:** günlük net + stop-out sıklığı plan içinde ise yatırımı artır.
5. **Acil dur:** `grid_enabled=false` (motor durur) veya `TRADING_ENABLED=false`
   (tüm gerçek emirler durur). Açık grid bir sonraki maintain'de stop koşullarıyla kapanır;
   manuel: `grid_state.status='STOPPED'`.

## Config anahtarları (sade set)

| key | varsayılan | açıklama |
|-----|-----------|----------|
| `grid_enabled` | false | grid motorunu aç |
| `live_gate` | false | gerçek emir izni (kapalıyken paper) |
| `grid_symbol` | BNBUSDT | tek sembol |
| `grid_range_mode` | auto | auto (lookback percentile) / manual |
| `grid_range_lookback_days` | 7 | auto aralık penceresi |
| `grid_range_pctl` | 8 | auto alt=p10, üst=p90 (`price_in_range` + grid aralığı) |
| `grid_allow_new_grid_while_recovering` | true | RECOVERING sembolde yeni ACTIVE grid (emirler grid_id ile ayrı) |
| `grid_lower_price` / `grid_upper_price` | 0 | manual aralık |
| `grid_count` | 20 | hedef grid sayısı (fee-wall ile sınırlanır) |
| `grid_investment_usdt` | 200 | toplam yatırım |
| `grid_fee_roundtrip_pct` | 0.15 | maker roundtrip (BNB indirimli) |
| `grid_fee_wall_multiple` | 2 | spacing ≥ fee × bu |
| `grid_stop_below_pct` | 2.0 | alt sınırın bu kadar altında kurtarma modu (zararına satma yok) |
| `grid_recovery_margin_pct` | 0.3 | kurtarma satış hedefi: fee_roundtrip + bu marj (%) |
| `grid_stop_above_pct` | 2.0 | üst sınırın bu kadar üstünde stop (kâr al) |
| `grid_range_reset_enabled` | true | stop sonrası yeni aralıkla yeniden kur |
| `grid_max_inventory_usdt` | 300 | envanter (bag) tavanı guard |
| `grid_ladder_mode` | breakeven_dip | `breakeven_dip`: tek açık alış (flat=yakın, bag=dip) + ort+% marj çıkış; `classic`: çoklu yakın alış + üst SELL |
| `grid_floor_exit_margin_pct` | 0.5 | breakeven_dip çıkış LIMIT: ortalama maliyet + bu % |
| `grid_dip_buy_defer_steps` | 1 | breakeven_dip: 0=hemen limit alış; N=fiyat hedefin N basamak üstüne inince koy (USDT kilidi yok). Fiyat serbest bırakma eşiğinin üstüne çıkınca açık alış iptal. |
| `grid_max_consecutive_buys` | 2 | classic mod: eşzamanlı açık alış tavanı |
| `grid_flash_drop_enabled` | true | ani düşüş koruması |
| `grid_flash_drop_warn_pct` | 2.0 | uyarı: yeni alış/heal/recenter durur |
| `grid_flash_drop_pause_pct` | 3.0 | açık alışlar iptal |
| `grid_flash_drop_recovery_pct` | 5.0 | otomatik recovery (`flash_drop`) |
| `grid_flash_drop_window_min` | 15 | kline penceresi (5m) |
| `grid_flash_drop_max_fills` | 3 | fill storm eşiği |
| `grid_flash_drop_fill_window_min` | 10 | fill storm penceresi |
| `grid_flash_drop_overfill_mult` | 1.5 | dolu alış maliyeti > yatırım × bu → recovery |
| `grid_flash_drop_scout_block_panic` | true | BTC panic rejiminde yeni grid yok |
| `grid_flash_drop_symbol_cooldown_min` | 60 | flash recovery sonrası sembol bekleme |
| `grid_readiness_downside_bars` | 3 | aday: üst üste kırmızı 5m kapanış sayısı (0=kapalı). Çıkış sonrası gevşetmede de geçerli; yalnızca kısa getiri eşiği `grid_readiness_post_exit_momentum_warn_pct` ile gevşer. |
| `grid_readiness_short_return_bars` | 3 | aday: kısa net getiri penceresi (5m bar) |
| `grid_max_efficiency_ratio` | 0.25 | aday: ranging (ER ≤ bu; düşük = daha trend, hazır değil) |
| `grid_min_range_width_pct` | 3.0 | aday: min 24s aralık genişliği % (fee duvarı) |
| `grid_min_atr_pct` | 0.25 | aday: min ATR% (yeterli hareket) |
| `grid_max_range_width_pct` | 18 | aday: max 24s aralık % |
| `grid_readiness_max_spread_pct` | 0.10 | aday: max spread % |
| `grid_readiness_momentum_warn_pct` | 3.0 | aday: kısa düşüş eşiği % (flash uyarısından ayrı) |
| `grid_readiness_max_path_range_ratio` | 12 | aday: max path/range kapanış span (0=kapalı) |
| `grid_readiness_max_bar_range_path_ratio` | 18 | aday: max Σ(H−L)/span — fitilli mumlar |
| `grid_readiness_max_stability_range_pct` | 28 | aday: 24s pencerede max (H−L)/mid % |
| `grid_readiness_stability_bars` | 288 | stabilite kapıları için 5m bar (288≈24s) |

`grid_state.anchor_price`: kurulum anı referans fiyatı (drawdown hesabı; recenter güncellemez).

### Aday Uygunluk (panel + scout)

`GET /admin/api/grid-candidates` → watchlist adayları; scout (`setupGrids`) ile **aynı kapılar**:

1. Klasik readiness (6): ranging ER, aralık genişliği, ATR, spread, fiyat aralıkta.
2. **Flash** (`no_flash_drop`): yalnızca `flash=none` → hazır (warn/pause/recovery hepsi engel).
3. **Momentum** (`downside_momentum`): üst üste düşen kapanış veya kısa net getiri &lt; −`grid_readiness_momentum_warn_pct`.
4. **Stabilite** (24s REST kline zorunlu; DO 120 bar yetmez):
   - `path_stability`: kapanış yolu / kapanış span ≤ `grid_readiness_max_path_range_ratio`
   - `bar_volatility`: Σ(mum range) / span ≤ `grid_readiness_max_bar_range_path_ratio`
   - `stability_range`: pencere aralık % ≤ `grid_readiness_max_stability_range_pct`

Ek scout kuralları (tabloda satır bazlı veya üst banner):

- **Cooldown:** flash recovery sonrası sembol `grid_flash_drop_symbol_cooldown_min` dk seçilmez (`flash_cooldown`).
- **Piyasa düşüş modu:** `grid_market_downturn_enabled=true` ve `evaluateGridMarketDownturn` aktif → tüm adaylarda `setupEligible=false`, banner `market_downturn` / `market_panic`.
- **Panic (birleşik):** panic rejimi artık düşüş modunun parçası (`grid_market_downturn_block_panic`); eski `market_panic` GRID_WAIT hâlâ loglanır.

`grid_flash_drop_enabled=false` iken flash kapısı her zaman geçer; momentum `grid_readiness_downside_bars=0` ile kapatılabilir.

### Grid scout ön filtresi (watchlist)

15 dk `runGridScout`: önce hacim top `N × grid_scout_pool_multiplier`, sonra (açıksa):

| Kontrol | Kaynak | Varsayılan |
|---------|--------|------------|
| 24s düşüş/çıkış | `|priceChangePercent|` | `grid_scout_max_abs_change_pct` = 12 |
| 24s aralık çok dar | ticker high/low | `grid_min_range_width_pct` = 2.0 |
| 24s aralık çok geniş | ticker high/low | `grid_max_range_width_pct` = 18 |
| Flash (15 dk) | 5m klines + flash guard | `grid_flash_drop_*` (scout’ta `flash≠none` elenir) |

Scout 24s aralığı, aday readiness’teki `range_width_min` / `range_width_max` ile **aynı eşikler**; çok dar/geniş coinler watchlist’e hiç girmez (`range24h_narrow_*` / `range24h_wide_*`).

`grid_scout_risk_filter_enabled=false` → eski davranış (sadece hacim).

Düşüş modu aktifken scout ek filtresi: 24s `priceChangePercent` &lt; `grid_market_downturn_scout_min_change_pct` (varsayılan −2) → `market_downturn_weak_symbol` (watchlist’e yazılmaz).

### Piyasa düşüş modu (yeni grid kilidi)

`setupGrids` **en başta** (manual dahil, `grid_market_downturn_allow_manual=false` varsayılan) değerlendirir:

| Sinyal | Varsayılan | `active` koşulu |
|--------|------------|-----------------|
| panic | breadth ≤35% + BTC ATR | Tek başına kilit (`market_panic`) |
| breadth_weak | watchlist breadth ≤38% | BTC 24s ≤−2,5% **veya** BTC 15m EMA9&lt;EMA21 ve 4 bar getiri ≤−0,8% ile birlikte (`market_downturn`) |

Açık gridler: flash/recovery/süpürme **devam**. Log: `GRID_MARKET_DOWNTURN` (geçiş), `GRID_WAIT` (`market_downturn` / `market_panic`).

Config: `grid_market_downturn_*` (migration `0065_grid_market_downturn.sql`).

### Readiness giriş korumaları (0067)

Kurulumdan **önce** aday uygunlukta ek kapılar (`finalizeCandidateReadiness`):

| Kapı | Config | Varsayılan | Amaç |
|------|--------|------------|------|
| `entry_band_position` | `grid_readiness_max_entry_band_pct` | 65 | Fiyat auto-range üst %65 üstündeyse hazır değil (üstten bag) |
| `medium_downside` | `medium_return_bars` / `warn_pct` | 36 / 2.5 | ~3s net düşüş (GENIUS tipi) |
| `post_exit_cooldown` | `post_exit_cooldown_*` | 45 dk | Floor veya STOP sonrası aynı coine hemen grid yok |
| `post_exit_relax` | `post_exit_relax_enabled` | **false** | Çıkış sonrası gevşetme kapalı (churn önleme) |
| `hour_decline` | `hour_decline_bars` | 12 | Son 1s (12×5m) üst üste kırmızı → scout watchlist dışı, aday tablosunda görünmez |

Deploy sonrası kalibrasyon (1–2 hafta):

```sql
SELECT json_extract(payload,'$.reason') r, COUNT(*) n
FROM trade_log WHERE event_type='GRID_WAIT'
  AND created_at >= datetime('now','-7 days') GROUP BY r;

SELECT payload, created_at FROM trade_log
WHERE event_type='GRID_MARKET_DOWNTURN' ORDER BY created_at DESC LIMIT 50;
```

`btc_24h` / `breadth_max` false-positive vs kaçırılan gün dengesine göre ince ayar.

## İzleme

- `GET /admin/api/grid` → aktif grid, aralık, spacing%, açık alış/satış, realize pnl,
  envanter, ladder (seviye + dolu/açık), **flashDrop** (level/anchor/drawdown). Admin panelinde Flash badge.
- Loglar: `GRID_SETUP`, `GRID_CYCLE` (realize), `GRID_MAINTAIN`, `GRID_INVENTORY_GUARD`,
  `GRID_STOPPED`, `GRID_ORDER_PLACE_FAILED`, `GRID_FLASH_DROP`, `GRID_FLASH_DROP_PAUSE`,
  `GRID_LADDER_BUY_SYNC`, `GRID_FLOOR_EXIT_SYNC`, `GRID_LEGACY_SELL_CANCELED`, `GRID_FLOOR_EXIT_SKIP`,
  `GRID_SETUP_SKIP` (`flash_drop_recent`, `market_panic`), `GRID_WAIT` (`market_downturn`, `market_panic`), `GRID_MARKET_DOWNTURN`.

## Araçlar

- `node scripts/grid-backtest.mjs` — tarihsel kline ile grid kâr/drawdown (walk-forward).
- `node scripts/analyze-edge.mjs` — eski sinyal kanıt analizi (referans).
- `npx tsx scripts/grid.test.mjs` — grid çekirdek birim testleri.
- `npx tsx scripts/grid-flash-drop.test.mjs` — flash guard + scout helper.
- `npx tsx scripts/grid-readiness-flash.test.mjs` — aday momentum + birleşik ready.
- `npx tsx scripts/grid-recovery-isolation.test.mjs` — recovery qty cap + setup exclude.
- `npx tsx scripts/grid-market-downturn.test.mjs` — piyasa düşüş modu eşikleri + scout zayıf coin.

### D1 migration (prod)

```bash
npx wrangler d1 execute coin-bot --remote --file=migrations/0054_grid_allow_new_while_recovering.sql
npx wrangler d1 execute coin-bot --remote --file=migrations/0055_grid_readiness_relax.sql
npm run deploy
```

**Recovery izolasyonu:** `enterRecovery` satış miktarı = `min(grid FILLED alış−satış, cüzdan free)`; `recovery_qty` kilitlenir. Paralel yeni grid ayrı `grid_id` ve `grid_orders`. `GRID_RECOVERY_OPENED` → `trackedRemaining`, `free`, `sellQty`.

## Sonraki adımlar (bu pas dışı)

- Admin Next.js sayfası: `/admin/api/grid`'i tüketen grid-ladder görseli (readiness UI yerine).
- `grid-shadow` resolver: paper `GRID_CYCLE`'lardan net EV raporu + otomatik `live_gate` önerisi.
- Eski tick/micro/momentum kodunun kaldırılması (grid canlıda kanıtlandıktan sonra).
