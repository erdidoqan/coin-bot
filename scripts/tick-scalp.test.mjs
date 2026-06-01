import assert from 'node:assert/strict';
import {
  evaluateTickEntry,
  evaluateTick5mGate,
  gainFromRefPct,
  passesTickGainBand,
} from '../src/indicators/tick-entry.ts';
import { peak1hFromOpenHigh } from '../src/jobs/scout-1h-peak.ts';
import {
  appendMidSample,
  evaluateWsDecline,
  defaultTickDeclineConfig,
} from '../src/indicators/tick-decline.ts';

const candle = {
  openTime: 1,
  open: '100',
  high: '102',
  low: '100',
  close: '101.4',
  volume: '1000',
  closeTime: 2,
  numberOfTrades: 10,
  takerBuyBaseVolume: '500',
  takerBuyQuoteVolume: '50000',
};

function rising5mCloses(n = 25, start = 100) {
  const klines = [];
  for (let i = 0; i < n; i++) {
    const p = start + i * 0.05;
    klines.push({
      openTime: i * 300_000,
      open: String(p),
      high: String(p + 0.1),
      low: String(p - 0.05),
      close: String(p + 0.08),
      volume: '100',
      closeTime: i * 300_000 + 299_000,
      numberOfTrades: 10,
      takerBuyBaseVolume: '50',
      takerBuyQuoteVolume: '5000',
    });
  }
  return klines;
}

assert.equal(gainFromRefPct('100', '100.01'), '0.0100');
assert.ok(passesTickGainBand('0.03', '0.01', '0.06'));
assert.ok(passesTickGainBand('0.0532', '0.01', '0.06'));
assert.ok(!passesTickGainBand('0.12', '0.01', '0.06'));
assert.ok(!passesTickGainBand('0.005', '0.01', '0.06'));

const k5 = rising5mCloses();
const gate5m = evaluateTick5mGate(k5, '102', {
  candle: { ...k5[k5.length - 1], open: '101.5', close: '102' },
  isClosed: false,
});
assert.equal(gate5m.aligned, true);

const fail5m = evaluateTick5mGate(k5, '99', {
  candle: { ...k5[k5.length - 1], open: '101' },
  isClosed: false,
});
assert.equal(fail5m.failReason, 'mid_below_5m_ema21');

const candleBand = {
  ...candle,
  open: '100',
  low: '100',
  high: '100.04',
  close: '100.03',
};

const pass = evaluateTickEntry({
  candle: candleBand,
  candleIsClosed: false,
  mid: '100.03',
  orderbook: { bidAskRatio: 1.1, spreadPct: 0.05, updatedAt: Date.now(), stale: false },
  config: {
    minGainPct: '0.01',
    maxGainPct: '0.06',
    minOrderbookRatio: 1.05,
    maxSpreadPct: '0.08',
    maxObAgeMs: 30_000,
    requireOpenCandle: true,
    require5mAlignment: false,
  },
});
assert.equal(pass.pass, true);

const candle1h = {
  openTime: 1,
  open: '100',
  high: '100.6',
  low: '99.8',
  close: '100.55',
  volume: '100',
  closeTime: 2,
  numberOfTrades: 10,
  takerBuyBaseVolume: '50',
  takerBuyQuoteVolume: '5000',
};
assert.equal(Number(peak1hFromOpenHigh([candle1h])), 0.6);

const candle1hNoPeak = { ...candle1h, high: '100.2' };
assert.ok(Number(peak1hFromOpenHigh([candle1hNoPeak])) < 0.5);

const failLate = evaluateTickEntry({
  candle: candleBand,
  candleIsClosed: false,
  mid: '100.08',
  orderbook: { bidAskRatio: 1.1, spreadPct: 0.05, updatedAt: Date.now(), stale: false },
  config: {
    minGainPct: '0.01',
    maxGainPct: '0.06',
    minOrderbookRatio: 1.05,
    maxSpreadPct: '0.08',
    maxObAgeMs: 30_000,
    requireOpenCandle: true,
    require5mAlignment: false,
  },
});
assert.equal(failLate.failReason, 'gain_above_max_opportunity_missed');

const fail5mEntry = evaluateTickEntry({
  candle,
  candleIsClosed: false,
  candle5m: { candle: { ...k5[0], open: '200' }, isClosed: false },
  klines5m: k5,
  mid: '100.02',
  orderbook: { bidAskRatio: 1.1, spreadPct: 0.05, updatedAt: Date.now(), stale: false },
  config: {
    minGainPct: '0.01',
    maxGainPct: '0.06',
    minOrderbookRatio: 1.05,
    maxSpreadPct: '0.08',
    maxObAgeMs: 30_000,
    requireOpenCandle: true,
    require5mAlignment: true,
  },
});
assert.equal(fail5mEntry.pass, false);
assert.ok(fail5mEntry.failReason?.includes('5m') || fail5mEntry.trend5mFailReason);

const now = Date.now();
let samples = [];
for (let i = 0; i < 90; i++) {
  const t = now - (90 - i) * 1000;
  const mid = i < 60 ? 100 - i * 0.01 : 99.4 + (i - 60) * 0.002;
  samples = appendMidSample(samples, mid, t, 300_000);
}
const declinePass = evaluateWsDecline({
  samples,
  currentMid: '99.42',
  config: { ...defaultTickDeclineConfig(), minDeclinePct: '0.05' },
  nowMs: now,
});
assert.equal(declinePass.ok, true);
assert.ok(Number(declinePass.declinePct) >= 0.05);

const flatSamples = appendMidSample([], 100, now - 5000, 300_000);
const declineFail = evaluateWsDecline({
  samples: flatSamples,
  currentMid: '100.02',
  config: defaultTickDeclineConfig(),
  nowMs: now,
});
assert.equal(declineFail.failReason, 'insufficient_ws_samples');

console.log('tick-scalp.test.mjs ok');
