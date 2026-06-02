import { DurableObject } from 'cloudflare:workers';
import type { Kline, Ticker24hr } from '../exchange/binance';
import { detectMarketRegime, type MarketRegimeResult } from '../indicators/market-regime';
import {
  computeMicroScalpScore,
  DEFAULT_MICRO_WEIGHTS,
  type MicroScalpConfig,
} from '../indicators/micro-scalp';
import { parseDepthMessage, type DepthLevel } from './depth-parse';
import { KlineStore, parseKlineEvent, type KlineInterval } from './kline-store';
import {
  appendMidSample,
  defaultTickDeclineConfig,
  evaluateWsDecline,
  type MidSample,
  type TickDeclineConfig,
} from '../indicators/tick-decline';
import { evaluateTickEntry, type TickEntryConfig } from '../indicators/tick-entry';
import {
  evaluateTickReversal,
  defaultTickReversalConfig,
  type TickReversalConfig,
} from '../indicators/tick-reversal';
import {
  appendAggFlowSample,
  defaultTickAggFlowConfig,
  evaluateTickAggFlow,
  type AggFlowSample,
  type TickAggFlowConfig,
} from '../indicators/tick-agg-flow';
import { buildMarketStreams, WsConnectionPool } from './ws-connection-pool';
import {
  canFireTickSignal,
  shouldScheduleTickEval,
} from '../indicators/tick-fire-gate';

export { parseDepthMessage } from './depth-parse';

interface WallTrack {
  price: string;
  qty: string;
  sinceMs: number;
}

interface SymbolObMetrics {
  bidAskRatio: number;
  spreadPct: number;
  spreadPctPrev: number | null;
  spreadHistory: number[];
  bidAskRatioAtTrough: number | null;
  persistenceScore: number;
  updatedAt: number;
  topBidWall: WallTrack | null;
  bestBid: number;
  bestAsk: number;
}

export interface MarketDataStatusRow {
  symbol: string;
  bidAskRatio: number;
  spreadPct: number;
  persistenceScore: number;
  obAgeMs: number;
  kline1mAgeMs: number | null;
  kline5mAgeMs: number | null;
  kline15mAgeMs: number | null;
  stale: boolean;
  liveScore: string | null;
}

export interface MarketDataStatus {
  symbolCount: number;
  wsShards: Array<{ id: string; streams: number; open: boolean }>;
  tickerCount: number;
  tickerUpdatedAt: number | null;
  lastMessageAt: number | null;
  messageCount: number;
  regime: MarketRegimeResult | null;
  symbols: MarketDataStatusRow[];
}

interface CachedScore {
  score: string;
  pass: boolean;
  failReason: string | null;
  updatedAt: number;
}

export interface TickRefSnapshot {
  symbol: string;
  mid: string;
  candleLow: string;
  candleOpen: string;
  candleOpenTime: number;
  candleIsClosed: boolean;
  gainPct: string | null;
  bidAskRatio: number;
  spreadPct: number;
  pass: boolean;
  failReason: string | null;
  trend5mOk: boolean;
  trend5mFailReason: string | null;
  wsDeclinePct: string | null;
  wsDeclineOk: boolean;
  wsDeclineFailReason: string | null;
  recoveryFromWsLowPct: string | null;
  midSlopeOk: boolean;
  secSinceTrough: number | null;
  reversalScore: number;
  reversalOk: boolean;
  reversalFailReason: string | null;
  aggBurstOk: boolean;
  aggBurstFailReason: string | null;
  aggBuyCount: number;
  aggBuyQuoteUsdt: string | null;
  aggSellQuoteUsdt: string | null;
  aggImbalance: string | null;
  updatedAt: number;
  stale: boolean;
}

export interface TickScanRow extends TickRefSnapshot {}

interface TickerArrItem {
  s?: string;
  c?: string;
  q?: string;
  P?: string;
  h?: string;
  l?: string;
}

function mergeTicker24h(
  prev: Ticker24hr | undefined,
  next: Partial<Ticker24hr> & { symbol: string },
): Ticker24hr {
  return {
    symbol: next.symbol,
    lastPrice:
      next.lastPrice && Number(next.lastPrice) > 0
        ? next.lastPrice
        : (prev?.lastPrice ?? '0'),
    quoteVolume: next.quoteVolume ?? prev?.quoteVolume ?? '0',
    priceChangePercent: next.priceChangePercent ?? prev?.priceChangePercent ?? '0',
    highPrice:
      next.highPrice && Number(next.highPrice) > 0
        ? next.highPrice
        : (prev?.highPrice ?? '0'),
    lowPrice:
      next.lowPrice && Number(next.lowPrice) > 0 ? next.lowPrice : (prev?.lowPrice ?? '0'),
  };
}

const MAX_SYMBOLS = 100;
const PERSISTENCE_SECONDS = 5;
const ALARM_INTERVAL_MS = 45_000;
const STALE_MS = 60_000;
const BTC_SYMBOL = 'BTCUSDT';
const TICK_SNIPER_SYMBOLS = new Set<string>();

export class MarketDataDO extends DurableObject<Env> {
  private symbols: string[] = [];
  private obMetrics = new Map<string, SymbolObMetrics>();
  private tickers = new Map<string, Ticker24hr>();
  private tickerUpdatedAt: number | null = null;
  private tickerRestAt = 0;
  private klines = new KlineStore();
  private scores = new Map<string, CachedScore>();
  private scoreConfig: MicroScalpConfig = defaultScoreConfig();
  private regimeCache: MarketRegimeResult | null = null;
  private regimeUpdatedAt = 0;
  private pool: WsConnectionPool | null = null;
  private lastMessageAt: number | null = null;
  private messageCount = 0;
  private seeded = new Set<string>();
  private tickEntryConfig: TickEntryConfig = defaultTickEntryConfig();
  private tickDeclineConfig: TickDeclineConfig = defaultTickDeclineConfig();
  private tickReversalConfig: TickReversalConfig = defaultTickReversalConfig();
  private tickAggFlowConfig: TickAggFlowConfig = defaultTickAggFlowConfig();
  private midHistory = new Map<string, MidSample[]>();
  private aggFlowHistory = new Map<string, AggFlowSample[]>();
  private lastEvalScheduledMs = new Map<string, number>();
  private lastGlobalFireMs = 0;
  private lastSymbolFireMs = new Map<string, number>();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/symbols') {
      const body = (await request.json()) as {
        symbols?: string[];
        scoreConfig?: Partial<MicroScalpConfig>;
        tickEntryConfig?: Partial<TickEntryConfig>;
        tickDeclineConfig?: Partial<TickDeclineConfig>;
        tickReversalConfig?: Partial<TickReversalConfig>;
        tickAggFlowConfig?: Partial<TickAggFlowConfig>;
      };
      if (body.scoreConfig) {
        this.scoreConfig = { ...defaultScoreConfig(), ...body.scoreConfig };
      }
      if (body.tickEntryConfig) {
        this.tickEntryConfig = { ...defaultTickEntryConfig(), ...body.tickEntryConfig };
      }
      if (body.tickDeclineConfig) {
        this.tickDeclineConfig = { ...defaultTickDeclineConfig(), ...body.tickDeclineConfig };
      }
      if (body.tickReversalConfig) {
        this.tickReversalConfig = { ...defaultTickReversalConfig(), ...body.tickReversalConfig };
      }
      if (body.tickAggFlowConfig) {
        this.tickAggFlowConfig = { ...defaultTickAggFlowConfig(), ...body.tickAggFlowConfig };
      }
      await this.setSymbols(body.symbols ?? []);
      return Response.json({
        ok: true,
        count: this.symbols.length,
        wsShards: this.pool?.getStatus() ?? [],
      });
    }

    if (request.method === 'POST' && url.pathname === '/seed') {
      const body = (await request.json()) as {
        symbol: string;
        interval: KlineInterval;
        klines: Kline[];
      };
      this.klines.seed(body.symbol, body.interval, body.klines);
      this.seeded.add(`${body.symbol}:${body.interval}`);
      return Response.json({ ok: true });
    }

    if (url.pathname === '/status') {
      return Response.json(this.buildStatus());
    }

    if (url.pathname === '/tickers') {
      const scope = url.searchParams.get('scope');
      if (scope === 'watchlist') {
        await this.refreshWatchlistTickers24h(this.symbols);
      } else if (this.tickers.size < 400 || this.tickersMissing24hRange()) {
        await this.refreshAllTickers24hRest();
      }
      return Response.json({ tickers: [...this.tickers.values()], updatedAt: this.tickerUpdatedAt });
    }

    if (url.pathname === '/regime') {
      const symbolsParam = url.searchParams.get('symbols');
      const wl = symbolsParam ? symbolsParam.split(',').map((s) => s.trim().toUpperCase()) : this.symbols;
      const regime = await this.computeRegime(wl);
      return Response.json(regime);
    }

    if (url.pathname === '/klines') {
      const symbol = url.searchParams.get('symbol')?.toUpperCase();
      const interval = url.searchParams.get('interval') as KlineInterval | null;
      const limit = Math.min(Number(url.searchParams.get('limit') ?? '35'), 40);
      if (!symbol || !interval) {
        return Response.json({ error: 'symbol and interval required' }, { status: 400 });
      }
      const klines = this.klines.getForScoring(symbol, interval, limit);
      const ready = klines.length > 0;
      return Response.json({ symbol, interval, klines, ready });
    }

    if (url.pathname === '/metrics') {
      const symbol = url.searchParams.get('symbol')?.toUpperCase();
      const maxAgeMs = Number(url.searchParams.get('maxAgeMs') ?? '30000');
      if (!symbol) return Response.json({ error: 'symbol required' }, { status: 400 });
      const m = this.obMetrics.get(symbol);
      if (!m || m.updatedAt === 0) {
        return Response.json({
          symbol,
          bidAskRatio: 0,
          spreadPct: 0,
          persistenceScore: 0,
          updatedAt: 0,
          stale: true,
        });
      }
      const stale = Date.now() - m.updatedAt > maxAgeMs;
      return Response.json({
        symbol,
        bidAskRatio: m.bidAskRatio,
        spreadPct: m.spreadPct,
        persistenceScore: m.persistenceScore,
        updatedAt: m.updatedAt,
        stale,
      });
    }

    if (url.pathname === '/book' || url.pathname === '/books') {
      const multi = url.pathname === '/books';
      const symbolsParam = url.searchParams.get('symbols');
      const symbols = multi
        ? (symbolsParam?.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) ?? [])
        : url.searchParams.get('symbol')
          ? [url.searchParams.get('symbol')!.toUpperCase()]
          : [];
      if (symbols.length === 0) {
        return Response.json({ error: multi ? 'symbols required' : 'symbol required' }, { status: 400 });
      }
      const books = symbols.map((symbol) => this.resolveBookQuote(symbol));
      if (multi) return Response.json({ books });
      return Response.json(books[0]!);
    }

    if (url.pathname === '/score') {
      const symbol = url.searchParams.get('symbol')?.toUpperCase();
      if (!symbol) return Response.json({ error: 'symbol required' }, { status: 400 });
      const cached = this.scores.get(symbol);
      if (cached) return Response.json({ symbol, ...cached });
      const live = this.runScore(symbol);
      if (!live) return Response.json({ symbol, score: '0', pass: false, failReason: 'no_data', updatedAt: 0 });
      return Response.json({ symbol, ...live });
    }

    if (url.pathname === '/tick-ref') {
      const symbol = url.searchParams.get('symbol')?.toUpperCase();
      if (!symbol) return Response.json({ error: 'symbol required' }, { status: 400 });
      const cfg = this.tickEntryConfigFromQuery(url);
      const declineCfg = this.tickDeclineConfigFromQuery(url);
      const reversalCfg = this.tickReversalConfigFromQuery(url);
      const aggCfg = this.tickAggFlowConfigFromQuery(url);
      const snap = this.evaluateTickSymbol(symbol, cfg, declineCfg, reversalCfg, aggCfg);
      if (!snap) {
        return Response.json({
          symbol,
          mid: null,
          candleLow: null,
          gainPct: null,
          stale: true,
        });
      }
      return Response.json(snap);
    }

    if (url.pathname === '/tick-rank') {
      const cfg = this.tickEntryConfigFromQuery(url);
      const declineCfg = this.tickDeclineConfigFromQuery(url);
      const reversalCfg = this.tickReversalConfigFromQuery(url);
      const aggCfg = this.tickAggFlowConfigFromQuery(url);
      const rows: TickScanRow[] = this.symbols
        .filter((s) => !TICK_SNIPER_SYMBOLS.has(s))
        .map((symbol) => this.evaluateTickSymbol(symbol, cfg, declineCfg, reversalCfg, aggCfg));
      rows.sort((a, b) => b.reversalScore - a.reversalScore);
      return Response.json({ rows });
    }

    return Response.json({
      service: 'MarketDataDO',
      endpoints: [
        'POST /symbols',
        'POST /seed',
        'GET /klines',
        'GET /metrics',
        'GET /tickers',
        'GET /regime',
        'GET /score',
        'GET /tick-ref',
        'GET /tick-rank',
        'GET /status',
      ],
    });
  }

  async alarm(): Promise<void> {
    if (this.symbols.length > 0) {
      const silent = this.lastMessageAt ? Date.now() - this.lastMessageAt > STALE_MS : true;
      if (silent) this.pool?.setStreams(buildMarketStreams(this.symbols));
    }
    await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
  }

  private async setSymbols(symbols: string[]): Promise<void> {
    const normalized = symbols
      .map((s) => s.toUpperCase())
      .filter((s) => s.endsWith('USDT'))
      .slice(0, MAX_SYMBOLS);
    this.symbols = [...new Set([...normalized, BTC_SYMBOL])].slice(0, MAX_SYMBOLS);

    for (const s of this.symbols) {
      if (!this.obMetrics.has(s)) {
        this.obMetrics.set(s, {
          bidAskRatio: 1,
          spreadPct: 0,
          spreadPctPrev: null,
          spreadHistory: [],
          bidAskRatioAtTrough: null,
          persistenceScore: 0,
          updatedAt: 0,
          topBidWall: null,
          bestBid: 0,
          bestAsk: 0,
        });
      }
    }

    if (!this.pool) {
      this.pool = new WsConnectionPool({
        onMessage: (data, stream) => this.onWsMessage(data, stream),
      });
    }
    this.pool.setStreams(buildMarketStreams(this.symbols));

    await this.backfillMissing();
    await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
  }

  private async backfillMissing(): Promise<void> {
    const intervals: KlineInterval[] = ['1m', '5m', '15m'];
    const base = this.env.BINANCE_BASE_URL ?? 'https://api.binance.com';
    for (const symbol of this.symbols) {
      for (const interval of intervals) {
        const key = `${symbol}:${interval}`;
        if (this.seeded.has(key) || this.klines.hasMinimum(symbol, interval, 20)) continue;
        try {
          const limits = interval === '1m' ? 35 : 30;
          const url = `${base}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limits}`;
          const res = await fetch(url);
          if (!res.ok) continue;
          const rows = (await res.json()) as unknown[][];
          const klines: Kline[] = rows.map((r) => ({
            openTime: r[0] as number,
            open: String(r[1]),
            high: String(r[2]),
            low: String(r[3]),
            close: String(r[4]),
            volume: String(r[5]),
            closeTime: r[6] as number,
            numberOfTrades: Number(r[8] ?? 0),
            takerBuyBaseVolume: String(r[9] ?? '0'),
            takerBuyQuoteVolume: String(r[10] ?? '0'),
          }));
          this.klines.seed(symbol, interval, klines);
          this.seeded.add(key);
        } catch {
          /* ignore */
        }
      }
    }
  }

  private onWsMessage(data: unknown, stream?: string): void {
    this.lastMessageAt = Date.now();
    this.messageCount++;

    if (stream?.includes('@bookTicker') || (data as { e?: string }).e === 'bookTicker') {
      this.onBookTicker(data, stream);
      return;
    }

    if (stream === '!ticker@arr' || (data as { e?: string }).e === '24hrTicker') {
      this.onTickerArr(data);
      return;
    }

    const aggTrade = parseAggTradeMessage(data, stream);
    if (aggTrade) {
      this.onAggTrade(aggTrade.symbol, aggTrade.aggressiveBuy, aggTrade.quoteUsdt);
      return;
    }

    const klineParsed = parseKlineEvent(data, stream);
    if (klineParsed) {
      const closed = this.klines.onKline(
        klineParsed.symbol,
        klineParsed.interval,
        klineParsed.kline,
        klineParsed.closed,
      );
      if (klineParsed.interval === '1m' && klineParsed.closed) {
        void this.on1mClosed(klineParsed.symbol);
      }
      if (klineParsed.symbol === BTC_SYMBOL && klineParsed.interval === '15m' && klineParsed.closed) {
        this.regimeUpdatedAt = 0;
      }
      return;
    }

    const depth = parseDepthMessage(data, stream);
    if (depth) {
      this.onDepth(depth.symbol, depth.bids, depth.asks);
    }
  }

  private onAggTrade(symbol: string, aggressiveBuy: boolean, quoteUsdt: number): void {
    if (!symbol.endsWith('USDT') || !Number.isFinite(quoteUsdt) || quoteUsdt <= 0) return;
    const retentionMs = Math.max(30, this.tickAggFlowConfig.windowSec * 3) * 1000;
    const now = Date.now();
    const prev = this.aggFlowHistory.get(symbol) ?? [];
    const next = appendAggFlowSample(
      prev,
      { t: now, quoteUsdt, aggressiveBuy },
      retentionMs,
    );
    this.aggFlowHistory.set(symbol, next);
    if (this.symbols.includes(symbol)) {
      this.maybeScheduleTickEval(symbol);
    }
  }

  private onBookTicker(data: unknown, stream?: string): void {
    const d = data as { s?: string; b?: string; a?: string };
    let sym = d.s?.toUpperCase();
    if (!sym && stream) {
      const head = stream.split('@')[0]?.toUpperCase();
      if (head?.endsWith('USDT')) sym = head;
    }
    if (!sym?.endsWith('USDT')) return;
    const bid = Number(d.b);
    const ask = Number(d.a);
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return;
    const midN = (bid + ask) / 2;
    const mid = midN.toFixed(8);
    const now = Date.now();
    const spreadPct = midN > 0 ? ((ask - bid) / midN) * 100 : 0;
    const prevOb = this.obMetrics.get(sym);
    this.obMetrics.set(sym, {
      bidAskRatio: prevOb?.bidAskRatio ?? 1,
      spreadPct,
      spreadPctPrev: prevOb?.spreadPct ?? null,
      spreadHistory: [...(prevOb?.spreadHistory ?? []), spreadPct].slice(-5),
      bidAskRatioAtTrough: prevOb?.bidAskRatioAtTrough ?? null,
      persistenceScore: prevOb?.persistenceScore ?? 0,
      updatedAt: now,
      topBidWall: prevOb?.topBidWall ?? null,
      bestBid: bid,
      bestAsk: ask,
    });
    const prev = this.tickers.get(sym);
    this.tickers.set(
      sym,
      mergeTicker24h(prev, { symbol: sym, lastPrice: mid }),
    );
    this.tickerUpdatedAt = now;
    if (this.symbols.includes(sym)) {
      this.recordMidSample(sym, midN);
      this.maybeScheduleTickEval(sym);
    }
  }

  /** bookTicker > taze depth > ticker > 1m kline */
  private resolveBookQuote(symbol: string): {
    symbol: string;
    mid: string | null;
    spreadPct: number | null;
    bid?: number;
    ask?: number;
    source: string | null;
  } {
    const m = this.obMetrics.get(symbol);
    const now = Date.now();
    if (m && m.bestBid > 0 && m.bestAsk > 0 && now - m.updatedAt <= 5_000) {
      const mid = (m.bestBid + m.bestAsk) / 2;
      return {
        symbol,
        mid: String(mid),
        spreadPct: m.spreadPct,
        bid: m.bestBid,
        ask: m.bestAsk,
        source: 'book',
      };
    }
    const ticker = this.tickers.get(symbol);
    if (ticker?.lastPrice && Number(ticker.lastPrice) > 0) {
      return {
        symbol,
        mid: ticker.lastPrice,
        spreadPct: m?.spreadPct ?? null,
        source: 'ticker',
      };
    }
    const k1 = this.klines.getForScoring(symbol, '1m', 1);
    const lastK = k1[k1.length - 1];
    if (lastK && Number(lastK.close) > 0) {
      return { symbol, mid: lastK.close, spreadPct: null, source: 'kline_1m' };
    }
    return { symbol, mid: null, spreadPct: null, source: null };
  }

  private recordMidSample(symbol: string, mid: number): void {
    const retentionMs = (this.tickDeclineConfig.referenceWindowSec + 90) * 1000;
    const nowMs = Date.now();
    const prev = this.midHistory.get(symbol) ?? [];
    const next = appendMidSample(prev, mid, nowMs, retentionMs);
    this.midHistory.set(symbol, next);

    const windowMs = this.tickDeclineConfig.referenceWindowSec * 1000;
    const inWindow = next.filter((s) => nowMs - s.t <= windowMs);
    if (inWindow.length === 0) return;
    let lowSample = inWindow[0]!;
    for (const s of inWindow) {
      if (s.mid < lowSample.mid) lowSample = s;
    }
    if (Math.abs(lowSample.mid - mid) / mid < 0.00005) {
      const ob = this.obMetrics.get(symbol);
      if (ob) {
        ob.bidAskRatioAtTrough = ob.bidAskRatio;
        this.obMetrics.set(symbol, ob);
      }
    }
  }

  private onTickerArr(data: unknown): void {
    let list: unknown[] = [];
    if (Array.isArray(data)) {
      list = data;
    } else if (data && typeof data === 'object') {
      const wrapped = data as { data?: unknown };
      if (Array.isArray(wrapped.data)) list = wrapped.data;
      else list = [data];
    }
    for (const item of list) {
      const t = item as TickerArrItem;
      const sym = t.s?.toUpperCase();
      if (!sym?.endsWith('USDT')) continue;
      const lastPrice = t.c ?? '0';
      if (!lastPrice || Number(lastPrice) <= 0) continue;
      const prev = this.tickers.get(sym);
      this.tickers.set(
        sym,
        mergeTicker24h(prev, {
          symbol: sym,
          lastPrice,
          quoteVolume: t.q ?? '0',
          priceChangePercent: t.P ?? '0',
          highPrice: t.h,
          lowPrice: t.l,
        }),
      );
    }
    if (list.length > 0) {
      this.tickerUpdatedAt = Date.now();
      this.regimeUpdatedAt = 0;
    }
  }

  private onDepth(symbol: string, bids: DepthLevel[], asks: DepthLevel[]): void {
    let bidQty = 0;
    let askQty = 0;
    let topBid: { price: string; qty: string } | null = null;
    let maxBidQty = 0;
    for (const [p, q] of bids) {
      const qty = Number(q);
      bidQty += qty;
      if (qty > maxBidQty) {
        maxBidQty = qty;
        topBid = { price: p, qty: q };
      }
    }
    for (const [, q] of asks) askQty += Number(q);
    if (askQty <= 0) return;

    const bestBid = Number(bids[0]![0]);
    const bestAsk = Number(asks[0]![0]);
    if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk) || bestBid <= 0 || bestAsk <= 0) {
      return;
    }
    const mid = (bestBid + bestAsk) / 2;
    const spreadPct = mid > 0 ? ((bestAsk - bestBid) / mid) * 100 : 0;
    const bidAskRatio = bidQty / askQty;
    const now = Date.now();
    const prev = this.obMetrics.get(symbol);
    let topBidWall = prev?.topBidWall ?? null;
    let persistenceScore = 0;

    if (topBid) {
      if (
        topBidWall &&
        topBidWall.price === topBid.price &&
        Math.abs(Number(topBidWall.qty) - Number(topBid.qty)) / Number(topBid.qty) < 0.15
      ) {
        const heldSec = (now - topBidWall.sinceMs) / 1000;
        persistenceScore = heldSec >= PERSISTENCE_SECONDS ? 1 : heldSec / PERSISTENCE_SECONDS;
      } else {
        topBidWall = { price: topBid.price, qty: topBid.qty, sinceMs: now };
      }
    }

    const spreadHist = [...(prev?.spreadHistory ?? []), spreadPct].slice(-5);
    this.obMetrics.set(symbol, {
      bidAskRatio,
      spreadPct,
      spreadPctPrev: prev?.spreadPct ?? null,
      spreadHistory: spreadHist,
      bidAskRatioAtTrough: prev?.bidAskRatioAtTrough ?? null,
      persistenceScore,
      updatedAt: now,
      topBidWall,
      bestBid,
      bestAsk,
    });
    if (this.symbols.includes(symbol)) {
      this.recordMidSample(symbol, mid);
      this.maybeScheduleTickEval(symbol);
    }
  }

  private maybeScheduleTickEval(symbol: string): void {
    if (TICK_SNIPER_SYMBOLS.has(symbol) || !this.symbols.includes(symbol)) return;
    const now = Date.now();
    const last = this.lastEvalScheduledMs.get(symbol) ?? 0;
    if (!shouldScheduleTickEval(now, last)) return;
    this.lastEvalScheduledMs.set(symbol, now);
    void this.runTickEvalForSymbol(symbol);
  }

  private async runTickEvalForSymbol(symbol: string): Promise<void> {
    const row = this.evaluateTickSymbol(symbol);
    if (!row.pass || !row.reversalOk || row.stale) return;

    const now = Date.now();
    const lastSym = this.lastSymbolFireMs.get(symbol) ?? 0;
    if (
      !canFireTickSignal({
        nowMs: now,
        lastGlobalFireMs: this.lastGlobalFireMs,
        lastSymbolFireMs: lastSym,
      })
    ) {
      return;
    }

    const base = this.env.WORKER_PUBLIC_URL?.replace(/\/$/, '');
    const secret = this.env.TRIGGER_SECRET;
    if (!base || !secret) return;

    this.lastGlobalFireMs = now;
    this.lastSymbolFireMs.set(symbol, now);

    const signalId = crypto.randomUUID();
    try {
      await fetch(`${base}/internal/tick-fire`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trigger-Secret': secret,
        },
        body: JSON.stringify({
          symbol,
          signalId,
          row,
          firedAtMs: now,
        }),
      });
    } catch {
      /* WS sniper fire failed — cooldown already applied */
    }
  }

  private async on1mClosed(symbol: string): Promise<void> {
    const result = this.runScore(symbol);
    if (result) {
      this.scores.set(symbol, result);
    }
  }

  private runScore(symbol: string): CachedScore | null {
    const k1 = this.klines.getForScoring(symbol, '1m', 35);
    if (k1.length < 10) return null;
    const k5 = this.klines.getForScoring(symbol, '5m', 30);
    const k15 = this.klines.getForScoring(symbol, '15m', 30);
    const ob = this.obMetrics.get(symbol);
    const orderbook =
      ob && ob.updatedAt > 0
        ? {
            symbol,
            bidAskRatio: ob.bidAskRatio,
            spreadPct: ob.spreadPct,
            persistenceScore: ob.persistenceScore,
            updatedAt: ob.updatedAt,
            stale: Date.now() - ob.updatedAt > 30_000,
          }
        : null;

    const result = computeMicroScalpScore({
      klines1m: k1,
      klines5m: this.scoreConfig.phase2Enabled ? k5 : undefined,
      klines15m: this.scoreConfig.phase2Enabled ? k15 : undefined,
      orderbook,
      depth: null,
      config: this.scoreConfig,
      nowMs: Date.now(),
      skipOpenCandleGate: true,
    });

    return {
      score: result.score,
      pass: result.pass,
      failReason: result.failReason,
      updatedAt: Date.now(),
    };
  }

  private async refreshWatchlistTickers24h(symbols: string[]): Promise<void> {
    if (symbols.length === 0) return;
    const base = this.env.BINANCE_BASE_URL ?? 'https://api.binance.com';
    try {
      const res = await fetch(`${base}/api/v3/ticker/24hr`);
      if (!res.ok) return;
      const all = (await res.json()) as Ticker24hr[];
      const set = new Set(symbols);
      for (const t of all) {
        if (!set.has(t.symbol)) continue;
        const live = this.tickers.get(t.symbol);
        this.tickers.set(
          t.symbol,
          mergeTicker24h(live, {
            symbol: t.symbol,
            lastPrice: t.lastPrice,
            quoteVolume: t.quoteVolume,
            priceChangePercent: t.priceChangePercent,
            highPrice: t.highPrice,
            lowPrice: t.lowPrice,
          }),
        );
      }
      this.tickerRestAt = Date.now();
      this.tickerUpdatedAt = Date.now();
      this.regimeUpdatedAt = 0;
    } catch {
      /* ignore */
    }
  }

  /** WS ticker arr low/high eksikse 24s aralık güvenilmez — REST ile doldur. */
  private tickersMissing24hRange(): boolean {
    let checked = 0;
    let missing = 0;
    for (const t of this.tickers.values()) {
      if (!t.symbol.endsWith('USDT')) continue;
      checked++;
      const high = Number(t.highPrice);
      const low = Number(t.lowPrice);
      if (!(high > low && low > 0)) missing++;
      if (checked >= 24) break;
    }
    return checked > 0 && missing >= Math.ceil(checked * 0.5);
  }

  private async refreshAllTickers24hRest(): Promise<void> {
    if (
      Date.now() - this.tickerRestAt < 60_000 &&
      this.tickers.size >= 400 &&
      !this.tickersMissing24hRange()
    ) {
      return;
    }
    const base = this.env.BINANCE_BASE_URL ?? 'https://api.binance.com';
    try {
      const res = await fetch(`${base}/api/v3/ticker/24hr`);
      if (!res.ok) return;
      const all = (await res.json()) as Ticker24hr[];
      for (const t of all) {
        if (!t.symbol.endsWith('USDT')) continue;
        const live = this.tickers.get(t.symbol);
        this.tickers.set(
          t.symbol,
          mergeTicker24h(live, {
            symbol: t.symbol,
            lastPrice: t.lastPrice,
            quoteVolume: t.quoteVolume,
            priceChangePercent: t.priceChangePercent,
            highPrice: t.highPrice,
            lowPrice: t.lowPrice,
          }),
        );
      }
      this.tickerRestAt = Date.now();
      this.tickerUpdatedAt = Date.now();
    } catch {
      /* ignore */
    }
  }

  private async computeRegime(watchlistSymbols: string[]): Promise<MarketRegimeResult> {
    if (this.regimeCache && Date.now() - this.regimeUpdatedAt < 30_000) {
      return this.regimeCache;
    }
    const btcKlines = this.klines.getForScoring(BTC_SYMBOL, '15m', 30);
    const breadthSymbols = watchlistSymbols.length > 0 ? watchlistSymbols : this.symbols;
    await this.refreshWatchlistTickers24h(breadthSymbols);
    const tickers: Ticker24hr[] = [];
    for (const sym of breadthSymbols) {
      const t = this.tickers.get(sym);
      if (t) tickers.push(t);
    }
    const breadthPct = computeBreadthFromTickers(tickers, breadthSymbols);
    this.regimeCache = detectMarketRegime({ btcKlines15m: btcKlines, breadthPct });
    this.regimeUpdatedAt = Date.now();
    return this.regimeCache;
  }

  private tickDeclineConfigFromQuery(url: URL): TickDeclineConfig {
    const windowSec = url.searchParams.get('referenceWindowSec');
    const minDecline = url.searchParams.get('minDeclinePct');
    const requireDecline = url.searchParams.get('requireWsDecline');
    const parsedWindow = windowSec ? Number(windowSec) : NaN;
    return {
      ...this.tickDeclineConfig,
      ...(Number.isFinite(parsedWindow)
        ? { referenceWindowSec: Math.min(600, Math.max(30, parsedWindow)) }
        : {}),
      ...(minDecline ? { minDeclinePct: minDecline } : {}),
      ...(requireDecline != null
        ? { requireWsDecline: requireDecline === 'true' }
        : {}),
    };
  }

  private tickEntryConfigFromQuery(url: URL): TickEntryConfig {
    const minGain = url.searchParams.get('minGainPct');
    const maxGain = url.searchParams.get('maxGainPct');
    const obRatio = url.searchParams.get('minOrderbookRatio');
    const maxSpread = url.searchParams.get('maxSpreadPct');
    const maxObAge = url.searchParams.get('maxObAgeMs');
    const req5m = url.searchParams.get('require5mAlignment');
    const req5mLight = url.searchParams.get('require5mLight');
    return {
      ...this.tickEntryConfig,
      ...(minGain ? { minGainPct: minGain } : {}),
      ...(maxGain ? { maxGainPct: maxGain } : {}),
      ...(obRatio && Number.isFinite(Number(obRatio))
        ? { minOrderbookRatio: Number(obRatio) }
        : {}),
      ...(maxSpread ? { maxSpreadPct: maxSpread } : {}),
      ...(maxObAge && Number.isFinite(Number(maxObAge))
        ? { maxObAgeMs: Number(maxObAge) }
        : {}),
      ...(req5m != null ? { require5mAlignment: req5m === 'true' } : {}),
      ...(req5mLight != null ? { require5mLight: req5mLight === 'true' } : {}),
    };
  }

  private tickReversalConfigFromQuery(url: URL): TickReversalConfig {
    const recovery = url.searchParams.get('recoveryMinPct');
    const minSec = url.searchParams.get('minSecAfterTrough');
    const maxSec = url.searchParams.get('maxSecAfterTrough');
    const spreadTight = url.searchParams.get('requireSpreadTightening');
    const obRatio = url.searchParams.get('obRatioAtRecoveryMin');
    const slopeN = url.searchParams.get('midSlopeSampleCount');
    const slopeMin = url.searchParams.get('midSlopeMinRising');
    const noNewLow = url.searchParams.get('noNewLowSec');
    return {
      ...this.tickReversalConfig,
      ...(recovery ? { recoveryMinPct: recovery } : {}),
      ...(minSec && Number.isFinite(Number(minSec))
        ? { minSecAfterTrough: Number(minSec) }
        : {}),
      ...(maxSec && Number.isFinite(Number(maxSec))
        ? { maxSecAfterTrough: Number(maxSec) }
        : {}),
      ...(spreadTight != null
        ? { requireSpreadTightening: spreadTight === 'true' }
        : {}),
      ...(obRatio ? { obRatioAtRecoveryMin: obRatio } : {}),
      ...(slopeN && Number.isFinite(Number(slopeN))
        ? { midSlopeSampleCount: Number(slopeN) }
        : {}),
      ...(slopeMin && Number.isFinite(Number(slopeMin))
        ? { midSlopeMinRising: Number(slopeMin) }
        : {}),
      ...(noNewLow && Number.isFinite(Number(noNewLow))
        ? { noNewLowSec: Number(noNewLow) }
        : {}),
    };
  }

  private tickAggFlowConfigFromQuery(url: URL): TickAggFlowConfig {
    const enabled = url.searchParams.get('aggBurstEnabled');
    const windowSec = url.searchParams.get('aggWindowSec');
    const buyCountMin = url.searchParams.get('aggBuyCountMin');
    const buyQuoteMinUsdt = url.searchParams.get('aggBuyQuoteMinUsdt');
    const imbalanceMin = url.searchParams.get('aggImbalanceMin');
    return {
      ...this.tickAggFlowConfig,
      ...(enabled != null ? { enabled: enabled === 'true' } : {}),
      ...(windowSec && Number.isFinite(Number(windowSec))
        ? { windowSec: Number(windowSec) }
        : {}),
      ...(buyCountMin && Number.isFinite(Number(buyCountMin))
        ? { buyCountMin: Number(buyCountMin) }
        : {}),
      ...(buyQuoteMinUsdt ? { buyQuoteMinUsdt } : {}),
      ...(imbalanceMin ? { imbalanceMin } : {}),
    };
  }

  private evaluateTickSymbol(
    symbol: string,
    config?: TickEntryConfig,
    declineConfig?: TickDeclineConfig,
    reversalConfig?: TickReversalConfig,
    aggFlowConfig?: TickAggFlowConfig,
  ): TickScanRow {
    const cfg = config ?? this.tickEntryConfig;
    const declineCfg = declineConfig ?? this.tickDeclineConfig;
    const reversalCfg = reversalConfig ?? this.tickReversalConfig;
    const aggCfg = aggFlowConfig ?? this.tickAggFlowConfig;
    const staleRow = (failReason: string): TickScanRow => ({
      symbol,
      mid: '',
      candleLow: '',
      candleOpen: '',
      candleOpenTime: 0,
      candleIsClosed: true,
      gainPct: null,
      bidAskRatio: 0,
      spreadPct: 0,
      pass: false,
      failReason,
      trend5mOk: false,
      trend5mFailReason: failReason,
      wsDeclinePct: null,
      wsDeclineOk: false,
      wsDeclineFailReason: failReason,
      recoveryFromWsLowPct: null,
      midSlopeOk: false,
      secSinceTrough: null,
      reversalScore: 0,
      reversalOk: false,
      reversalFailReason: failReason,
      aggBurstOk: false,
      aggBurstFailReason: failReason,
      aggBuyCount: 0,
      aggBuyQuoteUsdt: null,
      aggSellQuoteUsdt: null,
      aggImbalance: null,
      updatedAt: 0,
      stale: true,
    });

    const active = this.klines.getActiveCandle(symbol, '1m');
    if (!active) return staleRow('no_candle');

    const midNum = this.resolveMidNumeric(symbol);
    const ob = this.obMetrics.get(symbol);
    const maxAge = cfg.maxObAgeMs;
    const obSnap = ob
      ? {
          bidAskRatio: ob.bidAskRatio,
          spreadPct: ob.spreadPct,
          updatedAt: ob.updatedAt,
          stale: ob.updatedAt === 0 || Date.now() - ob.updatedAt > maxAge,
        }
      : null;

    const need5mAlign = cfg.require5mAlignment;
    const need5mLight = cfg.require5mLight && !need5mAlign;
    const need5m = need5mAlign || need5mLight;
    const samples = this.midHistory.get(symbol) ?? [];
    const declineEval = evaluateWsDecline({
      samples,
      currentMid: midNum != null ? String(midNum) : '',
      config: declineCfg,
    });
    const wsLow =
      declineEval.windowLow != null ? String(declineEval.windowLow) : active.candle.low;

    const evalResult = evaluateTickEntry({
      candle: active.candle,
      candleIsClosed: active.isClosed,
      candle5m: need5m ? this.klines.getActiveCandle(symbol, '5m') : null,
      klines5m: need5m ? this.klines.getSeries(symbol, '5m', 30, true) : [],
      mid: midNum != null ? String(midNum) : null,
      orderbook: obSnap,
      config: cfg,
      wsWindowLow: wsLow,
    });

    const obAge = ob?.updatedAt ?? 0;
    const klineAge1m = this.klines.getLastUpdateAgeMs(symbol, '1m');
    const klineAge5m = this.klines.getLastUpdateAgeMs(symbol, '5m');
    const stale =
      evalResult.orderbookStale ||
      (klineAge1m != null && klineAge1m > 90_000) ||
      (need5m && klineAge5m != null && klineAge5m > 120_000) ||
      (obAge > 0 && Date.now() - obAge > maxAge);

    let pass = evalResult.pass && !stale;
    let failReason = evalResult.failReason;
    if (pass && declineCfg.requireWsDecline && !declineEval.ok) {
      pass = false;
      failReason = declineEval.failReason ?? 'ws_decline_not_met';
    }

    let reversalEval = evaluateTickReversal({
      samples,
      currentMid: evalResult.mid,
      windowLow: declineEval.windowLow ?? evalResult.candleLow,
      troughTimeMs: declineEval.troughTimeMs ?? active.candle.openTime,
      config: reversalCfg,
      ob: ob
        ? {
            spreadPct: ob.spreadPct,
            spreadPctPrev: ob.spreadPctPrev,
            spreadHistory: ob.spreadHistory,
            bidAskRatio: ob.bidAskRatio,
            bidAskRatioAtTrough: ob.bidAskRatioAtTrough,
          }
        : undefined,
    });

    if (pass && !reversalEval.ok) {
      pass = false;
      failReason = reversalEval.failReason ?? 'reversal_not_met';
    }

    const aggSamples = this.aggFlowHistory.get(symbol) ?? [];
    const aggEval = evaluateTickAggFlow(aggSamples, aggCfg);
    if (pass && !aggEval.ok) {
      pass = false;
      failReason = aggEval.failReason ?? 'agg_burst_not_met';
    }

    return {
      symbol,
      mid: evalResult.mid,
      candleLow: evalResult.candleLow,
      candleOpen: evalResult.candleOpen,
      candleOpenTime: evalResult.candleOpenTime,
      candleIsClosed: evalResult.candleIsClosed,
      gainPct: evalResult.gainFromCandleLowPct,
      bidAskRatio: evalResult.bidAskRatio,
      spreadPct: evalResult.spreadPct,
      pass,
      failReason,
      trend5mOk: evalResult.trend5mOk,
      trend5mFailReason: evalResult.trend5mFailReason,
      wsDeclinePct: declineEval.declinePct,
      wsDeclineOk: declineEval.ok,
      wsDeclineFailReason: declineEval.failReason,
      recoveryFromWsLowPct: reversalEval.recoveryFromWsLowPct,
      midSlopeOk: reversalEval.midSlopeOk,
      secSinceTrough: reversalEval.secSinceTrough,
      reversalScore: reversalEval.reversalScore,
      reversalOk: reversalEval.ok,
      reversalFailReason: reversalEval.failReason,
      aggBurstOk: aggEval.ok,
      aggBurstFailReason: aggEval.failReason,
      aggBuyCount: aggEval.buyCount,
      aggBuyQuoteUsdt: aggEval.buyQuoteUsdt,
      aggSellQuoteUsdt: aggEval.sellQuoteUsdt,
      aggImbalance: aggEval.imbalance,
      updatedAt: Math.max(
        obAge,
        klineAge1m ? Date.now() - klineAge1m : 0,
        klineAge5m ? Date.now() - klineAge5m : 0,
      ),
      stale,
    };
  }

  private resolveMidNumeric(symbol: string): number | null {
    const ob = this.obMetrics.get(symbol);
    if (ob && ob.bestBid > 0 && ob.bestAsk > 0) return (ob.bestBid + ob.bestAsk) / 2;
    const t = this.tickers.get(symbol);
    if (t?.lastPrice && Number(t.lastPrice) > 0) return Number(t.lastPrice);
    const k1 = this.klines.getForScoring(symbol, '1m', 1);
    const lastK = k1[k1.length - 1];
    if (lastK && Number(lastK.close) > 0) return Number(lastK.close);
    return null;
  }

  private buildStatus(): MarketDataStatus {
    const now = Date.now();
    const rows: MarketDataStatusRow[] = this.symbols
      .filter((s) => s !== BTC_SYMBOL || this.symbols.length === 1)
      .map((symbol) => {
        const ob = this.obMetrics.get(symbol);
        const obAge = ob?.updatedAt ? now - ob.updatedAt : -1;
        const k1 = this.klines.getLastUpdateAgeMs(symbol, '1m');
        const sc = this.scores.get(symbol);
        return {
          symbol,
          bidAskRatio: ob?.bidAskRatio ?? 0,
          spreadPct: ob?.spreadPct ?? 0,
          persistenceScore: ob?.persistenceScore ?? 0,
          obAgeMs: obAge,
          kline1mAgeMs: k1,
          kline5mAgeMs: this.klines.getLastUpdateAgeMs(symbol, '5m'),
          kline15mAgeMs: this.klines.getLastUpdateAgeMs(symbol, '15m'),
          stale: obAge < 0 || obAge > STALE_MS,
          liveScore: sc?.score ?? null,
        };
      });

    return {
      symbolCount: this.symbols.length,
      wsShards: this.pool?.getStatus() ?? [],
      tickerCount: this.tickers.size,
      tickerUpdatedAt: this.tickerUpdatedAt,
      lastMessageAt: this.lastMessageAt,
      messageCount: this.messageCount,
      regime: this.regimeCache,
      symbols: rows.sort((a, b) => (a.kline1mAgeMs ?? 999999) - (b.kline1mAgeMs ?? 999999)),
    };
  }
}

function defaultTickEntryConfig(): TickEntryConfig {
  return {
    minGainPct: '0.15',
    maxGainPct: '0.45',
    minOrderbookRatio: 1.05,
    maxSpreadPct: '0.08',
    maxObAgeMs: 30_000,
    requireOpenCandle: true,
    require5mAlignment: false,
    require5mLight: true,
    useWsLowForGainBand: true,
  };
}

function defaultScoreConfig(): MicroScalpConfig {
  return {
    entryMinScore: 0.75,
    volumeRatioMin: 2.2,
    orderbookRatioMin: 1.4,
    aggressionMin: 0.65,
    phase2Enabled: true,
    weights: DEFAULT_MICRO_WEIGHTS,
    trend15mGateMode: 'penalty',
    trend15mPenalty: 0.1,
  };
}

function computeBreadthFromTickers(tickers: Ticker24hr[], symbols: string[]): string {
  const set = new Set(symbols);
  let up = 0;
  let total = 0;
  for (const t of tickers) {
    if (!set.has(t.symbol)) continue;
    total++;
    if (Number(t.priceChangePercent) > 0) up++;
  }
  if (total === 0) return '0';
  return ((up / total) * 100).toFixed(2);
}

function parseAggTradeMessage(
  data: unknown,
  stream?: string,
): { symbol: string; aggressiveBuy: boolean; quoteUsdt: number } | null {
  const d = data as { e?: string; s?: string; m?: boolean; p?: string; q?: string };
  let symbol = d.s?.toUpperCase();
  if (!symbol && stream) {
    const head = stream.split('@')[0]?.toUpperCase();
    if (head?.endsWith('USDT')) symbol = head;
  }
  if (!symbol?.endsWith('USDT')) return null;
  if ((d.e && d.e !== 'aggTrade') || d.m == null) return null;
  const price = Number(d.p ?? 0);
  const qty = Number(d.q ?? 0);
  if (!Number.isFinite(price) || !Number.isFinite(qty) || price <= 0 || qty <= 0) return null;
  return {
    symbol,
    aggressiveBuy: d.m === false,
    quoteUsdt: price * qty,
  };
}
