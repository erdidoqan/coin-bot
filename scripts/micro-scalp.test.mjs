import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Minimal inline tests via dynamic import of compiled logic — run with tsx on TS modules */
async function main() {
  const { computeDynamicScalpTargets, passesMinNetTpGate } = await import(
    join(root, 'src/indicators/dynamic-scalp-targets.ts')
  );
  const { computeMicroScalpScore, evaluateTrend15m, DEFAULT_MICRO_WEIGHTS } = await import(
    join(root, 'src/indicators/micro-scalp.ts')
  );
  const { closedCandlesOnly } = await import(join(root, 'src/indicators/technical.ts'));

  const low = computeDynamicScalpTargets('0.2');
  assert.equal(low.band, 'low');
  assert.equal(low.tpGrossPct, '0.4');

  const high = computeDynamicScalpTargets('1.1');
  assert.equal(high.band, 'high');

  assert.equal(passesMinNetTpGate('0.7', '0.20', '0.25'), true);
  assert.equal(passesMinNetTpGate('0.4', '0.20', '0.25'), false);

  const now = Date.now();
  const klines = [];
  for (let i = 0; i < 25; i++) {
    const t = now - (25 - i) * 60_000;
    klines.push({
      openTime: t,
      open: '100',
      high: '101',
      low: '99',
      close: i < 24 ? '100' : '101',
      volume: i === 24 ? '500' : '100',
      closeTime: t + 59_000,
      numberOfTrades: i === 24 ? 200 : 50,
      takerBuyBaseVolume: '50',
      takerBuyQuoteVolume: i === 24 ? '40000' : '5000',
    });
  }
  const closed = closedCandlesOnly(klines, now);
  assert.ok(closed.length >= 24);

  const result = computeMicroScalpScore({
    klines1m: klines,
    orderbook: { symbol: 'TEST', bidAskRatio: 1.5, spreadPct: 0.05, persistenceScore: 0, updatedAt: now, stale: false },
    config: {
      entryMinScore: 0.5,
      volumeRatioMin: 2.2,
      orderbookRatioMin: 1.4,
      aggressionMin: 0.65,
      phase2Enabled: false,
      weights: DEFAULT_MICRO_WEIGHTS,
    },
    nowMs: now,
  });
  assert.equal(result.gates.closedCandle, false, 'open candle should fail gate');

  const closedLast = { ...klines[klines.length - 1], closeTime: now - 5000 };
  const k2 = [...klines.slice(0, -1), closedLast];
  const r2 = computeMicroScalpScore({
    klines1m: k2,
    orderbook: { symbol: 'TEST', bidAskRatio: 1.6, spreadPct: 0.05, persistenceScore: 1, updatedAt: now, stale: false },
    config: {
      entryMinScore: 0.3,
      volumeRatioMin: 2,
      orderbookRatioMin: 1.4,
      aggressionMin: 0.5,
      phase2Enabled: false,
      weights: DEFAULT_MICRO_WEIGHTS,
    },
    nowMs: now,
  });
  assert.equal(r2.gates.closedCandle, true);
  assert.ok(Number(r2.score) >= 0);

  const r3 = computeMicroScalpScore({
    klines1m: klines,
    orderbook: { symbol: 'TEST', bidAskRatio: 1.6, spreadPct: 0.05, persistenceScore: 1, updatedAt: now, stale: false },
    config: {
      entryMinScore: 0.3,
      volumeRatioMin: 2,
      orderbookRatioMin: 1.4,
      aggressionMin: 0.5,
      phase2Enabled: false,
      weights: DEFAULT_MICRO_WEIGHTS,
    },
    nowMs: now,
    skipOpenCandleGate: true,
  });
  assert.equal(r3.gates.closedCandle, true);
  assert.notEqual(r3.failReason, 'open_candle');

  const { signedScorePtsDelta, signedPctDelta, buildWatchlistMetricDeltas } = await import(
    join(root, 'src/indicators/metric-delta.ts')
  );
  assert.equal(signedScorePtsDelta('0.85', '0.94'), '+9.0');
  assert.equal(signedPctDelta('1.2', '1.5'), '+25.0');
  const d = buildWatchlistMetricDeltas({
    prevScore: '0.85',
    prevVolumeRatio: '1.2',
    prevAggressionRatio: '2.0',
    prevOrderbook: 0.8,
    score: '0.94',
    volumeRatio: '1.5',
    aggressionRatio: '1.8',
    orderbook: 0.88,
  });
  assert.equal(d.scorePts, '+9.0');
  assert.equal(d.volumePct, '+25.0');
  assert.equal(d.aggressionPct, '-10.0');

  const bearish15m = [];
  const base = 100;
  for (let i = 0; i < 25; i++) {
    const t = now - (25 - i) * 900_000;
    const close = (base - i * 0.05).toFixed(4);
    bearish15m.push({
      openTime: t,
      open: close,
      high: close,
      low: close,
      close,
      volume: '100',
      closeTime: t + 899_000,
      numberOfTrades: 50,
      takerBuyBaseVolume: '40',
    });
  }
  const t15 = evaluateTrend15m(bearish15m);
  assert.equal(t15.tier, 'strong_down');
  assert.equal(t15.hardVeto, true);

  const rPenalty = computeMicroScalpScore({
    klines1m: klines,
    klines15m: bearish15m.map((k, i) =>
      i < bearish15m.length - 3
        ? k
        : { ...k, close: String(Number(k.close) + 0.5) },
    ),
    orderbook: {
      symbol: 'TEST',
      bidAskRatio: 1.6,
      spreadPct: 0.05,
      persistenceScore: 1,
      updatedAt: now,
      stale: false,
    },
    config: {
      entryMinScore: 0.75,
      volumeRatioMin: 2,
      orderbookRatioMin: 1.4,
      aggressionMin: 0.5,
      phase2Enabled: true,
      trend15mGateMode: 'penalty',
      trend15mPenalty: 0.1,
      weights: DEFAULT_MICRO_WEIGHTS,
    },
    nowMs: now,
    skipOpenCandleGate: true,
  });
  if (rPenalty.gates.trend15mTier === 'weak_down') {
    assert.ok(Number(rPenalty.score) >= 0);
    assert.equal(rPenalty.gates.trend15mPenaltyApplied, 0.1);
  }

  console.log('micro-scalp.test.mjs: all passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
