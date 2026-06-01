/** Recovery satışı: yalnızca bu grid'in izlenen kalanı; cüzdan free ile çaplanır. */
export function capRecoverySellBaseQty(trackedRemaining: number, freeBase: number): number {
  const tracked = Math.max(0, trackedRemaining);
  const free = Math.max(0, freeBase);
  return Math.min(tracked, free);
}
