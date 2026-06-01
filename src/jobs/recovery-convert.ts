/**
 * Kurtarma pozisyonunu manuel olarak USDT'ye çevir (gerekirse zararına).
 *
 * Recovery LIMIT_MAKER emrini iptal eder, eldeki miktarı MARKET satar ve realize PnL'i
 * (genelde zarar → kırmızı) GRID_RECOVERY_FILLED olarak loglar; grid kapanır. Panelin
 * "Bugün realize" bölümü bu olayı otomatik gösterir.
 */
import {
  getGridConfig,
  getGridById,
  closeRecoveredGrid,
  stopGrid,
} from '../db/grid';
import { logEvent } from '../db/trade-log';
import { TradingGateway } from '../exchange/gateway';
import {
  parseSymbolFilters,
  formatQuantity,
  meetsMinNotional,
  meetsMinQty,
} from '../exchange/symbol-filters';
import { bn } from '../math/decimal';

function tradingEnabled(env: Env): boolean {
  return String(env.TRADING_ENABLED) === 'true';
}

export interface RecoveryConvertResult {
  ok: boolean;
  message: string;
  symbol?: string;
  pnl?: string;
  proceeds?: string;
}

export async function convertRecoveryToUsdt(
  env: Env,
  gridId: number,
): Promise<RecoveryConvertResult> {
  const grid = await getGridById(env.DB, gridId);
  if (!grid) return { ok: false, message: 'not_found' };
  if (grid.status !== 'RECOVERING') return { ok: false, message: 'not_recovering' };

  const cfg = await getGridConfig(env.DB, env);
  const gateway = new TradingGateway(env);
  const realMode = tradingEnabled(env) && cfg.liveGate;
  const symbol = grid.symbol;
  const asset = symbol.replace(/USDT$/, '');
  const avgCost = Number(grid.recovery_avg_cost ?? 0);
  const recQty = grid.recovery_qty ?? '0';

  // Recovery LIMIT_MAKER emrini iptal et (kilitli envanteri serbest bırak).
  if (realMode && grid.recovery_order_id && !grid.recovery_order_id.startsWith('mock-')) {
    try {
      await gateway.binance.cancelOrder(symbol, grid.recovery_order_id);
    } catch {
      /* zaten dolmuş/iptal olabilir; satışa devam */
    }
  }

  const info = await gateway.binance.getExchangeInfo(symbol);
  const symInfo = info.symbols[0];
  if (!symInfo) return { ok: false, message: 'no_symbol_info' };
  const filters = parseSymbolFilters(symInfo);
  const lastPrice = Number(await gateway.binance.getSymbolPrice(symbol));

  // Satılacak miktar: recovery_qty, cüzdandaki serbest bakiye ile sınırla.
  let targetQty = Number(recQty);
  if (realMode) {
    const balances = await gateway.binance.getAccountBalances();
    const free = Number(balances.find((b) => b.asset === asset)?.free ?? 0);
    targetQty = Math.min(targetQty, free);
  }
  const sellQty = formatQuantity(String(targetQty), filters.stepSize);

  // Satılacak miktar yoksa/dust ise: gridi 0 PnL ile kapat (envanter zaten gitmiş).
  if (!meetsMinQty(sellQty, filters.minQty) || bn(sellQty).lte(0)) {
    await closeRecoveredGrid(env.DB, gridId, '0');
    await logEvent(env.DB, 'GRID_RECOVERY_FILLED', {
      symbol,
      gridId,
      qty: '0',
      avgCost,
      pnl: '0',
      source: 'manual_convert',
      note: 'no_sellable_qty',
    });
    return { ok: true, message: 'closed_no_qty', symbol, pnl: '0' };
  }

  const notional = bn(sellQty).times(lastPrice).toFixed(8);
  if (!meetsMinNotional(notional, filters.minNotional)) {
    return { ok: false, message: 'min_notional', symbol };
  }

  let proceeds: number;
  try {
    if (realMode) {
      const order = await gateway.marketSell(symbol, sellQty);
      proceeds = Number(order.cummulativeQuoteQty ?? 0) || Number(sellQty) * lastPrice;
    } else {
      proceeds = Number(sellQty) * lastPrice;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logEvent(env.DB, 'GRID_RECOVERY_CONVERT_FAILED', { symbol, gridId, message, sellQty });
    return { ok: false, message, symbol };
  }

  const cost = avgCost * Number(sellQty);
  const feePct = cfg.feeRoundtripPct / 100;
  const pnl = (proceeds - cost - proceeds * feePct).toFixed(6);

  await closeRecoveredGrid(env.DB, gridId, pnl);
  await logEvent(env.DB, 'GRID_RECOVERY_FILLED', {
    symbol,
    gridId,
    qty: sellQty,
    avgCost,
    proceeds: proceeds.toFixed(6),
    lastPrice,
    pnl,
    source: 'manual_convert',
  });

  // Güvenlik: grid hâlâ recovering kaldıysa durdur.
  const after = await getGridById(env.DB, gridId);
  if (after && after.status === 'RECOVERING') {
    await stopGrid(env.DB, gridId, 'manual_convert');
  }

  return { ok: true, message: 'converted', symbol, pnl, proceeds: proceeds.toFixed(6) };
}
