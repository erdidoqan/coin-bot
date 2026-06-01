import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

async function main() {
  const { parseKlineEvent, KlineStore } = await import(
    join(root, 'src/durable-objects/kline-store.ts')
  );
  const { parseDepthMessage } = await import(join(root, 'src/durable-objects/depth-parse.ts'));
  const { buildMarketStreams } = await import(
    join(root, 'src/durable-objects/ws-connection-pool.ts')
  );
  const { detectMarketRegime } = await import(join(root, 'src/indicators/market-regime.ts'));

  const closedEvent = {
    stream: 'btcusdt@kline_1m',
    data: {
      e: 'kline',
      s: 'BTCUSDT',
      k: {
        t: 1_700_000_000_000,
        T: 1_700_000_059_999,
        o: '100',
        h: '101',
        l: '99',
        c: '100.5',
        v: '10',
        n: 100,
        x: true,
        q: '1000',
        V: '5',
        Q: '500',
      },
    },
  };

  const parsed = parseKlineEvent(closedEvent, 'btcusdt@kline_1m');
  assert.ok(parsed);
  assert.equal(parsed.symbol, 'BTCUSDT');
  assert.equal(parsed.interval, '1m');
  assert.equal(parsed.closed, true);

  const store = new KlineStore();
  store.onKline(parsed.symbol, parsed.interval, parsed.kline, parsed.closed);
  const buf = store.getForScoring('BTCUSDT', '1m', 5);
  assert.equal(buf.length, 1);
  assert.equal(buf[0].close, '100.5');

  const openEvent = {
    ...closedEvent,
    data: {
      ...closedEvent.data,
      k: { ...closedEvent.data.k, x: false, c: '100.8', t: 1_700_000_060_000, T: 1_700_000_119_999 },
    },
  };
  const openParsed = parseKlineEvent(openEvent, 'btcusdt@kline_1m');
  store.onKline(openParsed.symbol, openParsed.interval, openParsed.kline, openParsed.closed);
  const withOpen = store.getSeries('BTCUSDT', '1m', 5, true);
  assert.equal(withOpen.length, 2);
  const closedOnly = store.getSeries('BTCUSDT', '1m', 5, false);
  assert.equal(closedOnly.length, 1);

  const streams = buildMarketStreams(['BTCUSDT', 'ETHUSDT']);
  assert.ok(streams.some((s) => s === 'btcusdt@bookTicker'));
  assert.ok(streams.some((s) => s.startsWith('btcusdt@kline_1m')));
  assert.ok(!streams.includes('!ticker@arr'));

  const partialDepth = parseDepthMessage(
    {
      lastUpdateId: 1,
      bids: [['2.05', '100']],
      asks: [['2.06', '80']],
    },
    'nearusdt@depth20@100ms',
  );
  assert.ok(partialDepth);
  assert.equal(partialDepth.symbol, 'NEARUSDT');
  assert.equal(partialDepth.bids[0][0], '2.05');

  const diffDepth = parseDepthMessage(
    {
      e: 'depthUpdate',
      s: 'NEARUSDT',
      b: [['2.05', '50']],
      a: [['2.06', '40']],
    },
    'nearusdt@depth',
  );
  assert.ok(diffDepth);
  assert.equal(diffDepth.symbol, 'NEARUSDT');

  const klines = [];
  for (let i = 0; i < 30; i++) {
    klines.push({
      openTime: i * 900_000,
      open: '100',
      high: '102',
      low: '98',
      close: i % 2 === 0 ? '101' : '99',
      volume: '100',
      closeTime: i * 900_000 + 899_000,
      numberOfTrades: 50,
      takerBuyBaseVolume: '50',
      takerBuyQuoteVolume: '5000',
    });
  }
  const regime = detectMarketRegime({ btcKlines15m: klines, breadthPct: '55' });
  assert.ok(['trend', 'chop', 'panic', 'low_liquidity'].includes(regime.regime));

  console.log('market-data-do.test.mjs: OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
