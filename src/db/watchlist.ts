export interface WatchlistEntry {
  symbol: string;
  added_at: string;
  price_at_addition: string;
  target_sma: string | null;
  momentum_ok: number;
  momentum_checked_at: string | null;
  momentum_detail: string | null;
  micro_score: string | null;
  micro_ok: number;
  micro_checked_at: string | null;
  micro_detail: string | null;
  sector_tag: string | null;
}

export interface WatchlistItemInput {
  symbol: string;
  price_at_addition: string;
  target_sma?: string | null;
  sector_tag?: string | null;
}

export interface MomentumCacheUpdate {
  symbol: string;
  momentum_ok: boolean;
  momentum_detail: string;
}

export interface MicroScalpCacheUpdate {
  symbol: string;
  micro_ok: boolean;
  micro_score: string;
  micro_detail: string;
}

export async function listWatchlist(db: D1Database): Promise<WatchlistEntry[]> {
  const { results } = await db
    .prepare(
      `SELECT symbol, added_at, price_at_addition, target_sma,
              momentum_ok, momentum_checked_at, momentum_detail,
              micro_score, micro_ok, micro_checked_at, micro_detail, sector_tag
       FROM watchlist ORDER BY added_at, rowid`,
    )
    .all<WatchlistEntry>();
  return results ?? [];
}

/** Gözcü listeyi yeniler; aynı sembollerde micro/momentum cache korunur. */
export async function replaceWatchlist(db: D1Database, items: WatchlistItemInput[]): Promise<void> {
  const existing = await listWatchlist(db);
  const cache = new Map(existing.map((e) => [e.symbol, e]));

  const stmts = [
    db.prepare('DELETE FROM watchlist'),
    ...items.map((item) => {
      const prev = cache.get(item.symbol);
      return db
        .prepare(
          `INSERT INTO watchlist (
            symbol, price_at_addition, target_sma,
            momentum_ok, momentum_checked_at, momentum_detail,
            micro_score, micro_ok, micro_checked_at, micro_detail, sector_tag
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          item.symbol,
          item.price_at_addition,
          item.target_sma ?? null,
          prev?.momentum_ok ?? 0,
          prev?.momentum_checked_at ?? null,
          prev?.momentum_detail ?? null,
          prev?.micro_score ?? null,
          prev?.micro_ok ?? 0,
          prev?.micro_checked_at ?? null,
          prev?.micro_detail ?? null,
          item.sector_tag ?? prev?.sector_tag ?? null,
        );
    }),
  ];
  await db.batch(stmts);
}

export async function updateWatchlistMomentum(
  db: D1Database,
  updates: MomentumCacheUpdate[],
): Promise<void> {
  const now = new Date().toISOString();
  const stmts = updates.map((u) =>
    db
      .prepare(
        `UPDATE watchlist SET
          momentum_ok = ?,
          momentum_checked_at = ?,
          momentum_detail = ?
         WHERE symbol = ?`,
      )
      .bind(u.momentum_ok ? 1 : 0, now, u.momentum_detail, u.symbol),
  );
  if (stmts.length > 0) await db.batch(stmts);
}

export async function updateWatchlistMicroScalp(
  db: D1Database,
  updates: MicroScalpCacheUpdate[],
): Promise<void> {
  const now = new Date().toISOString();
  const stmts = updates.map((u) =>
    db
      .prepare(
        `UPDATE watchlist SET
          micro_ok = ?,
          micro_score = ?,
          micro_checked_at = ?,
          micro_detail = ?
         WHERE symbol = ?`,
      )
      .bind(u.micro_ok ? 1 : 0, u.micro_score, now, u.micro_detail, u.symbol),
  );
  if (stmts.length > 0) await db.batch(stmts);
}

/** micro_ok semboller, skor azalan. */
export async function listMicroScalpCandidates(db: D1Database): Promise<WatchlistEntry[]> {
  const { results } = await db
    .prepare(
      `SELECT symbol, added_at, price_at_addition, target_sma,
              momentum_ok, momentum_checked_at, momentum_detail,
              micro_score, micro_ok, micro_checked_at, micro_detail, sector_tag
       FROM watchlist
       WHERE micro_ok = 1
       ORDER BY CAST(micro_score AS REAL) DESC`,
    )
    .all<WatchlistEntry>();
  return results ?? [];
}
