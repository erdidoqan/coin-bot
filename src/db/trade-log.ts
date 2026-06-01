export interface TradeLogRow {
  id: number;
  event_type: string;
  payload: string;
  created_at: string;
}

export async function logEvent(
  db: D1Database,
  eventType: string,
  payload: unknown,
): Promise<void> {
  await db
    .prepare('INSERT INTO trade_log (event_type, payload) VALUES (?, ?)')
    .bind(eventType, JSON.stringify(payload))
    .run();
}

function buildExcludeClause(excludeEventTypes?: string[]): { sql: string; binds: string[] } {
  const types = excludeEventTypes?.filter(Boolean) ?? [];
  if (types.length === 0) return { sql: '', binds: [] };
  const placeholders = types.map(() => '?').join(', ');
  return { sql: ` WHERE event_type NOT IN (${placeholders})`, binds: types };
}

export async function listTradeLogs(
  db: D1Database,
  opts: { limit: number; offset: number; eventType?: string; excludeEventTypes?: string[] },
): Promise<TradeLogRow[]> {
  const { limit, offset, eventType, excludeEventTypes } = opts;
  if (eventType) {
    const { results } = await db
      .prepare(
        'SELECT id, event_type, payload, created_at FROM trade_log WHERE event_type = ? ORDER BY id DESC LIMIT ? OFFSET ?',
      )
      .bind(eventType, limit, offset)
      .all<TradeLogRow>();
    return results ?? [];
  }
  const { sql, binds } = buildExcludeClause(excludeEventTypes);
  const { results } = await db
    .prepare(
      `SELECT id, event_type, payload, created_at FROM trade_log${sql} ORDER BY id DESC LIMIT ? OFFSET ?`,
    )
    .bind(...binds, limit, offset)
    .all<TradeLogRow>();
  return results ?? [];
}

export async function countTradeLogs(
  db: D1Database,
  eventType?: string,
  excludeEventTypes?: string[],
): Promise<number> {
  if (eventType) {
    const row = await db
      .prepare('SELECT COUNT(*) as c FROM trade_log WHERE event_type = ?')
      .bind(eventType)
      .first<{ c: number }>();
    return row?.c ?? 0;
  }
  const { sql, binds } = buildExcludeClause(excludeEventTypes);
  const row = await db
    .prepare(`SELECT COUNT(*) as c FROM trade_log${sql}`)
    .bind(...binds)
    .first<{ c: number }>();
  return row?.c ?? 0;
}
