/** Panel gösterimi — hesaplama değil, yalnızca okunabilirlik. */

export function formatPrice(value: string): string {
  if (!value || value === '—') return value;
  const n = Number(value);
  if (!Number.isFinite(n)) return value;

  if (n >= 100) {
    return n.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  if (n >= 1) {
    return n.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  }
  return n.toLocaleString('tr-TR', { minimumFractionDigits: 4, maximumFractionDigits: 6 });
}

export function formatUsdt(value: string): string {
  if (!value || value === '—') return value;
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return n.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** DOGEUSDT → DOGE (panel etiketi; kotasyon USDT tekrarlanmaz). */
export function spotSymbolLabel(symbol: string): string {
  const s = symbol.trim().toUpperCase();
  if (s.endsWith('USDT') && s.length > 4) return s.slice(0, -4);
  return s;
}

/** Binance spot trade — örn. DOGEUSDT → …/trade/DOGE_USDT?type=spot */
export function binanceSpotTradeUrl(symbol: string): string {
  const base = spotSymbolLabel(symbol);
  return `https://www.binance.com/en/trade/${base}_USDT?type=spot`;
}
