import { getTickScalpConfig } from '../db/bot-config';
import {
  fetchTickRank,
  fetchTickRef,
  fetchMarketDataStatus,
} from '../exchange/market-data-client';
import type { TickScanRow } from '../durable-objects/market-data-do';
import { bn } from '../math/decimal';
import { passesTickGainBand } from '../indicators/tick-entry';
import { effectiveRecoveryMinPct } from '../indicators/tick-reversal';
import { tickReversalConfigFromScalp } from '../jobs/tick-config-sync';

export interface TickGateCheck {
  id: string;
  label: string;
  pass: boolean;
  actual: string | number | boolean | null;
  threshold: string;
  note?: string;
}

export interface TickLiveReport {
  symbol: string;
  at: string;
  config: {
    entryGainPct: string;
    entryGainMaxPct: string;
    maxTickSizePct: string;
    recoveryMinPct: string;
    recoveryEffectiveMinPct: string;
    orderbookRatioMin: number;
    maxSpreadPct: string;
    declineMinPct: string;
    requireWsDecline: boolean;
    majorOnly: boolean;
    majorSymbols: string[];
    useLimitMaker: boolean;
    limitBuyOffsetPct: string;
    entryOrderTtlSec: number;
    stopLimitBufferPct: string;
    aggBurstEnabled: boolean;
    aggWindowSec: number;
    aggBuyCountMin: number;
    aggBuyQuoteMinUsdt: string;
    aggImbalanceMin: string;
    takeProfitPct: string;
  };
  do: {
    available: boolean;
    wsStale: boolean;
    lastMessageAt: number | null;
    messageCount: number | null;
  };
  row: TickScanRow | null;
  rank: {
    position: number | null;
    total: number;
    top5: Array<{ symbol: string; reversalScore: number; pass: boolean; reversalOk: boolean }>;
  };
  eligible: boolean;
  wouldFireWs: boolean;
  gates: TickGateCheck[];
  proximity: TickEntryProximity | null;
  failReason: string | null;
}

function gate(
  id: string,
  label: string,
  pass: boolean,
  actual: string | number | boolean | null,
  threshold: string,
  note?: string,
): TickGateCheck {
  return { id, label, pass, actual, threshold, note };
}

export interface TickEntryProximity {
  gatesPassed: number;
  gatesTotal: number;
  readinessPct: number;
  eligible: boolean;
  reversalOk: boolean;
  reversalScore: number | null;
  recoveryPct: string | null;
  gainPct: string | null;
  primaryBlocker: string | null;
  gates: TickGateCheck[];
}

const GATE_PRIORITY = [
  'stale',
  'gain_min',
  'gain_max',
  'gain_band',
  'orderbook_ratio',
  'spread',
  'ws_decline',
  'recovery',
  'agg_burst',
  'reversal',
  'mid_slope',
  'timing',
  'pass',
];

export function summarizeTickProximity(
  row: TickScanRow,
  tick: Awaited<ReturnType<typeof getTickScalpConfig>>,
): TickEntryProximity {
  const gates = simulateTickGates(row, tick);
  const gatesPassed = gates.filter((g) => g.pass).length;
  const gatesTotal = gates.length;
  const readinessPct = gatesTotal > 0 ? Math.round((gatesPassed / gatesTotal) * 100) : 0;
  const firstFail = GATE_PRIORITY.map((id) => gates.find((g) => g.id === id)).find((g) => g && !g.pass);
  const eligible = Boolean(row.pass && row.reversalOk && !row.stale);
  return {
    gatesPassed,
    gatesTotal,
    readinessPct,
    eligible,
    reversalOk: row.reversalOk,
    reversalScore: row.reversalScore,
    recoveryPct: row.recoveryFromWsLowPct,
    gainPct: row.gainPct,
    primaryBlocker:
      row.failReason ??
      row.reversalFailReason ??
      firstFail?.note ??
      firstFail?.label ??
      null,
    gates,
  };
}

export function simulateTickGates(
  row: TickScanRow,
  tick: Awaited<ReturnType<typeof getTickScalpConfig>>,
): TickGateCheck[] {
  const revCfg = tickReversalConfigFromScalp(tick);
  const recoveryFloor = effectiveRecoveryMinPct(revCfg);
  const gain = row.gainPct;
  const bandOk = passesTickGainBand(gain, tick.entryGainPct, tick.entryGainMaxPct);

  const gates: TickGateCheck[] = [
    gate('stale', 'Veri taze', !row.stale, row.stale ? 'stale' : 'ok', 'stale=false'),
    gate(
      'gain_min',
      'WS gain ≥ min',
      gain != null && bn(gain).gte(tick.entryGainPct),
      gain,
      `≥ ${tick.entryGainPct}%`,
    ),
    gate(
      'gain_max',
      'WS gain ≤ max',
      gain != null && bn(gain).lte(tick.entryGainMaxPct),
      gain,
      `≤ ${tick.entryGainMaxPct}%`,
    ),
    gate('gain_band', 'Gain bandı (min–max)', bandOk, gain, `${tick.entryGainPct}–${tick.entryGainMaxPct}%`),
    gate(
      'orderbook_ratio',
      'OB bid/ask oranı',
      row.bidAskRatio >= tick.orderbookRatioMin,
      row.bidAskRatio.toFixed(4),
      `≥ ${tick.orderbookRatioMin}`,
    ),
    gate(
      'spread',
      'Spread',
      row.spreadPct <= Number(tick.maxSpreadPct),
      row.spreadPct.toFixed(4),
      `≤ ${tick.maxSpreadPct}%`,
    ),
    gate(
      'ws_decline',
      'WS düşüş paterni',
      !tick.requireWsDecline || row.wsDeclineOk,
      row.wsDeclinePct,
      tick.requireWsDecline ? `decline ≥ ${tick.declineMinPct}%` : 'kapalı',
      row.wsDeclineFailReason ?? undefined,
    ),
    gate(
      'recovery',
      'Recovery (dip’ten)',
      row.recoveryFromWsLowPct != null && bn(row.recoveryFromWsLowPct).gte(recoveryFloor),
      row.recoveryFromWsLowPct,
      `≥ ${recoveryFloor}% (eff.)`,
    ),
    gate(
      'agg_burst',
      'AggTrade alış patlaması',
      !tick.aggBurstEnabled || row.aggBurstOk,
      row.aggBurstOk,
      tick.aggBurstEnabled
        ? `count≥${tick.aggBuyCountMin}, quote≥${tick.aggBuyQuoteMinUsdt}, imb≥${tick.aggImbalanceMin}`
        : 'kapalı',
      row.aggBurstFailReason ?? undefined,
    ),
    gate(
      'reversal',
      'Reversal kuralları',
      row.reversalOk,
      row.reversalOk,
      'ok',
      row.reversalFailReason ?? undefined,
    ),
    gate(
      'mid_slope',
      'Mid slope',
      row.midSlopeOk,
      row.midSlopeOk,
      'rising samples',
    ),
    gate(
      'timing',
      'Dip sonrası süre',
      row.secSinceTrough != null &&
        row.secSinceTrough >= tick.minSecAfterTrough &&
        row.secSinceTrough <= tick.maxSecAfterTrough,
      row.secSinceTrough,
      `${tick.minSecAfterTrough}–${tick.maxSecAfterTrough}s`,
    ),
    gate('pass', 'evaluateTick pass', row.pass, row.pass, 'true', row.failReason ?? undefined),
  ];

  return gates;
}

export async function buildTickLiveReport(env: Env, symbol: string): Promise<TickLiveReport> {
  const sym = symbol.toUpperCase();
  const tick = await getTickScalpConfig(env.DB, env);
  const revCfg = tickReversalConfigFromScalp(tick);

  const [status, rankResult, ref] = await Promise.all([
    fetchMarketDataStatus(env),
    fetchTickRank(env, tick),
    fetchTickRef(env, sym, tick),
  ]);

  const now = Date.now();
  const wsStale = !status?.lastMessageAt || now - status.lastMessageAt > 60_000;

  const rows = rankResult?.rows ?? [];
  const sorted = [...rows].sort((a, b) => b.reversalScore - a.reversalScore);
  const row = ref ?? sorted.find((r) => r.symbol === sym) ?? null;
  const position = row ? sorted.findIndex((r) => r.symbol === sym) + 1 : null;
  const top5 = sorted.slice(0, 5).map((r) => ({
    symbol: r.symbol,
    reversalScore: r.reversalScore,
    pass: r.pass,
    reversalOk: r.reversalOk,
  }));

  const proximity = row ? summarizeTickProximity(row, tick) : null;
  const eligible = proximity?.eligible ?? false;
  const wouldFireWs = eligible;

  return {
    symbol: sym,
    at: new Date().toISOString(),
    config: {
      entryGainPct: tick.entryGainPct,
      entryGainMaxPct: tick.entryGainMaxPct,
      maxTickSizePct: tick.maxTickSizePct,
      recoveryMinPct: tick.recoveryMinPct,
      recoveryEffectiveMinPct: effectiveRecoveryMinPct(revCfg),
      orderbookRatioMin: tick.orderbookRatioMin,
      maxSpreadPct: tick.maxSpreadPct,
      declineMinPct: tick.declineMinPct,
      requireWsDecline: tick.requireWsDecline,
      majorOnly: tick.majorOnly,
      majorSymbols: tick.majorSymbols,
      useLimitMaker: tick.useLimitMaker,
      limitBuyOffsetPct: tick.limitBuyOffsetPct,
      entryOrderTtlSec: tick.entryOrderTtlSec,
      stopLimitBufferPct: tick.stopLimitBufferPct,
      aggBurstEnabled: tick.aggBurstEnabled,
      aggWindowSec: tick.aggWindowSec,
      aggBuyCountMin: tick.aggBuyCountMin,
      aggBuyQuoteMinUsdt: tick.aggBuyQuoteMinUsdt,
      aggImbalanceMin: tick.aggImbalanceMin,
      takeProfitPct: tick.takeProfitPct,
    },
    do: {
      available: Boolean(env.MARKET_DATA),
      wsStale,
      lastMessageAt: status?.lastMessageAt ?? null,
      messageCount: status?.messageCount ?? null,
    },
    row,
    rank: { position: position && position > 0 ? position : null, total: sorted.length, top5 },
    eligible,
    wouldFireWs,
    gates: proximity?.gates ?? [],
    proximity,
    failReason: row?.failReason ?? row?.reversalFailReason ?? null,
  };
}
