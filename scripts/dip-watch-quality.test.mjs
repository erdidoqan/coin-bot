import assert from 'node:assert';
import {
  spreadPctFromBook,
  quoteDepthWithinBand,
  passesOrderBookDepth,
  volMcapRatio,
  passesVolMcapRatio,
  passesListingAge,
  passesCirculatingSupplyPct,
  passesFdvToMcap,
  evaluateDipWatchQuality,
} from '../src/strategy/dip-watch-quality.ts';

let passed = 0;
function t(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

const cfg = {
  enabled: true,
  minListingDays: 30,
  maxSpreadPct: 0.25,
  depthBandPct: 2,
  minDepthQuoteUsdt: 25_000,
  maxVolMcapRatio: 1.2,
  minCirculatingSupplyPct: 20,
  maxFdvToMcapRatio: 5,
};

t('spread dar geçer, geniş elenir', () => {
  const tight = spreadPctFromBook(100, 100.1);
  const wide = spreadPctFromBook(100, 101);
  assert.ok(tight != null && tight < 0.25);
  assert.ok(wide != null && wide > 0.25);
});

t('derinlik ±2% bandı', () => {
  const mid = 100;
  const { bidQuoteUsdt, askQuoteUsdt } = quoteDepthWithinBand(
    mid,
    [{ price: '99', qty: '1000' }],
    [{ price: '101', qty: '1000' }],
    2,
  );
  assert.ok(passesOrderBookDepth(bidQuoteUsdt, askQuoteUsdt, 50_000));
});

t('vol/mcap > 1.2 elenir', () => {
  assert.equal(volMcapRatio(1_200_000, 1_000_000), 1.2);
  assert.equal(passesVolMcapRatio(1.5, 1.2), false);
});

t('düşük dolaşım oranı elenir', () => {
  assert.equal(passesCirculatingSupplyPct(10, 100, 20), false);
  assert.equal(passesCirculatingSupplyPct(25, 100, 20), true);
});

t('evaluate: spread fail', () => {
  const r = evaluateDipWatchQuality({
    cfg,
    spreadPct: 0.5,
    bidDepthUsdt: 100_000,
    askDepthUsdt: 100_000,
    onboardMs: Date.now() - 60 * 86400_000,
    quoteVolume24h: 1e6,
    marketCapUsd: 50e6,
    circulatingSupply: 50,
    maxSupply: 100,
    fdvUsd: 60e6,
    skipDepthCheck: true,
  });
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'spread');
});

console.log(`\n${passed} passed`);
if (passed < 5) process.exit(1);
