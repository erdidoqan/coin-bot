import { formatPrice, formatUsdt } from './format';

export type LogTone = 'neutral' | 'success' | 'warning' | 'error' | 'info' | 'muted';

export interface LogDetail {
  label: string;
  value: string;
}

export interface FormattedLog {
  label: string;
  summary: string;
  details: LogDetail[];
  tone: LogTone;
}

const EVENT_LABELS: Record<string, string> = {
  SCOUT_RUN: 'Gözcü taraması',
  SNIPER_SKIP: 'Tetikçi atlandı',
  TICK_GAIN_SNAPSHOT: 'Tick gain özeti',
  TICK_ENTRY_SIGNAL: 'Tick giriş sinyali',
  TICK_ENTRY_GATE_FAIL: 'Tick giriş engeli',
  SIGNAL: 'Alım sinyali',
  BUY_FILLED: 'Market alım',
  NET_QTY_COMPUTED: 'Net miktar',
  TRAILING_PLACED: 'Trailing stop',
  TRAILING_REJECTED: 'Trailing reddedildi',
  MOCK_ORDER: 'Simüle emir',
  MOCK_TRAILING_FILLED: 'Simüle trailing kapanış',
  POSITION_CLOSED: 'Pozisyon kapandı',
  HARD_STOP_TRIGGERED: 'Hard stop',
  WATCHLIST_ROTATION_TRIGGERED: 'Watchlist rotasyonu',
  WATCHLIST_ROTATION_LOT_TOO_SMALL: 'Rotasyon lot küçük',
  ROTATION_SKIP: 'Rotasyon atlandı',
  TIME_STOP_TRIGGERED: 'Zaman stopu',
  TIME_STOP_LOT_TOO_SMALL: 'Zaman stopu lot',
  TIME_STOP_SELL_FAILED: 'Zaman stopu satış hatası',
  SNIPER_SKIP_COOLDOWN: 'Cooldown atlandı',
  EMERGENCY_MARKET_SELL: 'Acil satış',
  EMERGENCY_SELL_FAILED: 'Acil satış hatası',
  CRON_ERROR: 'Cron hatası',
  RECONCILE_SKIP: 'Reconcile atlandı',
  RECONCILE_ORDER_GONE: 'Emir bulunamadı',
  RECONCILE_FAILED: 'Reconcile hatası',
  ORDER_ANOMALY: 'Emir anomalisi',
  MIN_NOTIONAL_SKIP: 'Min notional',
  MIN_NET_TP_SKIP: 'Min net TP atlandı',
  LOT_SIZE_TOO_SMALL: 'Lot çok küçük',
  COMMISSION_IN_BASE_ASSET: 'Komisyon (base)',
  DUST_REMAINDER: 'Toz bakiye',
  INSUFFICIENT_BALANCE_RETRY: 'Bakiye yetersiz',
  MOMENTUM_SCAN: 'Momentum tarama (eski)',
  MOMENTUM_PASS: 'Momentum geçti (eski)',
  MOMENTUM_BEST_PICK: 'Momentum seçim (eski)',
  MICRO_SCORE_SCAN: 'Mikro skor tarama',
  MICRO_SCORE_PASS: 'Mikro skor geçti',
  MICRO_SHADOW_RESOLVED: 'Shadow forward PnL',
  MICRO_BEST_PICK: 'Mikro scalp seçim',
  MARKET_REGIME: 'Piyasa rejimi',
  MARKET_REGIME_SKIP: 'Rejim güncellenemedi',
  SCALP_ENTER: 'Scalp giriş',
  SCALP_TARGET_SET: 'Scalp hedef',
  SCALP_EXIT_TP: 'Scalp TP',
  SCALP_EXIT_TIMEOUT: 'Scalp süre doldu',
  SCALP_EXIT_SIGNAL_LOST: 'Sinyal kaybı çıkış',
  MOCK_SCALP_FILLED: 'Simüle scalp TP',
  TRADE_ENTER: 'İşlem girişi (analiz)',
  TRADE_EXCURSION: 'Pozisyon tepe/dip',
  TRADE_OUTCOME: 'İşlem sonucu (analiz)',
  TICK_REVERSAL_RANK: 'Reversal sıralaması',
  TICK_SHADOW_RESOLVED: 'Tick shadow 60sn',
  TICK_WS_SIGNAL: 'WS sniper sinyal',
  TICK_WS_HEARTBEAT: 'WS sniper nabız',
  TICK_FIRE_ACCEPTED: 'WS sniper giriş',
  TICK_FIRE_REJECTED: 'WS sniper red',
};

function rec(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

function s(v: unknown): string {
  if (v == null || v === '') return '—';
  return String(v);
}

function orderRec(p: Record<string, unknown>): Record<string, unknown> {
  const o = p.order;
  return o && typeof o === 'object' ? (o as Record<string, unknown>) : {};
}

export function pnlColor(pnl: string): string {
  const n = Number(pnl);
  if (Number.isNaN(n)) return '';
  return n >= 0 ? 'text-emerald-400' : 'text-red-400';
}

function fmtUsdt(v: unknown): string {
  const raw = s(v);
  if (raw === '—') return raw;
  return `${formatUsdt(raw)} USDT`;
}

function fmtPrice(v: unknown): string {
  return formatPrice(s(v));
}

function fmtPct(v: unknown): string {
  const n = Number(v);
  if (Number.isNaN(n)) return s(v);
  return `${n.toFixed(2)}%`;
}

function fmtScore(v: unknown): string {
  const n = Number(v);
  if (Number.isNaN(n)) return s(v);
  return n.toFixed(3);
}

function fmtSymbols(selected: unknown): string {
  if (!Array.isArray(selected) || selected.length === 0) return '—';
  return selected
    .map((x) => {
      if (x && typeof x === 'object' && 'symbol' in x) return String((x as { symbol: string }).symbol);
      return '';
    })
    .filter(Boolean)
    .join(', ');
}

export function formatLog(eventType: string, payload: unknown): FormattedLog {
  const p = rec(payload);
  const label = EVENT_LABELS[eventType] ?? eventType;

  switch (eventType) {
    case 'MICRO_SCORE_SCAN':
      return {
        label,
        tone: 'muted',
        summary: `Tarama: ${Array.isArray(p.batchScanned) ? (p.batchScanned as string[]).join(', ') : '—'}`,
        details: [
          { label: 'Rejim', value: s(p.regime) },
          { label: 'Giriş izni', value: p.regimeAllowsEntry === false ? 'hayır' : 'evet' },
          {
            label: 'En iyi',
            value: p.best && typeof p.best === 'object' ? s((p.best as Record<string, unknown>).symbol) : '—',
          },
        ],
      };

    case 'MICRO_SHADOW_RESOLVED': {
      const fwd30 = p.forward30mPct != null ? `${Number(p.forward30mPct) >= 0 ? '+' : ''}${p.forward30mPct}%` : '—';
      const hit = p.hitTp30m ? 'TP✓' : 'TP✗';
      return {
        label,
        tone: Number(p.forward30mPct) >= Number(p.tpGrossPct ?? 0.7) ? 'success' : 'muted',
        summary: `${s(p.symbol)} shadow 30m ${fwd30} (${hit}) — ${s(p.failReason)}`,
        details: [
          { label: 'Skor', value: fmtScore(p.score) },
          { label: '5m / 15m / 30m', value: `${s(p.forward5mPct)} / ${s(p.forward15mPct)} / ${s(p.forward30mPct)}` },
          { label: '15m gate', value: p.trend15mOk ? 'up' : 'down' },
          { label: 'Skor-only geçer', value: p.wouldPassScoreOnly ? 'evet' : 'hayır' },
          { label: 'Ref fiyat', value: fmtPrice(p.entryRefPrice) },
        ],
      };
    }

    case 'MICRO_SCORE_PASS':
      return {
        label,
        tone: 'success',
        summary: `${s(p.symbol)} mikro skor geçti — ${fmtScore(p.score)}`,
        details: [
          { label: 'Hacim oranı', value: s(p.volumeRatio) },
          { label: 'Aggression', value: s(p.aggressionRatio) },
        ],
      };

    case 'MICRO_BEST_PICK':
      return {
        label,
        tone: 'info',
        summary: `${s(p.symbol)} seçildi — skor ${fmtScore(p.score)} (${s(p.action)})`,
        details: [
          { label: 'Sektör', value: s(p.sector) },
        ],
      };

    case 'MARKET_REGIME':
      return {
        label,
        tone: p.regime === 'trend' ? 'success' : 'warning',
        summary: `Piyasa rejimi: ${s(p.regime)}`,
        details: [
          { label: 'BTC ATR%', value: fmtPct(p.btcAtrPct) },
          { label: 'Breadth', value: fmtPct(p.breadthPct) },
        ],
      };

    case 'TRADE_ENTER': {
      const tick = p.gainPct != null ? fmtPct(p.gainPct) : '—';
      const ws = p.wsDeclinePct != null ? fmtPct(p.wsDeclinePct) : '—';
      return {
        label,
        tone: 'success',
        summary: `${s(p.symbol)} giriş — tick ${tick}, WS düşüş ${ws}`,
        details: [
          { label: 'Dolum fiyatı', value: fmtPrice(p.fillPrice) },
          { label: 'Gözcü fiyatı', value: fmtPrice(p.scoutPrice) },
          { label: 'Gözcü → dolum', value: p.scoutVsFillPct != null ? fmtPct(p.scoutVsFillPct) : '—' },
          { label: 'Tick % (1m)', value: tick },
          { label: 'WS düşüş %', value: ws },
          { label: 'OB oran', value: s(p.bidAskRatio) },
          { label: 'Spread', value: p.spreadPct != null ? fmtPct(p.spreadPct) : '—' },
          { label: 'TP', value: fmtPct(p.takeProfitGrossPct) },
          { label: 'SL', value: fmtPct(p.stopLossGrossPct) },
          { label: 'Mod', value: s(p.entryMode) },
        ],
      };
    }

    case 'TRADE_EXCURSION':
      return {
        label,
        tone: 'info',
        summary: `${s(p.symbol)} ${p.newHigh ? 'yeni tepe' : 'yeni dip'} — +${fmtPct(p.favorable_pct)} / ${fmtPct(p.adverse_pct)}`,
        details: [
          { label: 'Anlık', value: fmtPrice(p.lastPrice) },
          { label: 'Maliyet', value: fmtPrice(p.avg_cost) },
          { label: 'Tepe fiyat', value: fmtPrice(p.peak_price) },
          { label: 'Dip fiyat', value: fmtPrice(p.trough_price) },
          { label: 'Mark %', value: fmtPct(p.mark_pct) },
        ],
      };

    case 'TRADE_OUTCOME': {
      const entry = rec(p.entry);
      const pnl = s(p.pnl);
      const pnlN = Number(pnl);
      return {
        label,
        tone: Number.isNaN(pnlN) ? 'neutral' : pnlN >= 0 ? 'success' : 'error',
        summary: `${s(p.symbol)} kapandı — PnL ${pnl} USDT, çıkış ${fmtPct(p.exit_pct_from_cost)}`,
        details: [
          { label: 'Kaynak', value: s(p.source) },
          { label: 'Max yükseliş', value: fmtPct(p.max_favorable_pct) },
          { label: 'Max düşüş', value: fmtPct(p.max_adverse_pct) },
          { label: 'Giriş tick %', value: entry.gainPct != null ? fmtPct(entry.gainPct) : '—' },
          { label: 'Giriş WS %', value: entry.wsDeclinePct != null ? fmtPct(entry.wsDeclinePct) : '—' },
          { label: 'Gözcü fiyat', value: fmtPrice(entry.scoutPrice) },
          { label: 'Dolum fiyat', value: fmtPrice(entry.fillPrice ?? p.avg_cost) },
          { label: 'Çıkış fiyat', value: fmtPrice(p.exit_price) },
        ],
      };
    }

    case 'SCALP_ENTER':
      return {
        label,
        tone: 'success',
        summary: `${s(p.symbol)} scalp giriş — TP ${fmtPct(p.take_profit_gross_pct)} / SL ${fmtPct(p.stop_loss_gross_pct)}`,
        details: [
          { label: 'Maliyet', value: fmtPrice(p.avg_cost) },
          { label: 'TP fiyat', value: fmtPrice(p.take_profit_price) },
          { label: 'ATR band', value: s(p.dynamicBand) },
        ],
      };

    case 'SCALP_TARGET_SET':
      return {
        label,
        tone: 'info',
        summary: `${s(p.symbol)} hedef — TP ${fmtPrice(p.take_profit_price)} (${fmtPct(p.gross_pct)})`,
        details: [{ label: 'Stop brüt', value: fmtPct(p.stop_pct) }],
      };

    case 'SCALP_EXIT_TP':
      return {
        label,
        tone: 'success',
        summary: `${s(p.symbol)} scalp TP — fiyat ${fmtPrice(p.lastPrice)}`,
        details: [{ label: 'Hedef', value: fmtPrice(p.take_profit_price) }],
      };

    case 'SCALP_EXIT_TIMEOUT':
      return {
        label,
        tone: 'warning',
        summary: `${s(p.symbol)} max hold (${s(p.elapsedMinutes)} dk)`,
        details: [
          { label: 'Son fiyat', value: fmtPrice(p.lastPrice) },
          { label: 'TP', value: fmtPrice(p.take_profit_price) },
        ],
      };

    case 'SCALP_EXIT_SIGNAL_LOST':
      return {
        label,
        tone: 'warning',
        summary: `${s(p.symbol)} sinyal kaybı — skor ${fmtScore(p.score)} < ${fmtScore(p.floor)}`,
        details: [{ label: 'Neden', value: s(p.failReason) }],
      };

    case 'MIN_NET_TP_SKIP':
      return {
        label,
        tone: 'muted',
        summary: `${s(p.symbol)} net TP çok düşük — giriş yok`,
        details: [
          { label: 'Brüt TP', value: fmtPct(p.tpGrossPct) },
          { label: 'Fee', value: fmtPct(p.feeRoundtripPct) },
        ],
      };

    case 'SCOUT_RUN': {
      const peakFiltered = Array.isArray(p.peakFiltered) ? p.peakFiltered : [];
      const min1h = p.scoutMin1hPeakPct ?? p.scoutMin15mPeakPct;
      return {
        label,
        tone: 'muted',
        summary: p.microEnabled
          ? `Mikro evren: ${fmtSymbols(p.selected)}`
          : `Watchlist: ${fmtSymbols(p.selected)}${peakFiltered.length ? ` · 1h tepe elenen: ${peakFiltered.length}` : ''}`,
        details: [
          { label: 'Aday', value: s(p.candidateCount) },
          { label: 'Filtrelenen', value: s(p.filteredCount) },
          { label: '1h tepe min', value: s(min1h) },
          { label: '1h tepe elenen', value: String(peakFiltered.length) },
          { label: 'Mikro', value: p.microEnabled ? 'açık' : 'kapalı' },
        ],
      };
    }

    case 'TICK_ENTRY_SIGNAL':
      return {
        label,
        tone: 'info',
        summary: `${s(p.symbol)} tick — recovery ${fmtPct(p.recoveryFromWsLowPct)}, skor ${s(p.reversalScore)}`,
        details: [
          { label: 'Gözcü fiyat', value: fmtPrice(p.scoutPrice) },
          { label: 'Tick %', value: fmtPct(p.gainPct) },
          { label: 'Recovery %', value: fmtPct(p.recoveryFromWsLowPct) },
          { label: 'WS düşüş', value: fmtPct(p.wsDeclinePct) },
          { label: 'Dipten sn', value: s(p.secSinceTrough) },
          { label: 'Reversal skor', value: s(p.reversalScore) },
          { label: 'Mid', value: fmtPrice(p.mid) },
          { label: 'Alım', value: p.executeEntries ? 'açık' : 'sadece sinyal' },
        ],
      };

    case 'TICK_REVERSAL_RANK': {
      const top = Array.isArray(p.top) ? p.top : [];
      const first = top[0] as Record<string, unknown> | undefined;
      return {
        label,
        tone: 'info',
        summary: first
          ? `En iyi ${s(first.symbol)} — skor ${s(first.reversalScore)}, recovery ${fmtPct(first.recoveryPct)}`
          : 'Reversal sıralaması',
        details: top.slice(0, 5).map((row, i) => ({
          label: `#${i + 1}`,
          value: `${s((row as Record<string, unknown>).symbol)} skor=${s((row as Record<string, unknown>).reversalScore)}`,
        })),
      };
    }

    case 'TICK_WS_SIGNAL':
      return {
        label,
        tone: 'info',
        summary: `${s(p.symbol)} WS sinyal — skor ${s(p.reversalScore)}`,
        details: [
          { label: 'Recovery', value: fmtPct(p.recoveryFromWsLowPct) },
          { label: 'Tick %', value: fmtPct(p.gainPct) },
          { label: 'SignalId', value: s(p.signalId) },
        ],
      };

    case 'TICK_WS_HEARTBEAT':
      return {
        label,
        tone: p.wsStale ? 'warning' : 'muted',
        summary: p.wsStale
          ? 'WS veri bayat — yeniden bağlanıyor olabilir'
          : `WS sniper aktif — ${s(p.watchlistSize)} coin`,
        details: [
          { label: 'Watchlist', value: s(p.watchlistSize) },
          { label: 'Son mesaj', value: s(p.lastMessageAt) },
          { label: 'DO', value: p.marketDataBound ? 'bağlı' : 'yok' },
        ],
      };

    case 'TICK_FIRE_ACCEPTED':
      return {
        label,
        tone: 'success',
        summary: `${s(p.symbol)} giriş kabul — skor ${s(p.reversalScore)}`,
        details: [{ label: 'SignalId', value: s(p.signalId) }],
      };

    case 'TICK_FIRE_REJECTED':
      return {
        label,
        tone: 'warning',
        summary: `${s(p.symbol)} — ${s(p.reason)}`,
        details: [
          { label: 'Sebep', value: s(p.reason) },
          { label: 'Durum', value: s(p.status) },
        ],
      };

    case 'TICK_SHADOW_RESOLVED':
      return {
        label,
        tone: p.forward60sPositive ? 'success' : 'warning',
        summary: `${s(p.symbol)} 60sn forward ${fmtPct(p.forward60sPct)}`,
        details: [
          { label: 'Pozitif', value: p.forward60sPositive ? 'evet' : 'hayır' },
          { label: 'Reversal geçerdi', value: p.wouldPassReversal ? 'evet' : 'hayır' },
          { label: 'Sinyal recovery', value: fmtPct(p.recoveryPctAtSignal) },
        ],
      };

    case 'TICK_GAIN_SNAPSHOT': {
      const g1 = p.gain1mStats as Record<string, unknown> | undefined;
      return {
        label,
        tone: 'info',
        summary: `1m band: ${s(g1?.inBand)}/${s(g1?.count)} (hedef ${s(p.minGainPct)}–${s(p.maxGainPct)}%) · alt/üst: ${s(g1?.belowMin)}/${s(g1?.aboveMax)}`,
        details: [
          { label: 'Watchlist', value: s(p.watchlistCount) },
          { label: 'Örneklenen', value: s(p.sampledCount) },
        ],
      };
    }

    case 'SNIPER_SKIP':
      return {
        label,
        tone: 'muted',
        summary:
          p.reason === 'empty_watchlist'
            ? 'Watchlist boş — alım yok'
            : p.reason === 'regime_block'
              ? `Rejim engeli (${s(p.regime)})`
              : p.reason === 'no_micro_eligible'
                ? 'Uygun mikro skor yok'
                : p.reason === 'no_tick_eligible'
                  ? `Tick uygun yok — en yakın ${s(p.bestSymbol)} (${s(p.bestFailReason)})`
                  : s(p.reason),
        details:
          p.reason === 'no_tick_eligible'
            ? [
                { label: '1m %', value: s(p.bestGainPct) },
              ]
            : [],
      };

    case 'SIGNAL':
      return {
        label,
        tone: 'info',
        summary: `${s(p.symbol)} — fiyat SMA20'ye pullback (${fmtPct(p.tolerancePct)} tolerans)`,
        details: [
          { label: 'Son kapanış', value: fmtPrice(p.lastClose) },
          { label: 'SMA20', value: fmtPrice(p.sma20) },
          {
            label: 'Bollinger',
            value: p.bollinger && typeof p.bollinger === 'object'
              ? `üst ${s((p.bollinger as Record<string, unknown>).upper)} / alt ${s((p.bollinger as Record<string, unknown>).lower)}`
              : '—',
          },
        ],
      };

    case 'BUY_FILLED': {
      const o = orderRec(p);
      return {
        label,
        tone: 'success',
        summary: `${s(p.symbol)} market alım — ${fmtUsdt(o.cummulativeQuoteQty ?? p.quoteUsdt)} (${s(p.entry_mode)})`,
        details: [
          { label: 'Emir ID', value: s(o.orderId) },
          { label: 'Miktar', value: s(o.executedQty) },
          { label: 'Durum', value: s(o.status) },
        ],
      };
    }

    case 'NET_QTY_COMPUTED':
      return {
        label,
        tone: 'neutral',
        summary: `${s(p.symbol)} — satışa hazır net: ${s(p.net_base_qty)}`,
        details: [
          { label: 'Brüt', value: s(p.gross_base_qty) },
          { label: 'Komisyon (base)', value: s(p.commission_base_total) },
        ],
      };

    case 'TRAILING_PLACED':
      return {
        label,
        tone: 'success',
        summary: `${s(p.symbol)} çift kademeli trailing (TAKE_PROFIT) — aktivasyon ${fmtPct(p.trailingActivationPct)}, dar ${fmtPct(p.trailingTightCallbackPct)}`,
        details: [
          { label: 'Emir ID', value: s(p.orderId) },
          { label: 'Satış miktarı', value: s(p.sellQty) },
          { label: 'Aktivasyon (stopPrice)', value: fmtPrice(p.activationStopPrice) },
          { label: 'Maliyet', value: fmtPrice(p.avg_cost) },
          {
            label: 'trailingDelta',
            value: p.trailingDeltaBips != null ? `${s(p.trailingDeltaBips)} BIPS` : '—',
          },
          { label: 'Tip', value: s(p.orderType) || 'TAKE_PROFIT' },
        ],
      };

    case 'TRAILING_REJECTED':
      return {
        label,
        tone: 'warning',
        summary: `${s(p.symbol)} trailing reddedildi — manuel müdahale`,
        details: [
          { label: 'Miktar', value: s(p.sellQty) },
          { label: 'Hata', value: s(p.error) },
        ],
      };

    case 'MOCK_ORDER': {
      const action = s(p.action);
      const o = orderRec(p);
      const actionTr: Record<string, string> = {
        marketBuy: 'Simüle market alım',
        marketSell: 'Simüle market satış',
        trailingStop: 'Simüle trailing stop',
        cancelOrder: 'Simüle iptal',
      };
      return {
        label,
        tone: 'info',
        summary: `${actionTr[action] ?? action} — ${s(o.symbol ?? (p.params as Record<string, unknown>)?.symbol)}`,
        details: [
          { label: 'Emir ID', value: s(o.orderId) },
          { label: 'Durum', value: s(o.status) },
          { label: 'Tutar', value: fmtUsdt(o.cummulativeQuoteQty) },
        ],
      };
    }

    case 'MOCK_TRAILING_FILLED':
      return {
        label,
        tone: 'success',
        summary:
          p.reason === 'tight_callback'
            ? `${s(p.symbol)} — dar takip tetiklendi, simüle satış`
            : p.reason === 'callback_triggered'
              ? `${s(p.symbol)} — callback tetiklendi, simüle satış`
              : `${s(p.symbol)} — max süre doldu, simüle satış`,
        details: [
          { label: 'Emir ID', value: s(p.orderId) },
          { label: 'Aktivasyon', value: fmtPrice(p.activationStop) },
          { label: 'Zirve', value: fmtPrice(p.peak) },
          { label: 'Fiyat', value: fmtPrice(p.lastPrice) },
          { label: 'Gelir', value: fmtUsdt(p.proceeds) },
          { label: 'Dar takip', value: fmtPct(p.tightCallbackPct) },
        ],
      };

    case 'MOCK_SCALP_FILLED':
      return {
        label,
        tone: 'success',
        summary: `${s(p.symbol)} simüle scalp TP @ ${fmtPrice(p.lastPrice)}`,
        details: [{ label: 'Hedef', value: fmtPrice(p.take_profit_price) }],
      };

    case 'POSITION_CLOSED': {
      const pnl = s(p.pnl);
      const pnlN = Number(pnl);
      const hasExcursion = p.max_favorable_pct != null;
      return {
        label,
        tone: Number.isNaN(pnlN) ? 'success' : pnlN >= 0 ? 'success' : 'error',
        summary: hasExcursion
          ? `${s(p.symbol)} kapandı — PnL ${pnl} USDT, max +${fmtPct(p.max_favorable_pct)} / ${fmtPct(p.max_adverse_pct)}`
          : `${s(p.symbol)} kapandı — PnL ${pnl} USDT (${s(p.source)})`,
        details: [
          { label: 'Harcanan', value: fmtUsdt(p.spent) },
          { label: 'Gelir', value: fmtUsdt(p.proceeds) },
          { label: 'PnL', value: `${pnl} USDT` },
          { label: 'Mod', value: s(p.entry_mode) },
          ...(hasExcursion
            ? [
                { label: 'Max yükseliş', value: fmtPct(p.max_favorable_pct) },
                { label: 'Max düşüş', value: fmtPct(p.max_adverse_pct) },
                { label: 'Çıkış %', value: fmtPct(p.exit_pct_from_cost) },
              ]
            : []),
        ],
      };
    }

    case 'HARD_STOP_TRIGGERED':
      return {
        label,
        tone: 'error',
        summary: `${s(p.symbol)} hard stop — kayıp ${fmtPct(p.lossPct)} (eşik ${fmtPct(p.thresholdPct)})`,
        details: [
          { label: 'Son fiyat', value: fmtPrice(p.lastPrice) },
          { label: 'Ortalama maliyet', value: fmtPrice(p.avg_cost) },
          { label: 'Kaynak', value: s(p.source) },
        ],
      };

    case 'WATCHLIST_ROTATION_TRIGGERED':
      return {
        label,
        tone: 'warning',
        summary: `${s(p.fromSymbol)} → ${s(p.toSymbol)} — daha iyi SMA (${fmtPct(p.bestDeviation)} vs ${fmtPct(p.currentDeviation)})`,
        details: [
          { label: 'Geçen süre', value: `${s(p.elapsedMinutes)} dk` },
          { label: 'Bekleme', value: `${s(p.rotationGraceMinutes ?? p.rotationWindowMinutes)} dk` },
          { label: 'Min iyileşme', value: fmtPct(p.rotationMinImprovementPct) },
          { label: 'Cursor', value: s(p.watchlistCursor) },
        ],
      };

    case 'ROTATION_SKIP': {
      const reasonTr: Record<string, string> = {
        improvement_below_threshold: 'SMA iyileşmesi eşiğin altında',
        no_near_sma_candidate: "Watchlist'te daha iyi near-SMA yok",
        grace_period: 'Rotasyon bekleme süresi dolmadı',
        no_watchlist: 'Watchlist boş',
        no_rankings: 'SMA verisi alınamadı',
      };
      const r = String(p.reason ?? '');
      return {
        label,
        tone: 'muted',
        summary: reasonTr[r] ?? `${s(p.activeSymbol)} — ${r}`,
        details: [
          { label: 'Aktif sapma', value: fmtPct(p.activeDeviation) },
          { label: 'En iyi', value: p.bestSymbol ? `${s(p.bestSymbol)} ${fmtPct(p.bestDeviation)}` : '—' },
          { label: 'İyileşme', value: fmtPct(p.improvementPct) },
          { label: 'Gerekli', value: fmtPct(p.requiredPct ?? p.effectiveMinImprovementPct ?? p.rotationMinImprovementPct) },
        ],
      };
    }

    case 'WATCHLIST_ROTATION_LOT_TOO_SMALL':
      return {
        label,
        tone: 'warning',
        summary: `${s(p.symbol)} rotasyon satışı — lot çok küçük`,
        details: [
          { label: 'Miktar', value: s(p.sellQty) },
          { label: 'Min', value: s(p.minQty) },
        ],
      };

    case 'TIME_STOP_TRIGGERED':
      return {
        label,
        tone: 'warning',
        summary: `${s(p.symbol)} zaman stopu — ${s(p.elapsedMinutes)} dk`,
        details: [
          { label: 'Son fiyat', value: fmtPrice(p.lastPrice) },
          { label: 'Maliyet', value: fmtPrice(p.avg_cost) },
        ],
      };

    case 'TIME_STOP_LOT_TOO_SMALL':
      return {
        label,
        tone: 'warning',
        summary: `${s(p.symbol)} zaman stopu — lot çok küçük, IDLE`,
        details: [
          { label: 'Miktar', value: s(p.sellQty) },
          { label: 'Min', value: s(p.minQty) },
        ],
      };

    case 'TIME_STOP_SELL_FAILED':
      return {
        label,
        tone: 'error',
        summary: `${s(p.symbol)} zaman stopu satışı başarısız`,
        details: [{ label: 'Hata', value: s(p.message) }],
      };

    case 'SNIPER_SKIP_COOLDOWN':
      return {
        label,
        tone: 'muted',
        summary: `${s(p.symbol)} cooldown — tetikçi atladı`,
        details: [],
      };

    case 'EMERGENCY_MARKET_SELL':
      return {
        label,
        tone: 'warning',
        summary: `${s(p.symbol)} acil market satış — ${s(p.sellQty)}`,
        details: [{ label: 'Emir ID', value: s(p.orderId) }],
      };

    case 'CRON_ERROR':
      return {
        label,
        tone: 'error',
        summary: `${s(p.job)} job hatası: ${s(p.message)}`,
        details: [],
      };

    case 'RECONCILE_SKIP':
      return {
        label,
        tone: 'warning',
        summary: s(p.reason),
        details: [],
      };

    case 'RECONCILE_ORDER_GONE':
      return {
        label,
        tone: 'warning',
        summary: `${s(p.symbol)} emri Binance'te yok (arşiv / simülasyon ID)`,
        details: [
          { label: 'Emir ID', value: s(p.orderId) },
          { label: 'Simülasyon ID', value: p.mockId ? 'evet' : 'hayır' },
        ],
      };

    case 'ORDER_ANOMALY':
      return {
        label,
        tone: 'error',
        summary: `${s(p.symbol)} emir ${s(p.status)} — acil satış deneniyor`,
        details: [{ label: 'Emir ID', value: s(p.orderId) }],
      };

    case 'MIN_NOTIONAL_SKIP':
      return {
        label,
        tone: 'muted',
        summary: `${s(p.symbol)} min notional (${fmtUsdt(p.minNotional)}) — atlandı`,
        details: [{ label: 'Planlanan', value: fmtUsdt(p.quoteUsdt) }],
      };

    case 'LOT_SIZE_TOO_SMALL':
      return {
        label,
        tone: 'warning',
        summary: `${s(p.symbol)} lot çok küçük (${s(p.sellQty)} < min ${s(p.minQty)})`,
        details: [],
      };

    case 'COMMISSION_IN_BASE_ASSET':
      return {
        label,
        tone: 'warning',
        summary: `${s(p.symbol)} komisyon base coin ile kesildi`,
        details: [{ label: 'İpucu', value: s(p.hint) }],
      };

    case 'DUST_REMAINDER':
      return {
        label,
        tone: 'muted',
        summary: `${s(p.symbol)} kalan toz bakiye`,
        details: [
          { label: 'Serbest', value: s(p.free) },
          { label: 'Net', value: s(p.net_base_qty) },
        ],
      };

    default:
      return {
        label,
        tone: 'neutral',
        summary: Object.keys(p).length > 0 ? summarizeGeneric(p) : '—',
        details: [],
      };
  }
}

function summarizeGeneric(p: Record<string, unknown>): string {
  if (p.symbol) return String(p.symbol);
  if (p.message) return String(p.message);
  if (p.reason) return String(p.reason);
  return 'Detay için ham veriye bakın';
}

export { EVENT_LABELS };

export const NOISY_EVENT_TYPES = new Set([
  'SCOUT_RUN',
  'SNIPER_SKIP',
  'MIN_NOTIONAL_SKIP',
  'MICRO_SCORE_SCAN',
  'ROTATION_SKIP',
]);

export const LOG_PRESETS: Array<{ id: string; label: string; event?: string; hideNoisy?: boolean }> = [
  { id: 'all', label: 'Tümü' },
  { id: 'trade', label: 'Emirler & pozisyon', hideNoisy: true },
  { id: 'micro', label: 'Mikro-scalp', event: 'MICRO_SCORE_PASS' },
  { id: 'SCOUT_RUN', label: 'Gözcü', event: 'SCOUT_RUN' },
  { id: 'POSITION_CLOSED', label: 'Kapanışlar', event: 'POSITION_CLOSED' },
  { id: 'TRADE_OUTCOME', label: 'İşlem analizi', event: 'TRADE_OUTCOME' },
  { id: 'TRADE_ENTER', label: 'Giriş analizi', event: 'TRADE_ENTER' },
  { id: 'TICK_REVERSAL_RANK', label: 'Reversal rank', event: 'TICK_REVERSAL_RANK' },
  { id: 'TICK_SHADOW_RESOLVED', label: 'Tick shadow', event: 'TICK_SHADOW_RESOLVED' },
  { id: 'MARKET_REGIME', label: 'Rejim', event: 'MARKET_REGIME' },
  { id: 'CRON_ERROR', label: 'Hatalar', event: 'CRON_ERROR' },
];
