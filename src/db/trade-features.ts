export async function insertTradeFeatures(
  db: D1Database,
  row: {
    symbol: string;
    phase: 'entry' | 'exit';
    entry_mode: string | null;
    features: Record<string, unknown>;
    outcome?: string | null;
    pnl?: string | null;
    regime?: string | null;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO trade_features (symbol, phase, entry_mode, features, outcome, pnl, regime)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.symbol,
      row.phase,
      row.entry_mode,
      JSON.stringify(row.features),
      row.outcome ?? null,
      row.pnl ?? null,
      row.regime ?? null,
    )
    .run();
}

export async function getRegimeCache(db: D1Database): Promise<{
  regime: string;
  detail: string | null;
}> {
  const row = await db
    .prepare('SELECT regime, detail FROM regime_cache WHERE id = 1')
    .first<{ regime: string; detail: string | null }>();
  return { regime: row?.regime ?? 'trend', detail: row?.detail ?? null };
}

export async function setRegimeCache(
  db: D1Database,
  regime: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await db
    .prepare(
      `UPDATE regime_cache SET regime = ?, detail = ?, updated_at = datetime('now') WHERE id = 1`,
    )
    .bind(regime, JSON.stringify(detail))
    .run();
}
