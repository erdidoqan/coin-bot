import { bn } from '../math/decimal';

const PEAK_KEY = 'mock_trailing_peak';
const PLACED_KEY = 'mock_trailing_placed_at';
const ACTIVATION_KEY = 'mock_trailing_activation_stop';

async function setKey(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO bot_config (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    )
    .bind(key, value)
    .run();
}

async function getKey(db: D1Database, key: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT value FROM bot_config WHERE key = ?')
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

/** İki kademeli trailing: peak yok, yalnızca aktivasyon stopPrice ve placement zamanı. */
export async function initMockTrailingTiered(
  db: D1Database,
  activationStopPrice: string,
): Promise<void> {
  await setKey(db, ACTIVATION_KEY, activationStopPrice);
  await setKey(db, PLACED_KEY, new Date().toISOString());
  await db.prepare('DELETE FROM bot_config WHERE key = ?').bind(PEAK_KEY).run();
}

export async function clearMockTrailingSim(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM bot_config WHERE key = ?').bind(PEAK_KEY),
    db.prepare('DELETE FROM bot_config WHERE key = ?').bind(PLACED_KEY),
    db.prepare('DELETE FROM bot_config WHERE key = ?').bind(ACTIVATION_KEY),
  ]);
}

export async function getMockTrailingActivationStop(db: D1Database): Promise<string | null> {
  return getKey(db, ACTIVATION_KEY);
}

export async function updateMockTrailingPeak(db: D1Database, lastPrice: string): Promise<string> {
  const current = await getKey(db, PEAK_KEY);
  const peak = current && bn(lastPrice).lte(current) ? current : lastPrice;
  if (peak !== current) await setKey(db, PEAK_KEY, peak);
  return peak;
}

export async function ensureMockTrailingPlacedAt(
  db: D1Database,
  fallbackPlacedAt: string,
): Promise<void> {
  const placed = await getKey(db, PLACED_KEY);
  if (!placed) await setKey(db, PLACED_KEY, fallbackPlacedAt);
}

export async function getMockTrailingPlacedAt(db: D1Database): Promise<string | null> {
  return getKey(db, PLACED_KEY);
}
