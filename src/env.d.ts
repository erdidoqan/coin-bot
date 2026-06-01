import type { MarketDataDO } from './durable-objects/market-data-do';

declare global {
  interface Env {
    DB: D1Database;
    ASSETS: Fetcher;
    MARKET_DATA?: DurableObjectNamespace<MarketDataDO>;
    TRADING_ENABLED: string;
    BINANCE_BASE_URL: string;
    BINANCE_API_KEY?: string;
    BINANCE_API_SECRET?: string;
    /** Sabit IP forward proxy (ör. https://proxy.example.com:8788) */
    BINANCE_PROXY_URL?: string;
    BINANCE_PROXY_SECRET?: string;
    TRIGGER_SECRET?: string;
    /** DO → Worker tick-fire callback (ör. https://coin.digitexa.com) */
    WORKER_PUBLIC_URL?: string;
    HARD_STOP_LOSS_PCT?: string;
    STABLE_MAX_VOLATILITY_PCT?: string;
    BUY_QUOTE_USDT?: string;
    PULLBACK_TOLERANCE_PCT?: string;
    TRAILING_ACTIVATION_PCT?: string;
    TRAILING_TIGHT_CALLBACK_PCT?: string;
    /** Dry-run: trailing simülasyonunda zorunlu kapanış süresi (dakika). Varsayılan 240. */
    MOCK_MAX_HOLD_MINUTES?: string;
  }
}

export {};
