import assert from 'node:assert';
import {
  passesScoutTickerRisk,
  passesScoutHourDeclineKlines,
  ticker24hRangePct,
  scoutRiskConfigFromGrid,
} from '../src/strategy/grid-scout-filter.ts';

let passed = 0;
function t(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

const riskCfg = scoutRiskConfigFromGrid({
  scoutRiskFilterEnabled: true,
  scoutMaxAbsChangePct: 12,
  minRangeWidthPct: 2.5,
  maxRangeWidthPct: 15,
  flashDropEnabled: true,
  flashDropWarnPct: 2,
  flashDropPausePct: 3,
  flashDropRecoveryPct: 5,
  flashDropWindowMin: 15,
  flashDropMaxFills: 3,
  flashDropFillWindowMin: 10,
  flashDropOverfillMult: 1.5,
  readinessHourDeclineEnabled: true,
  readinessHourDeclineBars: 12,
});

t('ALLO benzeri ticker elenir (büyük 24s hareket)', () => {
  const allo = {
    symbol: 'ALLOUSDT',
    quoteVolume: 1e9,
    priceChangePercent: -25,
    highPrice: 0.3,
    lowPrice: 0.23,
    lastPrice: 0.24,
  };
  const r = passesScoutTickerRisk(allo, riskCfg);
  assert.equal(r.pass, false);
  assert.ok(
    r.reason?.startsWith('change_') ||
      r.reason?.startsWith('range24h_wide_') ||
      r.reason?.startsWith('range24h_narrow_'),
  );
});

t('çok geniş 24s aralık elenir (ZAMA tipi)', () => {
  const wide = {
    symbol: 'ZAMAUSDT',
    quoteVolume: 1e8,
    priceChangePercent: 5,
    highPrice: 0.045,
    lowPrice: 0.035,
    lastPrice: 0.04,
  };
  const r = passesScoutTickerRisk(wide, riskCfg);
  assert.equal(r.pass, false);
  assert.ok(r.reason?.startsWith('range24h_wide_'));
});

t('çok dar 24s aralık elenir (BTC sakin gün)', () => {
  const narrow = {
    symbol: 'BTCUSDT',
    quoteVolume: 1e10,
    priceChangePercent: 0.5,
    highPrice: 100_500,
    lowPrice: 99_800,
    lastPrice: 100_200,
  };
  const r = passesScoutTickerRisk(narrow, riskCfg);
  assert.equal(r.pass, false);
  assert.ok(r.reason?.startsWith('range24h_narrow_'));
});

t('orta aralıklı ticker geçer (dar/geniş değil)', () => {
  const calm = {
    symbol: 'BNBUSDT',
    quoteVolume: 1e9,
    priceChangePercent: 1.2,
    highPrice: 620,
    lowPrice: 600,
    lastPrice: 610,
  };
  assert.equal(passesScoutTickerRisk(calm, riskCfg).pass, true);
});

t('1s sürekli düşüş scout dışı', () => {
  const closes = Array.from({ length: 14 }, (_, i) => 10 - i * 0.1);
  const r = passesScoutHourDeclineKlines(closes, riskCfg);
  assert.equal(r.pass, false);
  assert.equal(r.reason, 'hour_decline');
});

console.log(`\n${passed} test geçti.`);
