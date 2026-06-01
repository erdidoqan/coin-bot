import type { TradingGateway } from './gateway';

const TERMINAL = new Set(['CANCELED', 'EXPIRED', 'FILLED', 'REJECTED']);

/** Trailing iptal edilir; bakiye serbest kalana kadar kısa poll. */
export async function ensureTrailingCanceled(
  gateway: TradingGateway,
  symbol: string,
  orderId: string | number,
  maxAttempts = 6,
): Promise<'canceled' | 'filled' | 'pending'> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await gateway.cancelTrailingOrder(symbol, orderId);
    } catch {
      /* zaten iptal olabilir */
    }

    const order = await gateway.getOrder(symbol, orderId);
    if (order.status === 'FILLED') return 'filled';
    if (TERMINAL.has(order.status)) return 'canceled';

    await sleep(250);
  }
  return 'pending';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
