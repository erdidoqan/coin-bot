/**
 * SUI örneği: tek kademe vs çift kademe PnL karşılaştırması.
 */
const QTY = 18.2;
const AVG_COST = 1.0978;
const TIGHT_PCT = 0.5;
const OLD_CALLBACK_PCT = 1.5;

const buyFill = 1.1062;
const peak = 1.1269;
const tieredSell = peak * (1 - TIGHT_PCT / 100);
const oldSell = buyFill * (1 - OLD_CALLBACK_PCT / 100);
const activationStop = AVG_COST * (1 + 1.5 / 100);

function pnl(sellPrice) {
  return (sellPrice - AVG_COST) * QTY;
}

console.log('--- Çift kademeli trailing çıkış simülasyonu (SUI) ---');
console.log(`Miktar: ${QTY} | Maliyet: ${AVG_COST} USDT`);
console.log(`Aktivasyon +1.5% → stopPrice ~${activationStop.toFixed(4)}`);
console.log(`Zirve: ${peak} | Dar takip -${TIGHT_PCT}% → satış ~${tieredSell.toFixed(4)}`);
console.log('');
console.log(`Eski tek kademe (zirve ${buyFill}, -${OLD_CALLBACK_PCT}%): satış ~${oldSell.toFixed(4)}`);
console.log(`  PnL: ${pnl(oldSell).toFixed(4)} USDT`);
console.log('');
console.log(`Yeni iki kademe (zirve ${peak}, -${TIGHT_PCT}%): satış ~${tieredSell.toFixed(4)}`);
console.log(`  PnL: ${pnl(tieredSell).toFixed(4)} USDT`);
console.log('');
console.log(`Fark (yeni − eski): ${(pnl(tieredSell) - pnl(oldSell)).toFixed(4)} USDT`);
