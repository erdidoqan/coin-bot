/** Dry-run emirleri bu aralıktan başlar (gateway mockOrderSeq). */
export const MOCK_ORDER_ID_MIN = 9_000_000;

/**
 * Canlı Binance emir ID'leri de 9M+ olabilir; yalnızca dry-run iken ID aralığına bakılır.
 */
export function isMockOrderId(
  orderId: string | number | null | undefined,
  tradingEnabled: boolean,
): boolean {
  if (tradingEnabled) return false;
  if (orderId == null || orderId === '') return false;
  const n = Number(orderId);
  return Number.isFinite(n) && n >= MOCK_ORDER_ID_MIN;
}
