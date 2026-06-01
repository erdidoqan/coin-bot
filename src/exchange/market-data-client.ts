/** Worker → MarketDataDO RPC istemcisi */

import type { Kline, Ticker24hr } from './binance';
import type { MarketDataStatus } from '../durable-objects/market-data-do';
import type { MarketRegimeResult } from '../indicators/market-regime';
import type { MicroScalpConfig } from '../indicators/micro-scalp';
import type { TickEntryConfig } from '../indicators/tick-entry';
import type { TickRefSnapshot, TickScanRow } from '../durable-objects/market-data-do';

export type { TickRefSnapshot, TickScanRow };

export interface OrderbookMetrics {
  symbol: string;
  bidAskRatio: number;
  spreadPct: number;
  persistenceScore: number;
  updatedAt: number;
  stale: boolean;
}

export interface DoCachedScore {
  symbol: string;
  score: string;
  pass: boolean;
  failReason: string | null;
  updatedAt: number;
}

function marketDataStub(env: Env) {
  if (!env.MARKET_DATA) return null;
  const id = env.MARKET_DATA.idFromName('binance-spot');
  return env.MARKET_DATA.get(id);
}

export interface SyncMarketDataOptions {
  scoreConfig?: Partial<MicroScalpConfig>;
  tickEntryConfig?: Partial<TickEntryConfig>;
  tickDeclineConfig?: Partial<import('../indicators/tick-decline').TickDeclineConfig>;
  tickReversalConfig?: Partial<import('../indicators/tick-reversal').TickReversalConfig>;
  tickAggFlowConfig?: Partial<import('../indicators/tick-agg-flow').TickAggFlowConfig>;
}

export async function syncMarketDataSymbols(
  env: Env,
  symbols: string[],
  options?: Partial<MicroScalpConfig> | SyncMarketDataOptions,
): Promise<{ ok: boolean; count: number } | null> {
  const stub = marketDataStub(env);
  if (!stub || symbols.length === 0) return null;
  const payload =
    options &&
    ('tickEntryConfig' in options ||
      'scoreConfig' in options ||
      'tickDeclineConfig' in options ||
      'tickReversalConfig' in options ||
      'tickAggFlowConfig' in options)
      ? (options as SyncMarketDataOptions)
      : { scoreConfig: options as Partial<MicroScalpConfig> | undefined };
  const res = await stub.fetch('https://do.internal/symbols', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      symbols,
      scoreConfig: payload.scoreConfig,
      tickEntryConfig: payload.tickEntryConfig,
      tickDeclineConfig: payload.tickDeclineConfig,
      tickReversalConfig: payload.tickReversalConfig,
      tickAggFlowConfig: payload.tickAggFlowConfig,
    }),
  });
  if (!res.ok) return null;
  return res.json<{ ok: boolean; count: number }>();
}

export async function ensureMarketDataWatchlist(
  env: Env,
  symbols: string[],
  options?: Partial<MicroScalpConfig> | SyncMarketDataOptions,
): Promise<void> {
  await syncMarketDataSymbols(env, symbols, options);
}

export async function fetchTickRank(
  env: Env,
  tick?: TickQueryConfig,
): Promise<{ rows: TickScanRow[] } | null> {
  const stub = marketDataStub(env);
  if (!stub) return null;
  const url = new URL('https://do.internal/tick-rank');
  if (tick) appendTickScanQuery(url, tick);
  const res = await stub.fetch(url.toString());
  if (!res.ok) return null;
  return res.json<{ rows: TickScanRow[] }>();
}

type TickQueryConfig = import('../db/bot-config').TickScalpConfig;

function appendTickScanQuery(url: URL, tick: TickQueryConfig): void {
  url.searchParams.set('minGainPct', tick.entryGainPct);
  url.searchParams.set('maxGainPct', tick.entryGainMaxPct);
  url.searchParams.set('minOrderbookRatio', String(tick.orderbookRatioMin));
  url.searchParams.set('maxSpreadPct', tick.maxSpreadPct);
  url.searchParams.set('maxObAgeMs', String(tick.maxObAgeMs));
  url.searchParams.set('referenceWindowSec', String(tick.referenceWindowSec));
  url.searchParams.set('minDeclinePct', tick.declineMinPct);
  url.searchParams.set('requireWsDecline', tick.requireWsDecline ? 'true' : 'false');
  url.searchParams.set('require5mAlignment', tick.require5mAlignment ? 'true' : 'false');
  url.searchParams.set('require5mLight', tick.require5mLight ? 'true' : 'false');
  url.searchParams.set('recoveryMinPct', tick.recoveryMinPct);
  url.searchParams.set('minSecAfterTrough', String(tick.minSecAfterTrough));
  url.searchParams.set('maxSecAfterTrough', String(tick.maxSecAfterTrough));
  url.searchParams.set('requireSpreadTightening', tick.requireSpreadTightening ? 'true' : 'false');
  url.searchParams.set('obRatioAtRecoveryMin', tick.obRatioAtRecoveryMin);
  url.searchParams.set('midSlopeSampleCount', String(tick.midSlopeSampleCount));
  url.searchParams.set('midSlopeMinRising', String(tick.midSlopeMinRising));
  url.searchParams.set('noNewLowSec', String(tick.noNewLowSec));
  url.searchParams.set('aggBurstEnabled', tick.aggBurstEnabled ? 'true' : 'false');
  url.searchParams.set('aggWindowSec', String(tick.aggWindowSec));
  url.searchParams.set('aggBuyCountMin', String(tick.aggBuyCountMin));
  url.searchParams.set('aggBuyQuoteMinUsdt', tick.aggBuyQuoteMinUsdt);
  url.searchParams.set('aggImbalanceMin', tick.aggImbalanceMin);
}

export async function fetchTickRef(
  env: Env,
  symbol: string,
  tick?: TickQueryConfig,
): Promise<TickRefSnapshot | null> {
  const stub = marketDataStub(env);
  if (!stub) return null;
  const url = new URL('https://do.internal/tick-ref');
  url.searchParams.set('symbol', symbol);
  if (tick) appendTickScanQuery(url, tick);
  const res = await stub.fetch(url.toString());
  if (!res.ok) return null;
  const body = await res.json<TickRefSnapshot & { mid?: string | null }>();
  if (!body.mid || body.stale) return null;
  return body;
}

export async function fetchMarketDataStatus(env: Env): Promise<MarketDataStatus | null> {
  const stub = marketDataStub(env);
  if (!stub) return null;
  const res = await stub.fetch('https://do.internal/status');
  if (!res.ok) return null;
  return res.json<MarketDataStatus>();
}

/** Readiness için yeterli 5m bar: DO kısa kalırsa REST ile 24s tamamlanır. */
export async function fetchReadinessKlines(
  env: Env,
  client: { getKlines(symbol: string, interval: string, limit: number): Promise<Kline[]> },
  symbol: string,
  opts: {
    lookbackBars: number;
    stabilityBars: number;
    needFullStability: boolean;
  },
): Promise<Kline[] | null> {
  const klineBars = Math.max(opts.lookbackBars, opts.stabilityBars);
  const doLimit = Math.min(120, klineBars);
  let raw = await fetchKlinesFromDo(env, symbol, '5m', doLimit);
  const needRest =
    opts.needFullStability && klineBars > (raw?.length ?? 0);
  if (!raw || raw.length < 20 || needRest) {
    try {
      const rest = await client.getKlines(symbol, '5m', klineBars);
      if (!raw || rest.length > raw.length) raw = rest;
    } catch {
      if (!raw || raw.length < 20) return null;
    }
  }
  return raw && raw.length >= 20 ? raw : null;
}

export async function fetchKlinesFromDo(
  env: Env,
  symbol: string,
  interval: '1m' | '5m' | '15m',
  limit: number,
): Promise<Kline[] | null> {
  const stub = marketDataStub(env);
  if (!stub) return null;
  const url = new URL('https://do.internal/klines');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('interval', interval);
  url.searchParams.set('limit', String(limit));
  const res = await stub.fetch(url.toString());
  if (!res.ok) return null;
  const body = await res.json<{ klines: Kline[]; ready: boolean }>();
  return body.ready ? body.klines : body.klines.length > 0 ? body.klines : null;
}

export async function fetchTickersFromDo(env: Env): Promise<Ticker24hr[] | null> {
  const stub = marketDataStub(env);
  if (!stub) return null;
  const res = await stub.fetch('https://do.internal/tickers');
  if (!res.ok) return null;
  const body = await res.json<{ tickers: Ticker24hr[] }>();
  return body.tickers;
}

export async function fetchRegimeFromDo(
  env: Env,
  watchlistSymbols: string[],
): Promise<MarketRegimeResult | null> {
  const stub = marketDataStub(env);
  if (!stub) return null;
  const url = new URL('https://do.internal/regime');
  if (watchlistSymbols.length > 0) {
    url.searchParams.set('symbols', watchlistSymbols.join(','));
  }
  const res = await stub.fetch(url.toString());
  if (!res.ok) return null;
  return res.json<MarketRegimeResult>();
}

export async function fetchSymbolMidPrice(env: Env, symbol: string): Promise<string | null> {
  const stub = marketDataStub(env);
  if (!stub) return null;
  const url = new URL('https://do.internal/book');
  url.searchParams.set('symbol', symbol);
  const res = await stub.fetch(url.toString());
  if (!res.ok) return null;
  const body = await res.json<{ mid: string | null }>();
  return body.mid;
}

export async function fetchOrderbookMetrics(
  env: Env,
  symbol: string,
  maxAgeMs = 30_000,
): Promise<OrderbookMetrics | null> {
  const stub = marketDataStub(env);
  if (!stub) return null;
  const url = new URL('https://do.internal/metrics');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('maxAgeMs', String(maxAgeMs));
  const res = await stub.fetch(url.toString());
  if (!res.ok) return null;
  return res.json<OrderbookMetrics>();
}

export async function fetchScoreFromDo(env: Env, symbol: string): Promise<DoCachedScore | null> {
  const stub = marketDataStub(env);
  if (!stub) return null;
  const url = new URL('https://do.internal/score');
  url.searchParams.set('symbol', symbol);
  const res = await stub.fetch(url.toString());
  if (!res.ok) return null;
  return res.json<DoCachedScore>();
}
