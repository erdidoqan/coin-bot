import type { BinanceClient } from './binance';
import { logEvent } from '../db/trade-log';

/** Semboldeki tüm açık emirleri iptal eder (trailing kilitli bakiye için). */
export async function cancelAllOpenOrdersForSymbol(
  db: D1Database,
  client: BinanceClient,
  symbol: string,
): Promise<number[]> {
  const open = await client.getOpenOrders(symbol);
  const canceled: number[] = [];
  for (const order of open) {
    try {
      await client.cancelOrder(symbol, order.orderId);
      canceled.push(order.orderId);
    } catch {
      /* zaten kapalı olabilir */
    }
  }
  if (canceled.length > 0) {
    await logEvent(db, 'OPEN_ORDERS_CANCELED', { symbol, orderIds: canceled });
  }
  return canceled;
}
