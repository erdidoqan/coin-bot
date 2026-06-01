import { bn } from '../math/decimal';

export interface TickShadowRow {
  id: number;
  symbol: string;
  recorded_at_ms: number;
  entry_ref_price: string;
  gain_pct: string | null;
  ws_decline_pct: string | null;
  recovery_pct: string | null;
  reversal_score: number | null;
  scout_price: string | null;
  scout_vs_fill_pct: string | null;
  would_pass_reversal: number;
  forward_60s_pct: string | null;
  forward_60s_positive: number | null;
  resolved_at: string | null;
  status: string;
}

export async function hasRecentPendingTickShadow(
  db: D1Database,
  symbol: string,
  dedupeMinutes: number,
  nowMs: number,
): Promise<boolean> {
  const since = nowMs - dedupeMinutes * 60_000;
  const row = await db
    .prepare(
      `SELECT 1 FROM tick_shadow_setups
       WHERE symbol = ? AND status = 'pending' AND recorded_at_ms >= ? LIMIT 1`,
    )
    .bind(symbol, since)
    .first();
  return Boolean(row);
}

export async function insertTickShadowSetup(
  db: D1Database,
  row: {
    symbol: string;
    recordedAtMs: number;
    entryRefPrice: string;
    gainPct: string | null;
    wsDeclinePct: string | null;
    recoveryPct: string | null;
    reversalScore: number | null;
    scoutPrice: string | null;
    scoutVsFillPct: string | null;
    wouldPassReversal: boolean;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO tick_shadow_setups (
        symbol, recorded_at_ms, entry_ref_price, gain_pct, ws_decline_pct,
        recovery_pct, reversal_score, scout_price, scout_vs_fill_pct, would_pass_reversal
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.symbol,
      row.recordedAtMs,
      row.entryRefPrice,
      row.gainPct,
      row.wsDeclinePct,
      row.recoveryPct,
      row.reversalScore,
      row.scoutPrice,
      row.scoutVsFillPct,
      row.wouldPassReversal ? 1 : 0,
    )
    .run();
}

export async function listPendingTickShadowSetups(
  db: D1Database,
  limit: number,
): Promise<TickShadowRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM tick_shadow_setups
       WHERE status = 'pending'
       ORDER BY recorded_at_ms ASC
       LIMIT ?`,
    )
    .bind(limit)
    .all<TickShadowRow>();
  return results ?? [];
}

export async function resolveTickShadowHorizon(
  db: D1Database,
  id: number,
  forwardPct: string,
  positive: boolean,
  resolvedAt: string,
): Promise<TickShadowRow | null> {
  await db
    .prepare(
      `UPDATE tick_shadow_setups SET
        forward_60s_pct = ?,
        forward_60s_positive = ?,
        resolved_at = ?,
        status = 'complete'
       WHERE id = ?`,
    )
    .bind(forwardPct, positive ? 1 : 0, resolvedAt, id)
    .run();
  return db.prepare('SELECT * FROM tick_shadow_setups WHERE id = ?').bind(id).first<TickShadowRow>();
}

export async function purgeOldTickShadowSetups(db: D1Database, olderThanMs: number): Promise<void> {
  await db
    .prepare(`DELETE FROM tick_shadow_setups WHERE recorded_at_ms < ?`)
    .bind(olderThanMs)
    .run();
}

export function forwardPctFromRef(refPrice: string, currentPrice: string): string | null {
  const ref = bn(refPrice);
  if (ref.lte(0)) return null;
  const cur = bn(currentPrice);
  if (!cur.isFinite() || cur.lte(0)) return null;
  return cur.minus(ref).dividedBy(ref).times(100).toFixed(4);
}
