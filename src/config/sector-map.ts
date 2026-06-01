/** Basit sektor etiketleri — Faz 4 çift pozisyon filtresi için. */

const SECTOR_RULES: Array<{ match: RegExp; tag: string }> = [
  { match: /^(PEPE|DOGE|SHIB|FLOKI|BONK|PENGU|WIF|MEME)/i, tag: 'meme' },
  { match: /^(RENDER|FET|TAO|NEAR|ICP|INJ|AI)/i, tag: 'ai' },
  { match: /^(BTC|ETH|SOL|BNB|ADA|AVAX|SUI|DOT|ATOM)/i, tag: 'l1' },
  { match: /^(UNI|AAVE|MKR|CRV)/i, tag: 'defi' },
];

export function sectorTagForSymbol(symbol: string): string {
  const base = symbol.endsWith('USDT') ? symbol.slice(0, -4) : symbol;
  for (const r of SECTOR_RULES) {
    if (r.match.test(base)) return r.tag;
  }
  return 'other';
}
