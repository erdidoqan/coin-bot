# Binance forward proxy (VPS)

Sunucuda yalnızca `server.mjs` + `env` + systemd user unit. Mevcut PHP/nginx sitelere dokunulmaz.

## Sunucu (193.35.204.166)

- Dizin: `~/coin-bot-proxy/`
- Dinleme: `127.0.0.1:18788` (dışarıdan yalnızca nginx)
- Nginx: `/etc/nginx/sites-enabled/coin-bot-proxy.conf` (ayrı vhost)
- Servis: `systemctl --user status coin-bot-proxy`

## DNS (zorunlu)

Cloudflare / digitexa.com:

| Tip | Ad | Değer | Proxy |
|-----|-----|--------|-------|
| A | `coin-proxy` | `193.35.204.166` | **DNS only** (gri bulut) |

Worker IP adresine değil **hostname** ile bağlanır.

## Binance

API Trusted IPs → **`193.35.204.166`** (VPN IP değil; sunucunun çıkış IP’si).

## HTTPS (opsiyonel)

```bash
sudo certbot --nginx -d coin-proxy.digitexa.com
```

Sonra Worker secret: `BINANCE_PROXY_URL=https://coin-proxy.digitexa.com`
