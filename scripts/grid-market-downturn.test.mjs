import assert from 'node:assert';
import {
  evaluateGridMarketDownturn,
  filterPoolForMarketDownturn,
} from '../src/strategy/grid-market-downturn.ts';

let passed = 0;
function t(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

const baseRegime = {
  regime: 'trend',
  btcAtrPct: '0.8',
  breadthPct: '50.00',
  detail: { breadth: 50, ema9Above21: true },
};

const th = {
  breadthWeakMaxPct: 38,
  btc24hPct: -2.5,
  btc15mReturnPct: -0.8,
  btc15mReturnBars: 4,
  blockPanic: true,
};

function klinesFromCloses(closes) {
  return closes.map((c) => ({
    open: c,
    high: c,
    low: c,
    close: c,
    volume: 1,
    openTime: 0,
    closeTime: 0,
  }));
}

t('disabled → inactive', () => {
  const r = evaluateGridMarketDownturn({
    enabled: false,
    regime: baseRegime,
    btcKlines15m: klinesFromCloses([100, 100, 100, 100, 100]),
    btc24hChangePct: -5,
    thresholds: th,
  });
  assert.equal(r.active, false);
});

t('panic regime → active', () => {
  const r = evaluateGridMarketDownturn({
    enabled: true,
    regime: { ...baseRegime, regime: 'panic' },
    btcKlines15m: klinesFromCloses([100, 100, 100, 100, 100]),
    btc24hChangePct: 0,
    thresholds: th,
  });
  assert.equal(r.active, true);
  assert.ok(r.reasons.includes('panic'));
});

t('breadth weak alone → inactive', () => {
  const r = evaluateGridMarketDownturn({
    enabled: true,
    regime: { ...baseRegime, breadthPct: '30.00' },
    btcKlines15m: klinesFromCloses([100, 101, 102, 103, 104]),
    btc24hChangePct: 1,
    thresholds: th,
  });
  assert.equal(r.active, false);
});

t('breadth weak + btc 24h drawdown → active', () => {
  const r = evaluateGridMarketDownturn({
    enabled: true,
    regime: { ...baseRegime, breadthPct: '35.00' },
    btcKlines15m: klinesFromCloses([100, 101, 102, 103, 104]),
    btc24hChangePct: -3,
    thresholds: th,
  });
  assert.equal(r.active, true);
  assert.ok(r.reasons.includes('breadth_weak'));
  assert.ok(r.reasons.includes('btc_24h_drawdown'));
});

t('breadth weak + btc 15m bearish → active', () => {
  const closes = [100, 99, 98, 97, 96, 95];
  const r = evaluateGridMarketDownturn({
    enabled: true,
    regime: { ...baseRegime, breadthPct: '20.00' },
    btcKlines15m: klinesFromCloses(closes),
    btc24hChangePct: 0,
    thresholds: th,
  });
  assert.equal(r.active, true);
  assert.ok(r.reasons.includes('btc_15m_bearish'));
});

t('scout pool filters weak symbols in downturn', () => {
  const downturn = { active: true, reasons: ['breadth_weak'], metrics: {}, regime: baseRegime };
  const pool = [
    { symbol: 'AAAUSDT', priceChangePercent: -5 },
    { symbol: 'BBBUSDT', priceChangePercent: 1 },
  ];
  const { kept, rejected } = filterPoolForMarketDownturn(pool, downturn, -2);
  assert.deepEqual(kept.map((x) => x.symbol), ['BBBUSDT']);
  assert.equal(rejected[0].reason, 'market_downturn_weak_symbol');
});

console.log(`\n${passed} passed`);
if (passed < 6) process.exit(1);
