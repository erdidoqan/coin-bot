import type { ShadowHorizonMin } from '../indicators/micro-shadow';

export interface ShadowSetupInput {
  symbol: string;
  recordedAtMs: number;
  entryRefPrice: string;
  score: string;
  microOk: boolean;
  pass: boolean;
  failReason: string | null;
  regime: string | null;
  trend15mOk: boolean;
  regimeAllowed: boolean;
  wouldPassScoreOnly: boolean;
  volumeRatio: string;
  aggressionRatio: string;
}

export interface ShadowSetupRow {
  id: number;
  symbol: string;
  recorded_at_ms: number;
  entry_ref_price: string;
  score: string;
  micro_ok: number;
  pass: number;
  fail_reason: string | null;
  regime: string | null;
  trend15m_ok: number;
  regime_allowed: number;
  would_pass_score_only: number;
  volume_ratio: string | null;
  aggression_ratio: string | null;
  forward_5m_pct: string | null;
  forward_15m_pct: string | null;
  forward_30m_pct: string | null;
  hit_tp_5m: number | null;
  hit_tp_15m: number | null;
  hit_tp_30m: number | null;
  resolved_5m_at: string | null;
  resolved_15m_at: string | null;
  resolved_30m_at: string | null;
  status: string;
}

export interface ShadowFailReasonStats {
  failReason: string;
  n: number;
  avgForward30m: string | null;
  hitTp30mPct: string | null;
}

export interface ShadowSummary {
  days: number;
  total: number;
  completed: number;
  byFailReason: ShadowFailReasonStats[];
  wouldPassScoreOnly: {
    n: number;
    avgForward30m: string | null;
    hitTp30mPct: string | null;
  };
}

function horizonColumn(h: ShadowHorizonMin): {
  forward: 'forward_5m_pct' | 'forward_15m_pct' | 'forward_30m_pct';
  hitTp: 'hit_tp_5m' | 'hit_tp_15m' | 'hit_tp_30m';
  resolved: 'resolved_5m_at' | 'resolved_15m_at' | 'resolved_30m_at';
} {
  switch (h) {
    case 5:
      return { forward: 'forward_5m_pct', hitTp: 'hit_tp_5m', resolved: 'resolved_5m_at' };
    case 15:
      return { forward: 'forward_15m_pct', hitTp: 'hit_tp_15m', resolved: 'resolved_15m_at' };
    case 30:
      return { forward: 'forward_30m_pct', hitTp: 'hit_tp_30m', resolved: 'resolved_30m_at' };
  }
}

export async function hasRecentPendingShadow(
  db: D1Database,
  symbol: string,
  dedupeMinutes: number,
  nowMs: number,
): Promise<boolean> {
  const sinceMs = nowMs - dedupeMinutes * 60_000;
  const row = await db
    .prepare(
      `SELECT 1 FROM micro_shadow_setups
       WHERE symbol = ? AND status = 'pending' AND recorded_at_ms >= ?
       LIMIT 1`,
    )
    .bind(symbol, sinceMs)
    .first();
  return row != null;
}

export async function insertShadowSetup(db: D1Database, input: ShadowSetupInput): Promise<number | null> {
  const result = await db
    .prepare(
      `INSERT INTO micro_shadow_setups (
        symbol, recorded_at_ms, entry_ref_price, score, micro_ok, pass,
        fail_reason, regime, trend15m_ok, regime_allowed, would_pass_score_only,
        volume_ratio, aggression_ratio, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    )
    .bind(
      input.symbol,
      input.recordedAtMs,
      input.entryRefPrice,
      input.score,
      input.microOk ? 1 : 0,
      input.pass ? 1 : 0,
      input.failReason,
      input.regime,
      input.trend15mOk ? 1 : 0,
      input.regimeAllowed ? 1 : 0,
      input.wouldPassScoreOnly ? 1 : 0,
      input.volumeRatio,
      input.aggressionRatio,
    )
    .run();
  return result.meta.last_row_id ?? null;
}

export async function listPendingShadowSetups(db: D1Database, limit = 200): Promise<ShadowSetupRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM micro_shadow_setups
       WHERE status = 'pending'
       ORDER BY recorded_at_ms ASC
       LIMIT ?`,
    )
    .bind(limit)
    .all<ShadowSetupRow>();
  return results ?? [];
}

export async function updateShadowHorizon(
  db: D1Database,
  id: number,
  horizonMin: ShadowHorizonMin,
  forwardPct: string,
  hitTp: boolean,
  resolvedAt: string,
  horizons: ShadowHorizonMin[],
): Promise<ShadowSetupRow | null> {
  const cols = horizonColumn(horizonMin);
  await db
    .prepare(
      `UPDATE micro_shadow_setups SET
        ${cols.forward} = ?,
        ${cols.hitTp} = ?,
        ${cols.resolved} = ?
       WHERE id = ?`,
    )
    .bind(forwardPct, hitTp ? 1 : 0, resolvedAt, id)
    .run();

  const row = await db
    .prepare('SELECT * FROM micro_shadow_setups WHERE id = ?')
    .bind(id)
    .first<ShadowSetupRow>();
  if (!row) return null;

  const allResolved = horizons.every((h) => {
    const c = horizonColumn(h);
    return row[c.resolved] != null && row[c.forward] != null;
  });
  if (!allResolved) return row;

  await db.prepare(`UPDATE micro_shadow_setups SET status = 'complete' WHERE id = ?`).bind(id).run();
  return { ...row, status: 'complete' };
}

export async function purgeOldShadowSetups(db: D1Database, days: number): Promise<number> {
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const result = await db
    .prepare(
      `DELETE FROM micro_shadow_setups
       WHERE status = 'complete' AND recorded_at_ms < ?`,
    )
    .bind(cutoffMs)
    .run();
  return result.meta.changes ?? 0;
}

function fmtAvg(n: number | null): string | null {
  if (n == null || Number.isNaN(n)) return null;
  return n.toFixed(2);
}

function fmtHitPct(hits: number, total: number): string | null {
  if (total === 0) return null;
  return ((hits / total) * 100).toFixed(1);
}

export async function getShadowSummary(db: D1Database, days: number): Promise<ShadowSummary> {
  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;

  const totalRow = await db
    .prepare(
      `SELECT COUNT(*) as c FROM micro_shadow_setups WHERE recorded_at_ms >= ?`,
    )
    .bind(sinceMs)
    .first<{ c: number }>();

  const completedRow = await db
    .prepare(
      `SELECT COUNT(*) as c FROM micro_shadow_setups
       WHERE recorded_at_ms >= ? AND status = 'complete'`,
    )
    .bind(sinceMs)
    .first<{ c: number }>();

  const { results: byReason } = await db
    .prepare(
      `SELECT
         COALESCE(fail_reason, 'unknown') as fail_reason,
         COUNT(*) as n,
         AVG(CAST(forward_30m_pct AS REAL)) as avg_fwd,
         SUM(CASE WHEN hit_tp_30m = 1 THEN 1 ELSE 0 END) as hits
       FROM micro_shadow_setups
       WHERE recorded_at_ms >= ? AND status = 'complete' AND forward_30m_pct IS NOT NULL
       GROUP BY fail_reason
       ORDER BY n DESC`,
    )
    .bind(sinceMs)
    .all<{ fail_reason: string; n: number; avg_fwd: number | null; hits: number }>();

  const wpsRow = await db
    .prepare(
      `SELECT
         COUNT(*) as n,
         AVG(CAST(forward_30m_pct AS REAL)) as avg_fwd,
         SUM(CASE WHEN hit_tp_30m = 1 THEN 1 ELSE 0 END) as hits
       FROM micro_shadow_setups
       WHERE recorded_at_ms >= ? AND status = 'complete'
         AND would_pass_score_only = 1 AND forward_30m_pct IS NOT NULL`,
    )
    .bind(sinceMs)
    .first<{ n: number; avg_fwd: number | null; hits: number }>();

  const total = totalRow?.c ?? 0;
  const completed = completedRow?.c ?? 0;

  return {
    days,
    total,
    completed,
    byFailReason: (byReason ?? []).map((r) => ({
      failReason: r.fail_reason,
      n: r.n,
      avgForward30m: fmtAvg(r.avg_fwd),
      hitTp30mPct: fmtHitPct(r.hits, r.n),
    })),
    wouldPassScoreOnly: {
      n: wpsRow?.n ?? 0,
      avgForward30m: fmtAvg(wpsRow?.avg_fwd ?? null),
      hitTp30mPct: fmtHitPct(wpsRow?.hits ?? 0, wpsRow?.n ?? 0),
    },
  };
}
