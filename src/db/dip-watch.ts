import { getConfig } from './bot-config';
import type { DipWatchQualityConfig } from '../strategy/dip-watch-quality';

export interface DipWatchConfig {
  maxPositionPct: number;
  scanPoolSize: number;
  maxTracked: number;
  minQuoteVolumeUsdt: number;
  quality: DipWatchQualityConfig;
}

export interface DipWatchEntryRow {
  id: number;
  symbol: string;
  source: string;
  status: 'active' | 'closed';
  entry_price: number;
  entry_at: string;
  entry_low24h: number | null;
  entry_high24h: number | null;
  entry_position_pct: number | null;
  last_price: number | null;
  last_at: string | null;
  unrealized_pct: number | null;
  max_gain_pct: number | null;
  max_draw_pct: number | null;
  exit_price: number | null;
  exit_at: string | null;
  exit_reason: string | null;
}

export interface DipWatchHistorySummary {
  closedCount: number;
  winCount: number;
  lossCount: number;
  avgPnlPct: number | null;
  totalPnlPct: number | null;
}

export async function getDipWatchConfig(db: D1Database, env?: Env): Promise<DipWatchConfig> {
  const [
    maxPositionPct,
    scanPoolSize,
    maxTracked,
    minQuoteVolumeUsdt,
    qualityEnabled,
    minListingDays,
    maxSpreadPct,
    depthBandPct,
    minDepthQuoteUsdt,
    maxVolMcapRatio,
    minCirculatingSupplyPct,
    maxFdvToMcapRatio,
  ] = await Promise.all([
    getConfig(db, 'dip_watch_max_position_pct', env),
    getConfig(db, 'dip_watch_scan_pool_size', env),
    getConfig(db, 'dip_watch_max_tracked', env),
    getConfig(db, 'dip_watch_min_quote_volume_usdt', env),
    getConfig(db, 'dip_watch_quality_enabled', env),
    getConfig(db, 'dip_watch_min_listing_days', env),
    getConfig(db, 'dip_watch_max_spread_pct', env),
    getConfig(db, 'dip_watch_depth_band_pct', env),
    getConfig(db, 'dip_watch_min_depth_quote_usdt', env),
    getConfig(db, 'dip_watch_max_vol_mcap_ratio', env),
    getConfig(db, 'dip_watch_min_circulating_supply_pct', env),
    getConfig(db, 'dip_watch_max_fdv_to_mcap_ratio', env),
  ]);
  return {
    maxPositionPct: Number(maxPositionPct) || 5,
    scanPoolSize: Number(scanPoolSize) || 80,
    maxTracked: Number(maxTracked) || 30,
    minQuoteVolumeUsdt: Number(minQuoteVolumeUsdt) || 500_000,
    quality: {
      enabled: qualityEnabled !== 'false',
      minListingDays: Number(minListingDays) || 30,
      maxSpreadPct: Number(maxSpreadPct) || 0.25,
      depthBandPct: Number(depthBandPct) || 2,
      minDepthQuoteUsdt: Number(minDepthQuoteUsdt) || 25_000,
      maxVolMcapRatio: Number(maxVolMcapRatio) || 1.2,
      minCirculatingSupplyPct: Number(minCirculatingSupplyPct) || 20,
      maxFdvToMcapRatio: Number(maxFdvToMcapRatio) || 5,
    },
  };
}

function rowFromRaw(r: Record<string, unknown>): DipWatchEntryRow {
  return {
    id: Number(r.id),
    symbol: String(r.symbol),
    source: String(r.source),
    status: r.status as 'active' | 'closed',
    entry_price: Number(r.entry_price),
    entry_at: String(r.entry_at),
    entry_low24h: r.entry_low24h != null ? Number(r.entry_low24h) : null,
    entry_high24h: r.entry_high24h != null ? Number(r.entry_high24h) : null,
    entry_position_pct: r.entry_position_pct != null ? Number(r.entry_position_pct) : null,
    last_price: r.last_price != null ? Number(r.last_price) : null,
    last_at: r.last_at != null ? String(r.last_at) : null,
    unrealized_pct: r.unrealized_pct != null ? Number(r.unrealized_pct) : null,
    max_gain_pct: r.max_gain_pct != null ? Number(r.max_gain_pct) : null,
    max_draw_pct: r.max_draw_pct != null ? Number(r.max_draw_pct) : null,
    exit_price: r.exit_price != null ? Number(r.exit_price) : null,
    exit_at: r.exit_at != null ? String(r.exit_at) : null,
    exit_reason: r.exit_reason != null ? String(r.exit_reason) : null,
  };
}

export async function listActiveEntries(db: D1Database): Promise<DipWatchEntryRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM dip_watch_entry WHERE status = 'active' ORDER BY entry_at DESC`,
    )
    .all();
  return (results ?? []).map((r) => rowFromRaw(r as Record<string, unknown>));
}

export async function getActiveEntryBySymbol(
  db: D1Database,
  symbol: string,
): Promise<DipWatchEntryRow | null> {
  const row = await db
    .prepare(`SELECT * FROM dip_watch_entry WHERE status = 'active' AND symbol = ?`)
    .bind(symbol.toUpperCase())
    .first();
  return row ? rowFromRaw(row as Record<string, unknown>) : null;
}

export async function countActiveEntries(db: D1Database): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS c FROM dip_watch_entry WHERE status = 'active'`)
    .first<{ c: number }>();
  return Number(row?.c ?? 0);
}

export interface AddDipWatchEntryInput {
  symbol: string;
  entryPrice: number;
  entryLow24h: number;
  entryHigh24h: number;
  entryPositionPct: number | null;
}

export async function addDipWatchEntry(
  db: D1Database,
  input: AddDipWatchEntryInput,
): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  const symbol = input.symbol.toUpperCase();
  const existing = await getActiveEntryBySymbol(db, symbol);
  if (existing) {
    return { ok: false, error: `${symbol} zaten izleniyor` };
  }
  const cfg = await getDipWatchConfig(db);
  const count = await countActiveEntries(db);
  if (count >= cfg.maxTracked) {
    return { ok: false, error: `En fazla ${cfg.maxTracked} sembol izlenebilir` };
  }
  const now = new Date().toISOString();
  const result = await db
    .prepare(
      `INSERT INTO dip_watch_entry (
        symbol, source, status, entry_price, entry_at,
        entry_low24h, entry_high24h, entry_position_pct,
        last_price, last_at, unrealized_pct, max_gain_pct, max_draw_pct,
        created_at, updated_at
      ) VALUES (?, 'manual', 'active', ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?)`,
    )
    .bind(
      symbol,
      input.entryPrice,
      now,
      input.entryLow24h,
      input.entryHigh24h,
      input.entryPositionPct,
      input.entryPrice,
      now,
      now,
      now,
    )
    .run();
  const id = Number(result.meta.last_row_id);
  return { ok: true, id };
}

export async function closeDipWatchEntry(
  db: D1Database,
  symbol: string,
  exitPrice: number,
  exitReason: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const entry = await getActiveEntryBySymbol(db, symbol);
  if (!entry) {
    return { ok: false, error: 'Aktif kayıt bulunamadı' };
  }
  const pnl = ((exitPrice - entry.entry_price) / entry.entry_price) * 100;
  const now = new Date().toISOString();
  const maxGain = Math.max(entry.max_gain_pct ?? 0, pnl);
  const maxDraw = Math.min(entry.max_draw_pct ?? 0, pnl);
  await db
    .prepare(
      `UPDATE dip_watch_entry SET
        status = 'closed',
        exit_price = ?,
        exit_at = ?,
        exit_reason = ?,
        last_price = ?,
        last_at = ?,
        unrealized_pct = ?,
        max_gain_pct = ?,
        max_draw_pct = ?,
        updated_at = ?
      WHERE id = ?`,
    )
    .bind(exitPrice, now, exitReason, exitPrice, now, pnl, maxGain, maxDraw, now, entry.id)
    .run();
  return { ok: true };
}

export interface UpdateLiveMetricsInput {
  id: number;
  lastPrice: number;
  unrealizedPct: number;
  maxGainPct: number;
  maxDrawPct: number;
}

export async function updateLiveMetrics(
  db: D1Database,
  input: UpdateLiveMetricsInput,
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `UPDATE dip_watch_entry SET
        last_price = ?,
        last_at = ?,
        unrealized_pct = ?,
        max_gain_pct = ?,
        max_draw_pct = ?,
        updated_at = ?
      WHERE id = ? AND status = 'active'`,
    )
    .bind(
      input.lastPrice,
      now,
      input.unrealizedPct,
      input.maxGainPct,
      input.maxDrawPct,
      now,
      input.id,
    )
    .run();
}

export interface ListHistoryOptions {
  symbol?: string;
  limit?: number;
  offset?: number;
}

export async function listClosedEntries(
  db: D1Database,
  opts: ListHistoryOptions = {},
): Promise<DipWatchEntryRow[]> {
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  const offset = Math.max(0, opts.offset ?? 0);
  let sql = `SELECT * FROM dip_watch_entry WHERE status = 'closed'`;
  const binds: unknown[] = [];
  if (opts.symbol) {
    sql += ` AND symbol = ?`;
    binds.push(opts.symbol.toUpperCase());
  }
  sql += ` ORDER BY exit_at DESC LIMIT ? OFFSET ?`;
  binds.push(limit, offset);
  const { results } = await db.prepare(sql).bind(...binds).all();
  return (results ?? []).map((r) => rowFromRaw(r as Record<string, unknown>));
}

export async function summarizeClosedEntries(db: D1Database): Promise<DipWatchHistorySummary> {
  const row = await db
    .prepare(
      `SELECT
        COUNT(*) AS closed_count,
        SUM(CASE WHEN unrealized_pct > 0 THEN 1 ELSE 0 END) AS win_count,
        SUM(CASE WHEN unrealized_pct <= 0 THEN 1 ELSE 0 END) AS loss_count,
        AVG(unrealized_pct) AS avg_pnl,
        SUM(unrealized_pct) AS total_pnl
      FROM dip_watch_entry
      WHERE status = 'closed'`,
    )
    .first<{
      closed_count: number;
      win_count: number;
      loss_count: number;
      avg_pnl: number | null;
      total_pnl: number | null;
    }>();
  return {
    closedCount: Number(row?.closed_count ?? 0),
    winCount: Number(row?.win_count ?? 0),
    lossCount: Number(row?.loss_count ?? 0),
    avgPnlPct: row?.avg_pnl != null ? Number(row.avg_pnl) : null,
    totalPnlPct: row?.total_pnl != null ? Number(row.total_pnl) : null,
  };
}
