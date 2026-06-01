import type { TickScalpConfig } from '../db/bot-config';
import type { TickScanRow } from '../durable-objects/market-data-do';
import { bn } from '../math/decimal';

export interface TickSymbolGainRow {
  symbol: string;
  gain1mPct: string | null;
  failReason: string | null;
  pass: boolean;
  wsDeclineOk: boolean;
}

export interface TickGainSnapshot {
  minGainPct: string;
  maxGainPct: string;
  watchlistCount: number;
  sampledCount: number;
  gain1mStats: {
    count: number;
    inBand: number;
    belowMin: number;
    aboveMax: number;
  };
  symbols: TickSymbolGainRow[];
}

function numOrNull(v: string | null): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function buildTickGainSnapshot(
  rows: TickScanRow[],
  watchSymbols: Set<string>,
  tick: Pick<TickScalpConfig, 'entryGainPct' | 'entryGainMaxPct'>,
): TickGainSnapshot {
  const filtered = rows
    .filter((r) => watchSymbols.has(r.symbol) && !r.stale)
    .sort((a, b) => Number(b.gainPct ?? -999) - Number(a.gainPct ?? -999));

  let inBand = 0;
  let belowMin = 0;
  let aboveMax = 0;
  let gain1mCount = 0;

  for (const r of filtered) {
    const g1 = numOrNull(r.gainPct);
    if (g1 != null) {
      gain1mCount++;
      const g = bn(String(g1));
      if (g.lt(tick.entryGainPct)) belowMin++;
      else if (g.gt(tick.entryGainMaxPct)) aboveMax++;
      else inBand++;
    }
  }

  return {
    minGainPct: tick.entryGainPct,
    maxGainPct: tick.entryGainMaxPct,
    watchlistCount: watchSymbols.size,
    sampledCount: filtered.length,
    gain1mStats: {
      count: gain1mCount,
      inBand,
      belowMin,
      aboveMax,
    },
    symbols: filtered.map((r) => ({
      symbol: r.symbol,
      gain1mPct: r.gainPct,
      failReason: r.failReason,
      pass: r.pass,
      wsDeclineOk: r.wsDeclineOk,
    })),
  };
}
