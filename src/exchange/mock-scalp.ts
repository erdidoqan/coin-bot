import { logEvent } from '../db/trade-log';
import { bn } from '../math/decimal';

/** Dry-run: TP fiyatına ulaşıldığında log (gerçek emir reconcile market sell ile kapanır). */
export async function logMockScalpTpHit(
  env: Env,
  symbol: string,
  lastPrice: string,
  takeProfitPrice: string,
): Promise<void> {
  if (String(env.TRADING_ENABLED) === 'true') return;
  if (!takeProfitPrice || bn(lastPrice).lt(takeProfitPrice)) return;

  await logEvent(env.DB, 'MOCK_SCALP_FILLED', {
    symbol,
    lastPrice,
    take_profit_price: takeProfitPrice,
    note: 'Dry-run TP eşiği — market sell reconcile ile tamamlanır',
  });
}
