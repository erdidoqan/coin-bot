# coin-bot — Binance Scanner & Sniper (Cloudflare Worker + D1)

15 dakikalık **Gözcü** watchlist üretir; dakikalık **Tetikçi** pullback girişi ve trailing stop yönetir.

## Ön koşullar

- Node.js 20+
- Binance API key (Spot trade; withdraw kapalı)
- `TRADING_ENABLED=false` ile başlayın (tüm emirler `MOCK_ORDER`)

### Dry-run simülasyonu

`TRADING_ENABLED=false` iken emirler gerçek Binance’e gitmez; akış simüle edilir:

1. **MARKET BUY** — anında `FILLED` (güncel fiyattan hacim hesabı)
2. **TAKE_PROFIT + stopPrice + trailingDelta** (çift kademeli) — maliyet +`trailing_activation_pct`%’e kadar uyku; sonra zirveden `trailing_tight_callback_pct`% düşünce satış
3. **Kapanış** — dar takip tetiklenince **veya** `MOCK_MAX_HOLD_MINUTES` (varsayılan 240) dolunca trailing `FILLED` → `POSITION_CLOSED` → `IDLE`

Karşılaştırma: `npm run simulate:exit`

Loglarda `MOCK_TRAILING_FILLED` ile simüle kapanışı görürsünüz. Stablecoin gibi düşük volatilitede süre dolunca kapanır.

## Kurulum

```bash
npm install
cp .dev.vars.example .dev.vars
# .dev.vars içine BINANCE_API_KEY ve BINANCE_API_SECRET ekleyin
```

## Lokal D1 + cron testi (deploy öncesi)

```bash
npm run db:migrate:local
npm run dev
```

### Manuel tetikleme (önerilen)

`.dev.vars` içine `TRIGGER_SECRET` ekleyin, sonra:

```bash
# Gözcü — watchlist doldurur
curl -X POST "http://localhost:8787/trigger?job=scout" \
  -H "X-Trigger-Secret: local-dev-secret-change-me"

# Tetikçi (IDLE iken)
curl -X POST "http://localhost:8787/trigger?job=sniper" \
  -H "X-Trigger-Secret: local-dev-secret-change-me"

# Gözcü + sniper/reconcile zinciri
curl -X POST "http://localhost:8787/trigger?job=all" \
  -H "X-Trigger-Secret: local-dev-secret-change-me"
```

Production (`https://coin-bot.digitexa.workers.dev`) için önce:

```bash
npx wrangler secret put TRIGGER_SECRET
npx wrangler deploy
```

### Cron (production)

- `*/15 * * * *` — yalnızca Gözcü
- `* * * * *` — Tetikçi veya reconcile

Hesapta **toplam 5 cron** limiti; deploy öncesi diğer Worker cron'larını kontrol edin.

### D1 dinamik ayarlar (redeploy gerekmez)

Tüm strateji parametreleri `bot_config` tablosunda; `wrangler.toml` yalnızca fallback.

| D1 `key` | Varsayılan | Açıklama |
|----------|------------|----------|
| `buy_quote_usdt` | 175 | Market alım USDT |
| `pullback_tolerance_pct` | 0.5 | SMA yakınlık % |
| `trailing_activation_pct` | 1.5 | Kâr bölgesi aktivasyon % (stopPrice) |
| `trailing_tight_callback_pct` | 0.5 | Aktivasyon sonrası dar takip % |
| `hard_stop_loss_pct` | 4 | Sabit zarar kes % |
| `stable_max_volatility_pct` | 0.1 | Gözcü min 24s volatilite % |

### Mikro-scalp strateji (varsayılan)

`micro_scalp_enabled=true` iken:

- **Gözcü:** ~80 yüksek hacimli USDT çifti (spread + hacim filtresi); `MarketDataDO` WebSocket `depth20@100ms`
- **Tetikçi:** Dakikada 8 sembol tarama; kapalı 1m mum + trend/hacim/orderbook skoru; en yüksek skor giriş
- **Çıkış:** ATR’ye göre dinamik TP/SL; max hold 15 dk; sinyal kaybında erken çıkış
- **Faz 2:** 15m trend gate, 5m yapı, aggression + trade_count_ratio, OB persistence
- **Faz 3:** BTC 15m + breadth → market regime (`chop`/`panic`’te giriş yok)
- **ML:** `trade_features` tablosu; offline clustering (`scripts/export-trade-features.mjs`)

| D1 `key` | Varsayılan | Açıklama |
|----------|------------|----------|
| `micro_scalp_enabled` | true | false → eski hibrit/pullback |
| `hybrid_enabled` | false | Eski continuation scalp |
| `micro_entry_min_score` | 0.75 | Min bileşik skor |
| `micro_universe_size` | 80 | Watchlist evreni |
| `micro_min_quote_volume_usdt` | 50000000 | Min 24h hacim |
| `scalp_max_hold_minutes` | 15 | Zorunlu çıkış süresi |
| `scalp_fee_roundtrip_pct` | 0.20 | Fee tahmini (net TP gate) |
| `micro_phase2_enabled` | true | MTF + orderflow |
| `micro_phase3_enabled` | true | Market regime |

Loglar: `MICRO_SCORE_SCAN`, `MICRO_SCORE_PASS`, `MICRO_BEST_PICK`, `MARKET_REGIME`, `SCALP_ENTER`, `SCALP_EXIT_*`.

```bash
npm run test:micro-scalp
npm run db:migrate:remote   # 0013_micro_scalp + DO migration
```

### Eski hibrit (continuation)

`micro_scalp_enabled=false` ve `hybrid_enabled=true` ile önceki 6 pencereli continuation devreye girer.

```bash
npx wrangler d1 execute coin-bot-db --remote --command \
  "UPDATE bot_config SET value='200', updated_at=datetime('now') WHERE key='buy_quote_usdt'"

npx wrangler d1 execute coin-bot-db --remote --command \
  "UPDATE bot_config SET value='0.8', updated_at=datetime('now') WHERE key='pullback_tolerance_pct'"

npx wrangler d1 execute coin-bot-db --remote --command \
  "UPDATE bot_config SET value='2', updated_at=datetime('now') WHERE key='trailing_activation_pct'"
```

## Admin panel

**URL:** https://coin.digitexa.com/admin  
**Giriş:** `TRIGGER_SECRET` (aynı değer `wrangler secret put TRIGGER_SECRET`)

```bash
npm run build:admin   # Next.js → public/admin
npm run deploy        # build:admin + wrangler deploy
```

**Lokal geliştirme:**

```bash
# Terminal 1 — Worker
npm run dev

# Terminal 2 — Next admin UI
cd admin && NEXT_PUBLIC_API_BASE=http://localhost:8787 npm run dev
# http://localhost:3000/admin/login/
```

Panel: dashboard, trade log, D1 config düzenleme, manuel job tetikleme, state reset.

DNS: `coin` CNAME → Workers; `wrangler.toml` içinde `coin.digitexa.com` route tanımlı.

## Binance sabit IP proxy (Worker → VPS/VPN)

Binance API **Trusted IP** gerektirir; Worker çıkış IP’si sabit değildir. Çözüm: yalnızca Binance `fetch` istekleri küçük bir **forward proxy** üzerinden gider (imza ve secret hâlâ Worker’da).

```mermaid
flowchart LR
  Worker[coin-bot Worker]
  Proxy[VPS/VPN sabit IP]
  Binance[api.binance.com]
  Worker -->|POST /forward + secret| Proxy
  Proxy --> Binance
```

### 1. Proxy sunucusu (çıkış IP = Binance whitelist)

Sunucuda (VPN/VPS; `curl -s ifconfig.me` = whitelist’teki IP):

```bash
export PROXY_SECRET="uzun-rastgele-secret"
export PORT=8788
node proxy/server.mjs
```

Firewall: yalnızca Cloudflare’den veya kendi IP’nizden `8788` açın (tercihen auth + IP kısıtı).

### 2. Worker secret’ları

```bash
npx wrangler secret put BINANCE_PROXY_URL    # https://SUNUCU:8788
npx wrangler secret put BINANCE_PROXY_SECRET # PROXY_SECRET ile aynı
```

Lokal `.dev.vars` içine de aynı satırları ekleyin; `npm run dev` yeniden başlatın.

### 3. Test

```bash
curl -s "https://coin.digitexa.com/admin/api/binance-test" \
  -H "X-Trigger-Secret: ..."
# signed.ok: true ve binanceProxy dolu olmalı
```

**Not:** Ticari VPN uygulaması (sadece bilgisayarınızda) sunucu barındırmaz; proxy’nin çalışacağı **VPS veya kendi sunucunuz** gerekir, çıkış IP’si `54.93.62.147` gibi whitelist’te olmalı.

## Finansal matematik

`bignumber.js` — `stepSize` yuvarlama, komisyon düşümü, PnL (`src/math/decimal.ts`).

## Deploy

1. `wrangler d1 create coin-bot-db` → `database_id` değerini `wrangler.toml` içine yazın
2. `wrangler secret put BINANCE_API_KEY` / `BINANCE_API_SECRET`
3. `npm run db:migrate:remote`
4. Dry-run loglarını doğrulayın
5. Yalnızca onay sonrası: `TRADING_ENABLED=true`

## Ortam değişkenleri

| Değişken | Varsayılan | Açıklama |
|----------|------------|----------|
| `TRADING_ENABLED` | `false` | `true` olunca gerçek emir (yalnızca wrangler) |
| `BUY_QUOTE_USDT` vb. | — | **D1 `bot_config` öncelikli**; wrangler fallback |
| `BINANCE_BASE_URL` | mainnet | API base URL |
| `BINANCE_PROXY_URL` | — | Sabit IP forward proxy tabanı |
| `BINANCE_PROXY_SECRET` | — | Proxy `X-Proxy-Secret` |
# coin-bot
