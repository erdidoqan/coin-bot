import assert from 'node:assert';
import { selectStrategy } from '../src/strategy/strategy-router.ts';

const THR = {
  momentumBreadthMin: 50,
  dipBreadthMin: 20,
  volatileAtrMin: 0.8,
  killAtrMult: 1.0,
  momentumAtrMult: 0.4,
  recoverAtrMult: 0.3,
};

let passed = 0;
function t(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

t('zayıf breadth → pause', () => {
  const d = selectStrategy(
    { btcM15Pct: 0.5, btcM30Pct: 0.6, btcM60Pct: 1, atrPct: 0.8, breadthPct: 10 },
    THR,
  );
  assert.equal(d.strategy, 'pause');
  assert.equal(d.reason, 'weak_breadth_riskoff');
});

t('süren sert satış → pause (intraday kill-switch)', () => {
  // m30 = -1.2 <= -0.8*1.0 ve m15 negatif
  const d = selectStrategy(
    { btcM15Pct: -0.5, btcM30Pct: -1.2, btcM60Pct: -2, atrPct: 0.8, breadthPct: 40 },
    THR,
  );
  assert.equal(d.strategy, 'pause');
  assert.equal(d.reason, 'intraday_selloff');
});

t('hizalı yükseliş + geniş katılım → momentum', () => {
  // m15>0, m30=0.5 >= 0.8*0.4=0.32, breadth>=50
  const d = selectStrategy(
    { btcM15Pct: 0.3, btcM30Pct: 0.5, btcM60Pct: 0.9, atrPct: 0.8, breadthPct: 60 },
    THR,
  );
  assert.equal(d.strategy, 'momentum');
  assert.equal(d.reason, 'intraday_uptrend');
});

t('m30 yatay ama m15+m60 güçlü (büyük resim yukarı) → momentum', () => {
  // Gerçek vaka: m15 +0.41, m30 +0.24 (eşik altı), m60 +0.34 → ort 0.33 >= 0.32
  const d = selectStrategy(
    { btcM15Pct: 0.41, btcM30Pct: 0.24, btcM60Pct: 0.34, atrPct: 0.8, breadthPct: 77 },
    THR,
  );
  assert.equal(d.strategy, 'momentum');
});

t('yukarı ama breadth yetersiz → momentum değil', () => {
  const d = selectStrategy(
    { btcM15Pct: 0.3, btcM30Pct: 0.5, btcM60Pct: 0.9, atrPct: 0.8, breadthPct: 35 },
    THR,
  );
  assert.notEqual(d.strategy, 'momentum');
});

t('düştü ama toparlanıyor + volatil → dip_reversal', () => {
  // m30<0, m15=0.3 >= 0.8*0.3=0.24, atr>=0.8
  const d = selectStrategy(
    { btcM15Pct: 0.3, btcM30Pct: -0.6, btcM60Pct: -1, atrPct: 0.9, breadthPct: 40 },
    THR,
  );
  assert.equal(d.strategy, 'dip_reversal');
  assert.equal(d.reason, 'dip_recovery');
});

t('düştü, toparlanma zayıf → pause', () => {
  // m15=0.1 < 0.24 eşik
  const d = selectStrategy(
    { btcM15Pct: 0.1, btcM30Pct: -0.6, btcM60Pct: -1, atrPct: 0.9, breadthPct: 40 },
    THR,
  );
  assert.equal(d.strategy, 'pause');
});

t('dip toparlanma ama düşük volatilite → pause (flash yok)', () => {
  const d = selectStrategy(
    { btcM15Pct: 0.3, btcM30Pct: -0.4, btcM60Pct: -0.5, atrPct: 0.5, breadthPct: 40 },
    THR,
  );
  assert.equal(d.strategy, 'pause');
});

t('yatay/belirsiz → pause', () => {
  const d = selectStrategy(
    { btcM15Pct: 0.05, btcM30Pct: 0.1, btcM60Pct: 0.1, atrPct: 0.8, breadthPct: 45 },
    THR,
  );
  assert.equal(d.strategy, 'pause');
  assert.equal(d.reason, 'no_clear_regime');
});

t('ATR yoksa fallback ile çalışır (momentum)', () => {
  const d = selectStrategy(
    { btcM15Pct: 0.4, btcM30Pct: 0.5, btcM60Pct: 0.8, atrPct: null, breadthPct: 60 },
    THR,
  );
  assert.equal(d.strategy, 'momentum');
});

t('veri yok (tüm momentum null) + iyi breadth → pause', () => {
  const d = selectStrategy(
    { btcM15Pct: null, btcM30Pct: null, btcM60Pct: null, atrPct: 0.8, breadthPct: 60 },
    THR,
  );
  // m15=0,m30=0 → momentum değil, dip değil → pause
  assert.equal(d.strategy, 'pause');
});

console.log(`\n${passed} test geçti.`);
