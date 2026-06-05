import assert from 'node:assert/strict';
import {
  DIP_MANUAL_BUY_QUOTE_USDT,
  resolveDipBuyQuoteUsdt,
} from '../src/strategy/dip-reversal-quote.ts';

assert.equal(DIP_MANUAL_BUY_QUOTE_USDT, '20');
assert.equal(resolveDipBuyQuoteUsdt({ manual: true, baseQuoteUsdt: '99' }), '20');
assert.equal(
  resolveDipBuyQuoteUsdt({ baseQuoteUsdt: '30', adaptEnabled: false, adaptMode: 'calm' }),
  '30',
);
assert.equal(
  resolveDipBuyQuoteUsdt({ baseQuoteUsdt: '30', adaptEnabled: true, adaptMode: 'calm' }),
  '70',
);
assert.equal(
  resolveDipBuyQuoteUsdt({ baseQuoteUsdt: '30', adaptEnabled: true, adaptMode: 'downtrend_grind' }),
  '30',
);
assert.equal(
  resolveDipBuyQuoteUsdt({ baseQuoteUsdt: '30', adaptEnabled: true, adaptMode: 'normal' }),
  '60',
);

console.log('dip-reversal-quote.test.mjs: OK');
