import { bn, sum } from '../math/decimal';

export interface ClosedTradeRow {
  id: number;
  symbol: string;
  spent: string;
  proceeds: string;
  pnl: string;
  source: string | null;
  closedAt: string;
}

export interface PnlSummary {
  closedTrades: number;
  wins: number;
  losses: number;
  breakeven: number;
  totalPnlUsdt: string;
  totalSpentUsdt: string;
  totalProceedsUsdt: string;
  buyCount: number;
  estimatedBnbCommission: string;
  recentCloses: ClosedTradeRow[];
}

export interface PnlSummaryBundle {
  today: PnlSummary;
  allTime: PnlSummary;
  /** İstanbul takvim günü, örn. 22.05.2026 */
  todayLabel: string;
}

const ISTANBUL_TZ = 'Europe/Istanbul';

/** UTC/D1 timestamp → İstanbul takvim günü (YYYY-MM-DD). */
export function istanbulCalendarDay(ts: string): string {
  const trimmed = ts.trim();
  let d: Date;
  if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
    const normalized =
      trimmed.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(trimmed) ? trimmed : `${trimmed}Z`;
    d = new Date(normalized);
  } else if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(trimmed)) {
    d = new Date(trimmed.replace(' ', 'T') + 'Z');
  } else {
    d = new Date(trimmed);
  }
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: ISTANBUL_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

function todayIstanbulLabel(now = new Date()): string {
  const iso = new Intl.DateTimeFormat('en-CA', {
    timeZone: ISTANBUL_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

function emptySummary(): PnlSummary {
  return {
    closedTrades: 0,
    wins: 0,
    losses: 0,
    breakeven: 0,
    totalPnlUsdt: '0',
    totalSpentUsdt: '0',
    totalProceedsUsdt: '0',
    buyCount: 0,
    estimatedBnbCommission: '0',
    recentCloses: [],
  };
}

function accumulateClose(
  parsed: Omit<ClosedTradeRow, 'id' | 'closedAt'>,
  row: { id: number; created_at: string },
  bucket: {
    pnls: string[];
    spents: string[];
    proceedsList: string[];
    wins: number;
    losses: number;
    breakeven: number;
    recentCloses: ClosedTradeRow[];
  },
  recentLimit: number,
): void {
  bucket.pnls.push(parsed.pnl);
  bucket.spents.push(parsed.spent);
  bucket.proceedsList.push(parsed.proceeds);
  const pnlBn = bn(parsed.pnl);
  if (pnlBn.gt(0)) bucket.wins++;
  else if (pnlBn.lt(0)) bucket.losses++;
  else bucket.breakeven++;
  if (bucket.recentCloses.length < recentLimit) {
    bucket.recentCloses.push({ id: row.id, ...parsed, closedAt: row.created_at });
  }
}

function bucketToSummary(
  bucket: {
    pnls: string[];
    spents: string[];
    proceedsList: string[];
    wins: number;
    losses: number;
    breakeven: number;
    recentCloses: ClosedTradeRow[];
  },
  buyCount: number,
  estimatedBnbCommission: string,
): PnlSummary {
  const { pnls, spents, proceedsList, wins, losses, breakeven, recentCloses } = bucket;
  return {
    closedTrades: pnls.length,
    wins,
    losses,
    breakeven,
    totalPnlUsdt: pnls.length > 0 ? sum(pnls.map((p) => bn(p))) : '0',
    totalSpentUsdt: spents.length > 0 ? sum(spents.map((s) => bn(s))) : '0',
    totalProceedsUsdt: proceedsList.length > 0 ? sum(proceedsList.map((p) => bn(p))) : '0',
    buyCount,
    estimatedBnbCommission,
    recentCloses,
  };
}

function parseClosed(payload: string): Omit<ClosedTradeRow, 'id' | 'closedAt'> | null {
  try {
    const p = JSON.parse(payload) as Record<string, string>;
    if (!p.symbol || p.pnl == null) return null;
    return {
      symbol: p.symbol,
      spent: p.spent ?? '0',
      proceeds: p.proceeds ?? '0',
      pnl: p.pnl,
      source: p.source ?? null,
    };
  } catch {
    return null;
  }
}

interface BuyFill {
  commission?: string;
  commissionAsset?: string;
}

function commissionFromBuy(payload: string): string {
  try {
    const p = JSON.parse(payload) as { order?: { fills?: BuyFill[] } };
    const fills = p.order?.fills ?? [];
    let total = bn(0);
    for (const f of fills) {
      if (f.commissionAsset === 'BNB' && f.commission) {
        total = total.plus(f.commission);
      }
    }
    return total.toFixed(8);
  } catch {
    return '0';
  }
}

export async function getPnlSummaryBundle(
  db: D1Database,
  recentLimit = 20,
): Promise<PnlSummaryBundle> {
  const todayKey = istanbulCalendarDay(new Date().toISOString());

  const { results: closedRows } = await db
    .prepare(
      `SELECT id, payload, created_at FROM trade_log
       WHERE event_type = 'POSITION_CLOSED'
       ORDER BY id DESC LIMIT 200`,
    )
    .all<{ id: number; payload: string; created_at: string }>();

  const { results: buyRows } = await db
    .prepare(
      `SELECT payload, created_at FROM trade_log
       WHERE event_type = 'BUY_FILLED'
       ORDER BY id DESC LIMIT 200`,
    )
    .all<{ payload: string; created_at: string }>();

  const allTimeBucket = {
    pnls: [] as string[],
    spents: [] as string[],
    proceedsList: [] as string[],
    wins: 0,
    losses: 0,
    breakeven: 0,
    recentCloses: [] as ClosedTradeRow[],
  };
  const todayBucket = {
    pnls: [] as string[],
    spents: [] as string[],
    proceedsList: [] as string[],
    wins: 0,
    losses: 0,
    breakeven: 0,
    recentCloses: [] as ClosedTradeRow[],
  };

  for (const row of closedRows ?? []) {
    const parsed = parseClosed(row.payload);
    if (!parsed) continue;
    accumulateClose(parsed, row, allTimeBucket, recentLimit);
    if (istanbulCalendarDay(row.created_at) === todayKey) {
      accumulateClose(parsed, row, todayBucket, recentLimit);
    }
  }

  let allTimeBnb = bn(0);
  let todayBnb = bn(0);
  let allTimeBuys = 0;
  let todayBuys = 0;

  for (const row of buyRows ?? []) {
    const comm = bn(commissionFromBuy(row.payload));
    allTimeBnb = allTimeBnb.plus(comm);
    allTimeBuys++;
    if (istanbulCalendarDay(row.created_at) === todayKey) {
      todayBnb = todayBnb.plus(comm);
      todayBuys++;
    }
  }

  return {
    todayLabel: todayIstanbulLabel(),
    today: bucketToSummary(todayBucket, todayBuys, todayBnb.toFixed(8)),
    allTime: bucketToSummary(allTimeBucket, allTimeBuys, allTimeBnb.toFixed(8)),
  };
}

/** @deprecated Prefer getPnlSummaryBundle */
export async function getPnlSummary(db: D1Database, recentLimit = 20): Promise<PnlSummary> {
  const bundle = await getPnlSummaryBundle(db, recentLimit);
  return bundle.allTime;
}
