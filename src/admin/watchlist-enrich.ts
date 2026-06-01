import { getConfig, getRotationConfig, getTickScalpConfig, isTickScalpEnabled } from '../db/bot-config';
import type { BotState } from '../db/bot-state';
import { resolvePositionOpenedAt } from '../db/bot-state';
import type { WatchlistEntry } from '../db/watchlist';
import { BinanceClient } from '../exchange/binance';
import {
  fetchKlinesFromDo,
  fetchSymbolMidPrice,
  fetchTickRank,
} from '../exchange/market-data-client';
import type { TickScanRow } from '../durable-objects/market-data-do';
import { summarizeTickProximity, type TickEntryProximity } from './tick-live';
import { absoluteSmaDeviationPct, minutesSinceOpenedAt } from '../indicators/watchlist-sma';
import { changeSinceRefPct } from '../indicators/price-change';
import { isPullbackNearSma, sma } from '../indicators/technical';
import {
  parseMomentumDetailJson,
  MOMENTUM_WINDOWS,
  type WindowTrendResult,
} from '../indicators/multi-tf-momentum';
import { bn } from '../math/decimal';

export interface EnrichedWatchlistEntry extends WatchlistEntry {
  lastClose: string;
  sma20: string;
  deviationPct: string;
  smaDeviationPct: string;
  changeSinceScoutPct: string;
  nearSma: boolean;
  pullbackTolerancePct: string;
  isActivePosition: boolean;
  isBestSma: boolean;
  momentumScorePct: string | null;
  momentumRank: number | null;
  momentumPassed: boolean;
  momentumGreenCount: number | null;
  isBestMomentum: boolean;
  momentumCheckedAt: string | null;
  windowGains: Record<string, { gainPct: string; passed: boolean }>;
  microScorePct: string | null;
  microPassed: boolean;
  isBestMicro: boolean;
  microCheckedAt: string | null;
  sectorTag: string | null;
  tickGainPct: string | null;
  tickBidAskRatio: number | null;
  tickFailReason: string | null;
  tickWsDeclinePct: string | null;
  tickWsDeclineOk: boolean;
  trend5mOk: boolean;
  trend5mFailReason: string | null;
  tickRecoveryPct: string | null;
  tickReversalScore: number | null;
  tickReversalOk: boolean;
  tickEligible: boolean;
  tickReadinessPct: number | null;
  tickGatesPassed: number | null;
  tickGatesTotal: number | null;
  tickPrimaryBlocker: string | null;
  tickProximity: TickEntryProximity | null;
}

/** Admin panel JSON — camelCase, micro_detail parse */
export interface AdminWatchlistRow {
  symbol: string;
  price_at_addition: string;
  added_at: string;
  target_sma: string | null;
  lastClose: string;
  sma20: string;
  deviationPct: string;
  smaDeviationPct: string;
  changeSinceScoutPct: string;
  nearSma: boolean;
  pullbackTolerancePct: string;
  isActivePosition: boolean;
  isBestSma: boolean;
  momentumScorePct: string | null;
  momentumRank: number | null;
  momentumPassed: boolean;
  momentumGreenCount: number | null;
  isBestMomentum: boolean;
  momentumCheckedAt: string | null;
  windowGains: Record<string, { gainPct: string; passed: boolean }>;
  microScore: string | null;
  microRank: number | null;
  microPassed: boolean;
  isBestMicro: boolean;
  microCheckedAt: string | null;
  microVolumeRatio: string | null;
  microAggression: string | null;
  microOrderbookRatio: string | null;
  microTrend1m: string | null;
  microFailReason: string | null;
  microTrend15mTier: string | null;
  microScoreDeltaPts: string | null;
  microVolumeDeltaPct: string | null;
  microAggressionDeltaPct: string | null;
  microOrderbookDeltaPct: string | null;
  sectorTag: string | null;
  tickGainPct: string | null;
  tickBidAskRatio: number | null;
  tickFailReason: string | null;
  tickWsDeclinePct: string | null;
  tickWsDeclineOk: boolean;
  trend5mOk?: boolean;
  trend5mFailReason?: string | null;
  tickRecoveryPct?: string | null;
  tickReversalScore?: number | null;
  tickReversalOk?: boolean;
  tickEligible?: boolean;
  tickReadinessPct?: number | null;
  tickGatesPassed?: number | null;
  tickGatesTotal?: number | null;
  tickPrimaryBlocker?: string | null;
  microComponents: {
    volumeRatio?: number;
    aggression?: number;
    orderbook?: number;
    trend1m?: number;
    trend5m?: number;
    trend15m?: number;
  } | null;
}

function parseMicroDetailJson(detail: string | null): {
  volumeRatio: string | null;
  aggressionRatio: string | null;
  failReason: string | null;
  trend15mTier: string | null;
  components: AdminWatchlistRow['microComponents'];
  scoreDeltaPts: string | null;
  volumeDeltaPct: string | null;
  aggressionDeltaPct: string | null;
  orderbookDeltaPct: string | null;
} {
  const empty = {
    volumeRatio: null as string | null,
    aggressionRatio: null as string | null,
    failReason: null as string | null,
    trend15mTier: null as string | null,
    components: null as AdminWatchlistRow['microComponents'],
    scoreDeltaPts: null as string | null,
    volumeDeltaPct: null as string | null,
    aggressionDeltaPct: null as string | null,
    orderbookDeltaPct: null as string | null,
  };
  if (!detail) return empty;
  try {
    const p = JSON.parse(detail) as Record<string, unknown>;
    const raw = p.components as Record<string, number> | undefined;
    const components = raw
      ? {
          volumeRatio: raw.volume,
          aggression: raw.aggression,
          orderbook: raw.orderbookRatio,
          trend1m: raw.trend1m,
          trend5m: raw.structure5m,
          trend15m: undefined,
        }
      : null;
    const d = p.deltas as Record<string, string | null> | undefined;
    const gates = p.gates as Record<string, unknown> | undefined;
    return {
      volumeRatio: p.volumeRatio != null ? String(p.volumeRatio) : null,
      aggressionRatio: p.aggressionRatio != null ? String(p.aggressionRatio) : null,
      failReason: p.failReason != null ? String(p.failReason) : null,
      trend15mTier: gates?.trend15mTier != null ? String(gates.trend15mTier) : null,
      components,
      scoreDeltaPts: d?.scorePts != null ? String(d.scorePts) : null,
      volumeDeltaPct: d?.volumePct != null ? String(d.volumePct) : null,
      aggressionDeltaPct: d?.aggressionPct != null ? String(d.aggressionPct) : null,
      orderbookDeltaPct: d?.orderbookPct != null ? String(d.orderbookPct) : null,
    };
  } catch {
    return empty;
  }
}

function trend1mLabel(score: number | undefined): string | null {
  if (score == null || Number.isNaN(score)) return null;
  if (score >= 0.55) return 'up';
  if (score <= 0.35) return 'down';
  return 'flat';
}

export function formatWatchlistForAdmin(entries: EnrichedWatchlistEntry[]): AdminWatchlistRow[] {
  return entries.map((row, idx) => {
    const micro = parseMicroDetailJson(row.micro_detail);
    return {
      symbol: row.symbol,
      price_at_addition: row.price_at_addition,
      added_at: row.added_at,
      target_sma: row.target_sma,
      lastClose: row.lastClose,
      sma20: row.sma20,
      deviationPct: row.deviationPct,
      smaDeviationPct: row.smaDeviationPct,
      changeSinceScoutPct: row.changeSinceScoutPct,
      nearSma: row.nearSma,
      pullbackTolerancePct: row.pullbackTolerancePct,
      isActivePosition: row.isActivePosition,
      isBestSma: row.isBestSma,
      momentumScorePct: row.momentumScorePct,
      momentumRank: row.momentumRank,
      momentumPassed: row.momentumPassed,
      momentumGreenCount: row.momentumGreenCount,
      isBestMomentum: row.isBestMomentum,
      momentumCheckedAt: row.momentumCheckedAt,
      windowGains: row.windowGains,
      microScore: row.microScorePct,
      microRank: idx + 1,
      microPassed: row.microPassed,
      isBestMicro: row.isBestMicro,
      microCheckedAt: row.microCheckedAt,
      microVolumeRatio: micro.volumeRatio,
      microAggression: micro.aggressionRatio,
      microOrderbookRatio:
        micro.components?.orderbook != null ? micro.components.orderbook.toFixed(2) : null,
      microTrend1m: trend1mLabel(micro.components?.trend1m),
      microFailReason: micro.failReason,
      microTrend15mTier: micro.trend15mTier,
      microScoreDeltaPts: micro.scoreDeltaPts,
      microVolumeDeltaPct: micro.volumeDeltaPct,
      microAggressionDeltaPct: micro.aggressionDeltaPct,
      microOrderbookDeltaPct: micro.orderbookDeltaPct,
      sectorTag: row.sector_tag,
      tickGainPct: row.tickGainPct,
      tickBidAskRatio: row.tickBidAskRatio,
      tickFailReason: row.tickFailReason,
      tickWsDeclinePct: row.tickWsDeclinePct,
      tickWsDeclineOk: row.tickWsDeclineOk,
      trend5mOk: row.trend5mOk,
      trend5mFailReason: row.trend5mFailReason,
      tickRecoveryPct: row.tickRecoveryPct,
      tickReversalScore: row.tickReversalScore,
      tickReversalOk: row.tickReversalOk,
      tickEligible: row.tickEligible,
      tickReadinessPct: row.tickReadinessPct,
      tickGatesPassed: row.tickGatesPassed,
      tickGatesTotal: row.tickGatesTotal,
      tickPrimaryBlocker: row.tickPrimaryBlocker,
      microComponents: micro.components,
    };
  });
}

function tickFieldsFromRow(
  row: TickScanRow | undefined,
  tick: Awaited<ReturnType<typeof getTickScalpConfig>>,
): Pick<
  EnrichedWatchlistEntry,
  | 'tickGainPct'
  | 'tickBidAskRatio'
  | 'tickFailReason'
  | 'tickWsDeclinePct'
  | 'tickWsDeclineOk'
  | 'trend5mOk'
  | 'trend5mFailReason'
  | 'tickRecoveryPct'
  | 'tickReversalScore'
  | 'tickReversalOk'
  | 'tickEligible'
  | 'tickReadinessPct'
  | 'tickGatesPassed'
  | 'tickGatesTotal'
  | 'tickPrimaryBlocker'
  | 'tickProximity'
> {
  if (!row) {
    return {
      tickGainPct: null,
      tickBidAskRatio: null,
      tickFailReason: 'no_do_data',
      tickWsDeclinePct: null,
      tickWsDeclineOk: false,
      trend5mOk: false,
      trend5mFailReason: null,
      tickRecoveryPct: null,
      tickReversalScore: null,
      tickReversalOk: false,
      tickEligible: false,
      tickReadinessPct: null,
      tickGatesPassed: null,
      tickGatesTotal: null,
      tickPrimaryBlocker: 'no_do_data',
      tickProximity: null,
    };
  }
  const prox = summarizeTickProximity(row, tick);
  return {
    tickGainPct: row.gainPct,
    tickBidAskRatio: row.bidAskRatio,
    tickFailReason: row.failReason ?? row.reversalFailReason,
    tickWsDeclinePct: row.wsDeclinePct,
    tickWsDeclineOk: row.wsDeclineOk,
    trend5mOk: row.trend5mOk,
    trend5mFailReason: row.trend5mFailReason,
    tickRecoveryPct: prox.recoveryPct,
    tickReversalScore: prox.reversalScore,
    tickReversalOk: prox.reversalOk,
    tickEligible: prox.eligible,
    tickReadinessPct: prox.readinessPct,
    tickGatesPassed: prox.gatesPassed,
    tickGatesTotal: prox.gatesTotal,
    tickPrimaryBlocker: prox.primaryBlocker,
    tickProximity: prox,
  };
}

function windowGainsMap(windows: WindowTrendResult[]): Record<string, { gainPct: string; passed: boolean }> {
  const map: Record<string, { gainPct: string; passed: boolean }> = {};
  for (const label of MOMENTUM_WINDOWS.map((w) => w.label)) {
    map[label] = { gainPct: '—', passed: false };
  }
  for (const w of windows) {
    map[w.label] = { gainPct: w.gainPct, passed: w.passed };
  }
  return map;
}

function signedDeviationPct(lastClose: string, sma20: string): string {
  const base = bn(sma20);
  if (base.isZero()) return '0';
  return bn(lastClose).minus(base).dividedBy(base).times(100).toFixed(3);
}

function isValidLivePrice(price: string | null | undefined): boolean {
  if (!price) return false;
  const n = Number(price);
  return Number.isFinite(n) && n > 0;
}

async function resolveLivePrice(
  env: Env,
  client: BinanceClient,
  symbol: string,
  klineFallback: string,
): Promise<string> {
  const mid = await fetchSymbolMidPrice(env, symbol);
  if (isValidLivePrice(mid)) return mid!;

  const { fetchTickersFromDo } = await import('../exchange/market-data-client');
  const tickers = await fetchTickersFromDo(env);
  const t = tickers?.find((x) => x.symbol === symbol);
  if (isValidLivePrice(t?.lastPrice)) return t!.lastPrice;

  try {
    const rest = await client.getSymbolPrice(symbol);
    if (isValidLivePrice(rest)) return rest;
  } catch {
    /* REST yedek */
  }
  return isValidLivePrice(klineFallback) ? klineFallback : klineFallback;
}

export async function enrichWatchlistLive(
  env: Env,
  entries: WatchlistEntry[],
  botState?: BotState | null,
  activeSymbols?: string[],
): Promise<EnrichedWatchlistEntry[]> {
  if (entries.length === 0) return [];

  const [pullbackTolerancePct, rotationConfig] = await Promise.all([
    getConfig(env.DB, 'pullback_tolerance_pct', env),
    getRotationConfig(env.DB, env),
  ]);
  const client = new BinanceClient(env);
  const tickEnabled = await isTickScalpEnabled(env.DB, env);
  let tickCfg: Awaited<ReturnType<typeof getTickScalpConfig>> | null = null;
  const tickRowBySymbol = new Map<string, TickScanRow>();
  if (tickEnabled && env.MARKET_DATA) {
    tickCfg = await getTickScalpConfig(env.DB, env);
    const rank = await fetchTickRank(env, tickCfg);
    for (const r of rank?.rows ?? []) {
      if (r.symbol !== 'BTCUSDT') tickRowBySymbol.set(r.symbol, r);
    }
  }

  const enriched = await Promise.all(
    entries.map(async (entry) => {
      const parsed = parseMomentumDetailJson(entry.momentum_detail);
      const emptyWindows = windowGainsMap([]);

      const fallback: EnrichedWatchlistEntry = {
        ...entry,
        lastClose: entry.price_at_addition,
        sma20: '—',
        deviationPct: '—',
        smaDeviationPct: '—',
        changeSinceScoutPct: '—',
        nearSma: false,
        pullbackTolerancePct,
        isActivePosition: false,
        isBestSma: false,
        momentumScorePct: parsed?.scorePct ?? null,
        momentumRank: parsed?.rank ?? null,
        momentumPassed: parsed?.entryEligible ?? parsed?.passed ?? false,
        momentumGreenCount: parsed?.greenCount ?? null,
        isBestMomentum: parsed?.rank === 1,
        momentumCheckedAt: entry.momentum_checked_at,
        windowGains: parsed ? windowGainsMap(parsed.windows) : emptyWindows,
        microScorePct: entry.micro_score,
        microPassed: entry.micro_ok === 1,
        isBestMicro: false,
        microCheckedAt: entry.micro_checked_at,
        sectorTag: entry.sector_tag,
        tickGainPct: null,
        tickBidAskRatio: null,
        tickFailReason: null,
        tickWsDeclinePct: null,
        tickWsDeclineOk: false,
        trend5mOk: false,
        trend5mFailReason: null,
        tickRecoveryPct: null,
        tickReversalScore: null,
        tickReversalOk: false,
        tickEligible: false,
        tickReadinessPct: null,
        tickGatesPassed: null,
        tickGatesTotal: null,
        tickPrimaryBlocker: null,
        tickProximity: null,
      };

      const tickFromDo =
        tickCfg != null ? tickFieldsFromRow(tickRowBySymbol.get(entry.symbol), tickCfg) : null;

      try {
        let klines = await fetchKlinesFromDo(env, entry.symbol, '15m', 30);
        if (!klines?.length) {
          klines = await client.getKlines(entry.symbol, '15m', 30);
        }
        const closes = klines.map((k) => k.close);
        const sma20 = sma(closes, 20);
        const klineClose = closes[closes.length - 1] ?? entry.price_at_addition;
        const lastClose = await resolveLivePrice(env, client, entry.symbol, klineClose);

        if (!sma20) {
          return {
            ...fallback,
            lastClose,
            changeSinceScoutPct: changeSinceRefPct(entry.price_at_addition, lastClose),
            ...(tickFromDo ?? {}),
          };
        }

        const absDev = absoluteSmaDeviationPct(lastClose, sma20);
        return {
          ...fallback,
          lastClose,
          sma20,
          deviationPct: signedDeviationPct(lastClose, sma20),
          smaDeviationPct: absDev,
          changeSinceScoutPct: changeSinceRefPct(entry.price_at_addition, lastClose),
          nearSma: isPullbackNearSma(lastClose, sma20, pullbackTolerancePct),
          ...(tickFromDo ?? {}),
        };
      } catch {
        return {
          ...fallback,
          ...(tickFromDo ?? {}),
        };
      }
    }),
  );

  const activeSymbol = botState?.status === 'TIER_1_BULL' ? botState.active_symbol : null;
  const activeSymbolSet = new Set((activeSymbols ?? []).map((s) => s.toUpperCase()));
  if (activeSymbol && activeSymbolSet.size === 0) {
    activeSymbolSet.add(activeSymbol.toUpperCase());
  }
  const elapsed = botState
    ? minutesSinceOpenedAt(resolvePositionOpenedAt(botState))
    : null;
  const graceMinutes = Number(rotationConfig.rotationWindowMinutes);
  const rotationActive =
    activeSymbol != null &&
    elapsed !== null &&
    elapsed >= graceMinutes &&
    botState?.entry_mode !== 'momentum_scalp' &&
    botState?.entry_mode !== 'micro_scalp' &&
    botState?.entry_mode !== 'tick_scalp';

  let bestSymbol: string | null = null;
  if (rotationActive) {
    let bestDev: string | null = null;
    for (const row of enriched) {
      if (!row.nearSma || row.smaDeviationPct === '—') continue;
      if (bestDev === null || bn(row.smaDeviationPct).lt(bestDev)) {
        bestDev = row.smaDeviationPct;
        bestSymbol = row.symbol;
      }
    }
  }

  const bestMomentumSymbol =
    enriched.find((r) => r.momentumRank === 1 && r.momentumPassed)?.symbol ??
    enriched.find((r) => r.momentumRank === 1)?.symbol ??
    null;

  const bestMicroSymbol =
    [...enriched]
      .filter((r) => r.microPassed)
      .sort((a, b) => Number(b.microScorePct ?? 0) - Number(a.microScorePct ?? 0))[0]
      ?.symbol ?? null;

  const scoutOrder = new Map(entries.map((e, idx) => [e.symbol, idx]));
  const sorted = [...enriched].sort((a, b) => {
    if (tickEnabled) {
      return (scoutOrder.get(a.symbol) ?? 999) - (scoutOrder.get(b.symbol) ?? 999);
    }
    const sa = Number(b.microScorePct ?? 0) - Number(a.microScorePct ?? 0);
    if (sa !== 0) return sa;
    const ra = a.momentumRank ?? 999;
    const rb = b.momentumRank ?? 999;
    return ra - rb;
  });

  return sorted.map((row) => ({
    ...row,
    isActivePosition: activeSymbolSet.has(row.symbol.toUpperCase()),
    isBestSma: rotationActive && row.symbol === bestSymbol,
    isBestMomentum: row.symbol === bestMomentumSymbol,
    isBestMicro: row.symbol === bestMicroSymbol,
  }));
}
