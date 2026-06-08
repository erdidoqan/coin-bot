/**
 * Native trailing (TAKE_PROFIT) emri koy + open_positions satırı aç.
 *
 * Dip Reversal girişinin trailing kurulum sekansı buradan paylaşılır; grid de
 * (alım sonrası) aynı tek-pozisyon + trailing/hard-stop modelini kullanır.
 */
import type { EntryMode } from '../db/bot-state';
import { createOpenPosition } from '../db/open-positions';
import { logEvent } from '../db/trade-log';
import type { SymbolInfo } from '../exchange/binance';
import type { TradingGateway } from '../exchange/gateway';
import { resolveTieredTrailing } from '../exchange/trailing-stop';
import { emergencyMarketSell } from '../jobs/emergency-exit';

export interface OpenTrailingPositionArgs {
  symbol: string;
  /** exchangeInfo symbol filtreleri (resolveTieredTrailing için ham filtre dizisi). */
  symbolFilters: SymbolInfo['filters'];
  tickSize: string;
  /** Trailing'e konacak miktar — çağıran tarafça formatlanmış + minQty doğrulanmış olmalı. */
  sellQty: string;
  /** Net sahip olunan miktar (trailing reddinde acil satış için). */
  netBaseQty: string;
  /** Toplam (brüt) alınan miktar — total_base_qty. */
  grossBaseQty: string;
  avgCost: string;
  usdtSpent: string;
  entryMode: EntryMode;
  trailingActivationPct: string;
  trailingCallbackPct: string;
  hardStopPct: string;
  /** Strateji-özel log event isimleri (dashboard filtreleri için). */
  events?: {
    rejected?: string;
    emergencySellFailed?: string;
  };
}

/**
 * Trailing emrini koyar ve open_positions satırını açar. Başarılıysa true;
 * trailing reddedilirse acil market satış dener ve false döner.
 */
export async function openTrailingPosition(
  env: Env,
  gateway: TradingGateway,
  args: OpenTrailingPositionArgs,
): Promise<boolean> {
  const rejectedEvent = args.events?.rejected ?? 'TRAILING_REJECTED';
  const emergencyFailedEvent = args.events?.emergencySellFailed ?? 'EMERGENCY_SELL_FAILED';

  try {
    const tiered = resolveTieredTrailing(
      args.avgCost,
      args.trailingActivationPct,
      args.trailingCallbackPct,
      args.tickSize,
      args.symbolFilters,
    );
    const trail = await gateway.placeTrailingStop(args.symbol, args.sellQty, tiered);
    await createOpenPosition(env.DB, {
      symbol: args.symbol,
      entry_mode: args.entryMode,
      net_base_qty: args.netBaseQty,
      total_usdt_spent: args.usdtSpent,
      total_base_qty: args.grossBaseQty,
      avg_cost: args.avgCost,
      trailing_order_id: String(trail.orderId),
      take_profit_price: null,
      scalp_stop_loss_pct: args.hardStopPct,
    });
    await logEvent(env.DB, 'TRAILING_PLACED', {
      symbol: args.symbol,
      orderId: trail.orderId,
      sellQty: args.sellQty,
      avg_cost: args.avgCost,
      activationStopPrice: tiered.stopPrice,
      trailingActivationPct: args.trailingActivationPct,
      trailingCallbackPct: args.trailingCallbackPct,
      trailingDeltaBips: tiered.trailingDeltaBips,
      orderType: 'TAKE_PROFIT',
      entry_mode: args.entryMode,
    });
    return true;
  } catch (trailErr) {
    await logEvent(env.DB, rejectedEvent, {
      symbol: args.symbol,
      sellQty: args.sellQty,
      entry_mode: args.entryMode,
      error: trailErr instanceof Error ? trailErr.message : String(trailErr),
    });
    try {
      await emergencyMarketSell(env, gateway, args.symbol, args.netBaseQty);
    } catch (sellErr) {
      await logEvent(env.DB, emergencyFailedEvent, {
        symbol: args.symbol,
        entry_mode: args.entryMode,
        message: sellErr instanceof Error ? sellErr.message : String(sellErr),
      });
    }
    return false;
  }
}
