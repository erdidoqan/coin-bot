import type { BinanceClient, Kline, Ticker24hr } from '../exchange/binance';
import type { MomentumConfig } from '../db/bot-config';
import type { TradingGateway } from '../exchange/gateway';
import { bn } from '../math/decimal';
import {
  CONTINUATION_WINDOWS,
  analyzeTripleContinuation,
  analyzeLastPairContinuation,
  analyzeTen5mContinuation,
  aggregateContinuation,
  type ContinuationWindowResult,
  type ContinuationConfig,
} from './continuation-momentum';

export { CONTINUATION_WINDOWS as MOMENTUM_WINDOWS };

export interface WindowTrendResult {
  label: string;
  interval: string;
  gainPct: string;
  passed: boolean;
  pullbackPct?: string;
  recoveryPct?: string;
  failReason?: string | null;
}

export function continuationToWindowTrend(w: ContinuationWindowResult): WindowTrendResult {
  return {
    label: w.label,
    interval: w.interval,
    gainPct: w.recoveryPct,
    passed: w.passed,
    pullbackPct: w.pullbackPct,
    recoveryPct: w.recoveryPct,
    failReason: w.failReason,
  };
}

function passesDailyCap(ticker: Ticker24hr | undefined, maxDailyChangePct: string): boolean {
  if (!ticker) return true;
  const change = bn(ticker.priceChangePercent);
  const max = bn(maxDailyChangePct);
  return change.gt(0) && change.lte(max);
}

export function buildContinuationConfig(
  momentum: MomentumConfig,
  extras: {
    minGreenWindows: number;
    maxPullbackPct: string;
    requireShortTf: boolean;
  },
): ContinuationConfig {
  return {
    minRecoveryPct: momentum.minWindowGainPct,
    maxPullbackPct: extras.maxPullbackPct,
    minGreenWindows: extras.minGreenWindows,
    requireShortTf: extras.requireShortTf,
  };
}

export interface MultiTfMomentumResult {
  passed: boolean;
  windows: WindowTrendResult[];
  dailyChangePct: string | null;
  failReason: string | null;
  continuationScore: string;
  avgRecoveryPct: string;
  greenCount: number;
  entryEligible: boolean;
  continuationPassed: boolean;
}

export async function checkMultiTfMomentum(
  client: BinanceClient,
  symbol: string,
  momentumConfig: MomentumConfig,
  continuationExtras: {
    minGreenWindows: number;
    maxPullbackPct: string;
    requireShortTf: boolean;
  },
  ticker?: Ticker24hr,
): Promise<MultiTfMomentumResult> {
  const config = buildContinuationConfig(momentumConfig, continuationExtras);
  const contWindows: ContinuationWindowResult[] = [];
  let fetched5mTriple: Kline[] | null = null;
  const pairCache = new Map<string, Kline[]>();

  for (const spec of CONTINUATION_WINDOWS) {
    let result: ContinuationWindowResult | null = null;

    if (spec.mode === 'ten5m') {
      if (!fetched5mTriple) fetched5mTriple = await client.getKlines(symbol, '5m', spec.limit);
      result = analyzeTen5mContinuation(fetched5mTriple, config);
    } else if (spec.mode === 'lastPair') {
      let klines = pairCache.get(spec.interval);
      if (!klines) {
        klines = await client.getKlines(symbol, spec.interval, spec.limit);
        pairCache.set(spec.interval, klines);
      }
      result = analyzeLastPairContinuation(klines, spec.label, spec.interval, config);
    } else {
      const klines = await client.getKlines(symbol, spec.interval, spec.limit);
      result = analyzeTripleContinuation(klines, spec.label, spec.interval, config);
    }

    if (!result) {
      return {
        passed: false,
        windows: contWindows.map(continuationToWindowTrend),
        dailyChangePct: ticker?.priceChangePercent ?? null,
        failReason: `no_data_${spec.label}`,
        continuationScore: '0',
        avgRecoveryPct: '0',
        greenCount: contWindows.filter((w) => w.passed).length,
        entryEligible: false,
        continuationPassed: false,
      };
    }
    contWindows.push(result);
  }

  if (!passesDailyCap(ticker, momentumConfig.maxDailyChangePct)) {
    const agg = aggregateContinuation(contWindows, config);
    return {
      passed: false,
      windows: agg.windows.map(continuationToWindowTrend),
      dailyChangePct: ticker?.priceChangePercent ?? null,
      failReason: 'daily_change_cap',
      continuationScore: agg.continuationScore,
      avgRecoveryPct: agg.avgRecoveryPct,
      greenCount: agg.greenCount,
      entryEligible: false,
      continuationPassed: false,
    };
  }

  const agg = aggregateContinuation(contWindows, config);
  return {
    passed: agg.entryEligible,
    windows: agg.windows.map(continuationToWindowTrend),
    dailyChangePct: ticker?.priceChangePercent ?? null,
    failReason: agg.failReason,
    continuationScore: agg.continuationScore,
    avgRecoveryPct: agg.avgRecoveryPct,
    greenCount: agg.greenCount,
    entryEligible: agg.entryEligible,
    continuationPassed: agg.continuationPassed,
  };
}

export interface BatchMomentumItem {
  symbol: string;
  passed: boolean;
  detail: MultiTfMomentumResult;
}

export interface MomentumScoreSummary {
  scorePct: string;
  passedCount: number;
  totalWindows: number;
  minGainPct: string;
  maxGainPct: string;
  greenCount: number;
  continuationScore: string;
}

export function computeMomentumScore(detail: MultiTfMomentumResult): MomentumScoreSummary {
  const windows = detail.windows;
  const recoveries = windows.map((w) => bn(w.recoveryPct ?? w.gainPct));
  const passedCount = windows.filter((w) => w.passed).length;
  let min = recoveries[0] ?? bn(0);
  let max = recoveries[0] ?? bn(0);
  for (const g of recoveries) {
    if (g.lt(min)) min = g;
    if (g.gt(max)) max = g;
  }
  return {
    scorePct: detail.avgRecoveryPct,
    continuationScore: detail.continuationScore,
    passedCount,
    totalWindows: windows.length,
    minGainPct: min.toFixed(4),
    maxGainPct: max.toFixed(4),
    greenCount: detail.greenCount,
  };
}

export interface RankedMomentumItem extends BatchMomentumItem {
  rank: number;
  score: MomentumScoreSummary;
  isBest: boolean;
  entryEligible: boolean;
}

export function rankMomentumResults(items: BatchMomentumItem[]): RankedMomentumItem[] {
  const scored = items.map((item) => {
    const score = computeMomentumScore(item.detail);
    return {
      ...item,
      score,
      entryEligible: item.detail.entryEligible,
      rank: 0,
      isBest: false,
    };
  });

  scored.sort((a, b) => {
    if (a.entryEligible !== b.entryEligible) return a.entryEligible ? -1 : 1;
    return bn(b.score.scorePct).minus(a.score.scorePct).toNumber();
  });

  return scored.map((item, i) => ({
    ...item,
    rank: i + 1,
    isBest: i === 0,
    passed: item.entryEligible,
  }));
}

export interface ParsedMomentumDetail {
  passed: boolean;
  scorePct: string;
  continuationScore: string;
  rank: number | null;
  passedCount: number;
  greenCount: number;
  entryScore: string;
  avgRecoveryPct: string;
  entryEligible: boolean;
  continuationPassed: boolean;
  failReason: string | null;
  dailyChangePct: string | null;
  windows: WindowTrendResult[];
}

export function parseMomentumDetailJson(raw: string | null): ParsedMomentumDetail | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    const windows = (p.windows as WindowTrendResult[]) ?? [];
    const continuationScore =
      typeof p.continuationScore === 'string' ? p.continuationScore : '0';
    const avgRecoveryPct =
      typeof p.avgRecoveryPct === 'string'
        ? p.avgRecoveryPct
        : typeof p.scorePct === 'string'
          ? p.scorePct
          : continuationScore;
    const entryScore =
      typeof p.entryScore === 'string' ? p.entryScore : continuationScore;
    return {
      passed: Boolean(p.entryEligible ?? p.passed),
      scorePct: avgRecoveryPct,
      avgRecoveryPct,
      continuationScore,
      entryScore,
      rank: typeof p.rank === 'number' ? p.rank : null,
      passedCount: typeof p.passedCount === 'number' ? p.passedCount : 0,
      greenCount: typeof p.greenCount === 'number' ? p.greenCount : 0,
      entryEligible: Boolean(p.entryEligible ?? p.passed),
      continuationPassed: Boolean(p.continuationPassed ?? p.entryEligible ?? p.passed),
      failReason: typeof p.failReason === 'string' ? p.failReason : null,
      dailyChangePct: typeof p.dailyChangePct === 'string' ? p.dailyChangePct : null,
      windows,
    };
  } catch {
    return null;
  }
}

export function buildMomentumDetailPayload(item: RankedMomentumItem): Record<string, unknown> {
  return {
    passed: item.entryEligible,
    entryEligible: item.entryEligible,
    continuationPassed: item.detail.continuationPassed,
    failReason: item.detail.failReason,
    dailyChangePct: item.detail.dailyChangePct,
    windows: item.detail.windows,
    scorePct: item.score.scorePct,
    avgRecoveryPct: item.detail.avgRecoveryPct,
    continuationScore: item.score.continuationScore,
    entryScore: item.score.continuationScore,
    passedCount: item.score.passedCount,
    greenCount: item.score.greenCount,
    totalWindows: item.score.totalWindows,
    minGainPct: item.score.minGainPct,
    maxGainPct: item.score.maxGainPct,
    rank: item.rank,
    isBest: item.isBest,
  };
}

export async function batchMomentumScan(
  gateway: TradingGateway,
  symbols: string[],
  momentumConfig: MomentumConfig,
  continuationExtras: {
    minGreenWindows: number;
    maxPullbackPct: string;
    requireShortTf: boolean;
  },
): Promise<BatchMomentumItem[]> {
  const tickers = await gateway.binance.getTicker24hr();
  const tickerBySymbol = new Map(tickers.map((t) => [t.symbol, t]));

  const results: BatchMomentumItem[] = [];
  for (const symbol of symbols) {
    const detail = await checkMultiTfMomentum(
      gateway.binance,
      symbol,
      momentumConfig,
      continuationExtras,
      tickerBySymbol.get(symbol),
    );
    results.push({ symbol, passed: detail.entryEligible, detail });
  }
  return results;
}
