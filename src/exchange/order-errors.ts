import { BinanceApiError } from './binance';

/** trade_log payload için Binance / genel hata alanları. */
export function serializeBinanceError(err: unknown): {
  message: string;
  code?: number;
  status?: number;
  name?: string;
} {
  if (err instanceof BinanceApiError) {
    return {
      message: err.message,
      code: err.code,
      status: err.status,
      name: err.name,
    };
  }
  if (err instanceof Error) {
    return { message: err.message, name: err.name };
  }
  return { message: String(err) };
}

/** Binance'te artık bulunamayan / arşivlenmiş emir sorguları. */
export function isOrderGoneError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (
    msg.includes('archived') ||
    msg.includes('Unknown order') ||
    msg.includes('Order does not exist') ||
    msg.includes('Invalid orderId')
  ) {
    return true;
  }
  if (err instanceof BinanceApiError && (err.code === -2013 || err.code === -2011)) {
    return true;
  }
  return false;
}

/**
 * İptal çağrısında beklenen hatalar (emir yok / zaten dolmuş → iptal reddi).
 * Yine de GRID_BINANCE_API_WARN ile loglanır.
 */
/** REST weight / IP ban / 418–429 — yeni girişleri durdurmak için. */
export function isBinanceRateLimitError(err: unknown): boolean {
  if (err instanceof BinanceApiError) {
    if (err.status === 418 || err.status === 429) return true;
    if (err.code === -1003) return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /request weight|IP banned|too many requests|status code 418|status code 429/i.test(
    msg,
  );
}

export function isBenignCancelError(err: unknown): boolean {
  if (isOrderGoneError(err)) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('CANCEL_REJECTED') ||
    msg.includes('Order was not canceled') ||
    msg.includes('already filled')
  );
}
