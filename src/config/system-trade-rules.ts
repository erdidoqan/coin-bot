const SYSTEM_BLOCKED_SYMBOLS = new Set<string>([
  'BNBUSDT',
  // BTC bizim LİDER/REFERANSIMIZ — asla alım hedefi değil. DO BTC'yi her zaman stream eder
  // (market-data-do setSymbols force-include), bu yüzden bloklamak streaming/rejim/BTC-lider
  // referansını bozmaz; sadece dip/scalp'in BTC'yi satın almasını engeller (7.5s takılan
  // düşük-vol BTC pozisyonu tüm botu IDLE değil diye kilitlemişti).
  'BTCUSDT',
  // Non-ASCII (Çince "Binance Life") düşük güvenli meme token; scout havuzuna sızıyor.
  '币安人生USDT',
]);

function normalizeSymbol(symbol: string | null | undefined): string | null {
  if (typeof symbol !== 'string') return null;
  const normalized = symbol.trim().toUpperCase();
  return normalized.length > 0 ? normalized : null;
}

export function isSystemTradeBlockedSymbol(symbol: string | null | undefined): boolean {
  const normalized = normalizeSymbol(symbol);
  return normalized ? SYSTEM_BLOCKED_SYMBOLS.has(normalized) : false;
}

export function listSystemTradeBlockedSymbols(): string[] {
  return [...SYSTEM_BLOCKED_SYMBOLS];
}
