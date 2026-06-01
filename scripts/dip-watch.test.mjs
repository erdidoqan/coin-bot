import assert from 'node:assert';
import {
  positionIn24hRangePct,
  distanceFromLowPct,
  paperPnlPct,
  buildDipScannerRows,
} from '../src/strategy/dip-watch.ts';

let passed = 0;
function t(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

t('positionIn24hRangePct: dipte 0, tepede 100', () => {
  assert.equal(positionIn24hRangePct(10, 0, 100), 10);
  assert.equal(positionIn24hRangePct(0, 0, 100), 0);
  assert.equal(positionIn24hRangePct(100, 0, 100), 100);
});

t('positionIn24hRangePct: düz aralık null', () => {
  assert.equal(positionIn24hRangePct(5, 10, 10), null);
});

t('paperPnlPct girişten yüzde', () => {
  assert.equal(paperPnlPct(100, 105), 5);
  assert.equal(paperPnlPct(100, 95), -5);
});

t('distanceFromLowPct', () => {
  assert.equal(distanceFromLowPct(110, 100), 10);
});

t('buildDipScannerRows: UUSDT gibi peg stable elenir', () => {
  const rows = buildDipScannerRows(
    [
      { symbol: 'UUSDT', lastPrice: 1.0, low24h: 0.99, high24h: 1.01, quoteVolume: 1e8 },
      { symbol: 'BTCUSDT', lastPrice: 1.02, low24h: 1, high24h: 2, quoteVolume: 1e6 },
    ],
    500_000,
    10,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].symbol, 'BTCUSDT');
});

t('buildDipScannerRows: konum eşiği yok, hacim + sıralama', () => {
  const rows = buildDipScannerRows(
    [
      { symbol: 'AAAUSDT', lastPrice: 1.02, low24h: 1, high24h: 2, quoteVolume: 1e6 },
      { symbol: 'BBBUSDT', lastPrice: 1.9, low24h: 1, high24h: 2, quoteVolume: 1e6 },
      { symbol: 'CCCUSDT', lastPrice: 1.01, low24h: 1, high24h: 2, quoteVolume: 100 },
    ],
    500_000,
    10,
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].symbol, 'AAAUSDT');
  assert.equal(rows[1].symbol, 'BBBUSDT');
});

console.log(`\n${passed} passed`);
if (passed < 6) process.exit(1);
