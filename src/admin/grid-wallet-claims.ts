import { getGridFilledStats, type GridStateRow } from '../db/grid';

export interface SymbolWalletClaims {
  recoveryQty: number;
  activeTrackedQty: number;
  totalClaimed: number;
}

/** Grid'lerin iddia ettiği miktarın üstündeki serbest bakiye (öksüz fazla). */
export function computeExcessFree(
  free: number,
  locked: number,
  claims: SymbolWalletClaims | undefined,
): number {
  if (!(free > 0)) return 0;
  if (!claims || claims.totalClaimed <= 0) return free;
  const reservedFromFree = Math.max(0, claims.totalClaimed - locked);
  return Math.max(0, free - reservedFromFree);
}

export async function buildSymbolWalletClaimsMap(
  db: D1Database,
  actives: GridStateRow[],
  recovering: GridStateRow[],
): Promise<Map<string, SymbolWalletClaims>> {
  const map = new Map<string, SymbolWalletClaims>();

  const ensure = (symbol: string): SymbolWalletClaims => {
    let c = map.get(symbol);
    if (!c) {
      c = { recoveryQty: 0, activeTrackedQty: 0, totalClaimed: 0 };
      map.set(symbol, c);
    }
    return c;
  };

  for (const g of recovering) {
    const c = ensure(g.symbol);
    c.recoveryQty += Number(g.recovery_qty ?? 0);
  }

  await Promise.all(
    actives.map(async (g) => {
      const stats = await getGridFilledStats(db, g.id);
      const c = ensure(g.symbol);
      c.activeTrackedQty += Math.max(0, stats.boughtQty - stats.soldQty);
    }),
  );

  for (const c of map.values()) {
    c.totalClaimed = c.recoveryQty + c.activeTrackedQty;
  }

  return map;
}
