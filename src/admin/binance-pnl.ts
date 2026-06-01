import { BinanceClient } from '../exchange/binance';
import { bn } from '../math/decimal';

const DEFAULT_TIMEZONE = 'Europe/Istanbul';
const MAX_RANGE_MS = 31 * 24 * 60 * 60 * 1000;
const MAX_ROWS = 500;

type BucketGranularity = 'hour' | 'day';

interface PositionClosedLogRow {
  id: number;
  created_at: string;
  payload: string;
}

interface PositionClosedPayload {
  symbol?: string;
  spent?: string;
  proceeds?: string;
  source?: string;
  orderId?: string | number;
}

interface BucketAccumulator {
  trades: number;
  pnl: ReturnType<typeof bn>;
  spent: ReturnType<typeof bn>;
  proceeds: ReturnType<typeof bn>;
}

export interface BinanceRangePnlCloseRow {
  id: number;
  symbol: string;
  source: string | null;
  orderId: number | null;
  closedAtUtc: string;
  closedAtLocal: string;
  spentUsdt: string;
  proceedsUsdt: string;
  pnlUsdt: string;
  verification: 'binance' | 'fallback';
  note: string | null;
}

export interface BinanceRangePnlBucketRow {
  bucket: string;
  trades: number;
  spentUsdt: string;
  proceedsUsdt: string;
  pnlUsdt: string;
}

export interface BinanceRangePnlResponse {
  range: {
    startMs: number;
    endMs: number;
    timezone: string;
    bucket: BucketGranularity;
    truncated: boolean;
  };
  summary: {
    tradeCount: number;
    totalSpentUsdt: string;
    totalProceedsUsdt: string;
    totalPnlUsdt: string;
    verifiedCount: number;
    fallbackCount: number;
  };
  buckets: BinanceRangePnlBucketRow[];
  closes: BinanceRangePnlCloseRow[];
}

export interface BinanceRangePnlInput {
  startMs: number;
  endMs: number;
  timezone?: string | null;
  bucket?: string | null;
}

function parseDbTimestamp(ts: string): Date {
  const trimmed = ts.trim();
  if (!trimmed) return new Date(NaN);
  if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
    const normalized =
      trimmed.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(trimmed) ? trimmed : `${trimmed}Z`;
    return new Date(normalized);
  }
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(trimmed)) {
    return new Date(trimmed.replace(' ', 'T') + 'Z');
  }
  return new Date(trimmed);
}

function toDbUtcTimestamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

function safeTimezone(raw?: string | null): string {
  const tz = raw?.trim();
  if (!tz) return DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat('tr-TR', { timeZone: tz }).format(new Date());
    return tz;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

function localDateParts(date: Date, timezone: string): Record<string, string> {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const out: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== 'literal') out[p.type] = p.value;
  }
  return out;
}

function formatLocalDateTime(date: Date, timezone: string): string {
  const p = localDateParts(date, timezone);
  return `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}:${p.second}`;
}

function buildBucketKey(date: Date, timezone: string, bucket: BucketGranularity): string {
  const p = localDateParts(date, timezone);
  if (bucket === 'day') return `${p.year}-${p.month}-${p.day}`;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:00`;
}

function parseClosePayload(payloadRaw: string): {
  symbol: string;
  spent: string;
  proceeds: string;
  source: string | null;
  orderId: number | null;
} | null {
  try {
    const payload = JSON.parse(payloadRaw) as PositionClosedPayload;
    if (!payload.symbol) return null;
    const orderNum = Number(payload.orderId);
    const orderId = Number.isFinite(orderNum) && orderNum > 0 ? orderNum : null;
    return {
      symbol: payload.symbol,
      spent: payload.spent ?? '0',
      proceeds: payload.proceeds ?? '0',
      source: payload.source ?? null,
      orderId,
    };
  } catch {
    return null;
  }
}

function resolveBucket(mode?: string | null): BucketGranularity {
  return mode === 'day' ? 'day' : 'hour';
}

export async function buildBinanceRangePnl(
  env: Env,
  input: BinanceRangePnlInput,
): Promise<BinanceRangePnlResponse> {
  const startMs = Math.floor(Number(input.startMs));
  const endMs = Math.floor(Number(input.endMs));
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    throw new Error('startMs/endMs geçersiz');
  }
  if (startMs >= endMs) {
    throw new Error('Başlangıç, bitişten küçük olmalı');
  }
  if (endMs - startMs > MAX_RANGE_MS) {
    throw new Error('Maksimum aralık 31 gün');
  }

  const timezone = safeTimezone(input.timezone);
  const bucket = resolveBucket(input.bucket);

  const { results } = await env.DB.prepare(
    `SELECT id, payload, created_at
     FROM trade_log
     WHERE event_type = 'POSITION_CLOSED'
       AND created_at >= ?
       AND created_at < ?
     ORDER BY id DESC
     LIMIT ?`,
  )
    .bind(toDbUtcTimestamp(startMs), toDbUtcTimestamp(endMs), MAX_ROWS)
    .all<PositionClosedLogRow>();

  const closeRows = results ?? [];
  const truncated = closeRows.length >= MAX_ROWS;
  const hasBinanceKeys = Boolean(env.BINANCE_API_KEY && env.BINANCE_API_SECRET);
  const binance = hasBinanceKeys ? new BinanceClient(env) : null;

  let totalSpent = bn(0);
  let totalProceeds = bn(0);
  let totalPnl = bn(0);
  let verifiedCount = 0;
  let fallbackCount = 0;
  const bucketMap = new Map<string, BucketAccumulator>();
  const closes: BinanceRangePnlCloseRow[] = [];

  for (const row of closeRows) {
    const parsed = parseClosePayload(row.payload);
    if (!parsed) continue;
    const closedAt = parseDbTimestamp(row.created_at);
    if (Number.isNaN(closedAt.getTime())) continue;

    const spent = bn(parsed.spent);
    let proceeds = bn(parsed.proceeds);
    let verification: 'binance' | 'fallback' = 'fallback';
    let note: string | null = null;

    if (binance && parsed.orderId) {
      try {
        const order = await binance.getOrder(parsed.symbol, parsed.orderId);
        if (order.cummulativeQuoteQty != null) {
          proceeds = bn(order.cummulativeQuoteQty);
          verification = 'binance';
          verifiedCount += 1;
        } else {
          fallbackCount += 1;
          note = 'Binance order quote yok, log proceeds kullanıldı';
        }
      } catch (err) {
        fallbackCount += 1;
        note = err instanceof Error ? err.message : String(err);
      }
    } else {
      fallbackCount += 1;
      note = binance ? 'OrderId bulunamadı, log proceeds kullanıldı' : 'Binance API key yok';
    }

    const pnl = proceeds.minus(spent);
    totalSpent = totalSpent.plus(spent);
    totalProceeds = totalProceeds.plus(proceeds);
    totalPnl = totalPnl.plus(pnl);

    const bucketKey = buildBucketKey(closedAt, timezone, bucket);
    const acc = bucketMap.get(bucketKey) ?? {
      trades: 0,
      pnl: bn(0),
      spent: bn(0),
      proceeds: bn(0),
    };
    acc.trades += 1;
    acc.pnl = acc.pnl.plus(pnl);
    acc.spent = acc.spent.plus(spent);
    acc.proceeds = acc.proceeds.plus(proceeds);
    bucketMap.set(bucketKey, acc);

    closes.push({
      id: row.id,
      symbol: parsed.symbol,
      source: parsed.source,
      orderId: parsed.orderId,
      closedAtUtc: row.created_at,
      closedAtLocal: formatLocalDateTime(closedAt, timezone),
      spentUsdt: spent.toFixed(8),
      proceedsUsdt: proceeds.toFixed(8),
      pnlUsdt: pnl.toFixed(8),
      verification,
      note,
    });
  }

  const buckets = [...bucketMap.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([bucketLabel, acc]) => ({
      bucket: bucketLabel,
      trades: acc.trades,
      spentUsdt: acc.spent.toFixed(8),
      proceedsUsdt: acc.proceeds.toFixed(8),
      pnlUsdt: acc.pnl.toFixed(8),
    }));

  return {
    range: {
      startMs,
      endMs,
      timezone,
      bucket,
      truncated,
    },
    summary: {
      tradeCount: closes.length,
      totalSpentUsdt: totalSpent.toFixed(8),
      totalProceedsUsdt: totalProceeds.toFixed(8),
      totalPnlUsdt: totalPnl.toFixed(8),
      verifiedCount,
      fallbackCount,
    },
    buckets,
    closes,
  };
}
