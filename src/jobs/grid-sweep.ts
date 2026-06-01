/**
 * Öksüz bag süpürücü (one-shot, manuel).
 *
 * Cüzdanda kalan sahipsiz bag'ler (aktif/recovering grid'i olmayan, BNB/stable hariç):
 *   - KÂRDA (güncel fiyat >= maliyet + fee)  -> direkt MARKET satış (kapat, USDT'ye dön).
 *   - ZARARDA                                 -> break-even+margin LIMIT_MAKER + RECOVERING grid.
 *
 * Maliyet bazı GERÇEK işlem geçmişinden (myTrades, kronolojik hareketli ortalama) hesaplanır;
 * veri yoksa grid FILLED alışları, o da yoksa güncel fiyat baz alınır. Recovery pozisyonlarına
 * ve BNB/stable varlıklara dokunulmaz.
 */
import {
  getGridConfig,
  getActiveGrids,
  getRecoveringGrids,
  getGridFilledStatsBySymbol,
  createRecoveryGrid,
} from '../db/grid';
import { logEvent } from '../db/trade-log';
import { TradingGateway } from '../exchange/gateway';
import type { MyTrade } from '../exchange/binance';
import {
  parseSymbolFilters,
  formatPrice,
  formatQuantity,
  meetsMinNotional,
  meetsMinQty,
} from '../exchange/symbol-filters';
import { bn } from '../math/decimal';
import { buildSymbolWalletClaimsMap, computeExcessFree } from '../admin/grid-wallet-claims';

function tradingEnabled(env: Env): boolean {
  return String(env.TRADING_ENABLED) === 'true';
}

/** Tutulan envanterin ortalama maliyeti: işlemleri kronolojik gez, alışta ekle,
 * satışta ortalama maliyetle azalt. Kalan = cost/pos. Veri yoksa null. */
export function avgCostFromTrades(trades: MyTrade[]): number | null {
  const sorted = [...trades].sort((a, b) => a.time - b.time);
  let pos = 0;
  let cost = 0;
  for (const t of sorted) {
    const q = Number(t.qty);
    const quote = Number(t.quoteQty);
    if (!(q > 0)) continue;
    if (t.isBuyer) {
      pos += q;
      cost += quote;
    } else if (pos > 0) {
      const avg = cost / pos;
      const sellQ = Math.min(q, pos);
      cost -= avg * sellQ;
      pos -= sellQ;
    }
  }
  if (!(pos > 0) || !(cost > 0)) return null;
  return cost / pos;
}

/** LIMIT_MAKER satış fiyatı her zaman güncel fiyatın üstünde (yoksa taker -> red). */
function makerSellPrice(target: number, lastPrice: number, tickSize: string): string {
  const tick = Number(tickSize) || 0;
  const desired = Math.max(target, lastPrice + tick);
  let s = formatPrice(String(desired), tickSize);
  let guard = 0;
  while (Number(s) <= lastPrice && guard < 20) {
    s = formatPrice(String(Number(s) + (tick || Number(s) * 0.0001)), tickSize);
    guard++;
  }
  return s;
}

const QUOTE = 'USDT';
const ALWAYS_EXCLUDE = new Set(['USDT', 'BNB', 'BUSD', 'FDUSD', 'USDC', 'LUNC']);

export async function runGridSweep(env: Env): Promise<void> {
  const cfg = await getGridConfig(env.DB, env);
  const realMode = tradingEnabled(env) && cfg.liveGate;
  if (!realMode) {
    await logEvent(env.DB, 'GRID_SWEEP', { reason: 'not_live_mode', live: false });
    return;
  }

  const gateway = new TradingGateway(env);

  // Aktif/recovering gridler -> bunların envanterine dokunma.
  const [actives, recovering] = await Promise.all([
    getActiveGrids(env.DB),
    getRecoveringGrids(env.DB),
  ]);
  const busy = new Set<string>([
    ...actives.map((g) => g.symbol),
    ...recovering.map((g) => g.symbol),
  ]);
  const claimsMap = await buildSymbolWalletClaimsMap(env.DB, actives, recovering);
  const excludeAssets = new Set<string>([
    ...ALWAYS_EXCLUDE,
    ...cfg.excludeSymbols.map((s) => s.replace(QUOTE, '')),
  ]);

  const balances = await gateway.binance.getAccountBalances();

  let swept = 0;
  let skipped = 0;
  for (const b of balances) {
    const free = Number(b.free);
    if (!(free > 0)) continue;
    if (excludeAssets.has(b.asset)) continue;

    const symbol = `${b.asset}${QUOTE}`;
    const locked = Number(b.locked);
    let sweepFree = free;
    if (busy.has(symbol)) {
      sweepFree = computeExcessFree(free, locked, claimsMap.get(symbol));
      if (!(sweepFree > 0)) continue;
    }

    try {
      let lastPrice: number;
      try {
        lastPrice = Number(await gateway.binance.getSymbolPrice(symbol));
      } catch {
        continue; // USDT paritesi yoksa atla
      }
      if (!(lastPrice > 0)) continue;

      const info = await gateway.binance.getExchangeInfo(symbol);
      const symInfo = info.symbols[0];
      if (!symInfo) continue;
      const filters = parseSymbolFilters(symInfo);

      const sellQty = formatQuantity(String(sweepFree), filters.stepSize);
      if (!meetsMinQty(sellQty, filters.minQty) || bn(sellQty).lte(0)) {
        skipped++;
        continue;
      }

      // Maliyet bazı: önce GERÇEK işlem geçmişi (myTrades hareketli ort.),
      // yoksa grid FILLED alışları, o da yoksa güncel fiyat.
      let avgCost: number | null = null;
      try {
        const trades = await gateway.binance.getMyTrades(symbol, 1000);
        avgCost = avgCostFromTrades(trades);
      } catch {
        /* myTrades alınamazsa fallback */
      }
      let costSource = 'trades';
      if (avgCost == null) {
        const stats = await getGridFilledStatsBySymbol(env.DB, symbol);
        if (stats.boughtQty > 0) {
          avgCost = stats.boughtCost / stats.boughtQty;
          costSource = 'grid_orders';
        } else {
          avgCost = lastPrice;
          costSource = 'last_price';
        }
      }

      const feePct = cfg.feeRoundtripPct / 100;
      const unrealizedPct = avgCost > 0 ? ((lastPrice - avgCost) / avgCost) * 100 : 0;
      // KÂRDA: güncel fiyat maliyet+fee'yi geçiyorsa direkt market sat (USDT'ye dön).
      const inProfit = lastPrice >= avgCost * (1 + feePct);

      // Market satışta notional güncel fiyatla minNotional'ı geçmeli.
      const marketNotional = bn(sellQty).times(lastPrice).toFixed(8);
      if (!meetsMinNotional(marketNotional, filters.minNotional)) {
        skipped++;
        await logEvent(env.DB, 'GRID_SWEEP_SKIP', {
          symbol,
          reason: 'min_notional',
          sellQty,
          lastPrice,
          minNotional: filters.minNotional,
        });
        continue;
      }

      if (inProfit) {
        try {
          const order = await gateway.marketSell(symbol, sellQty);
          swept++;
          await logEvent(env.DB, 'GRID_SWEEP_SOLD', {
            symbol,
            sellQty,
            avgCost: Number(avgCost.toFixed(8)),
            lastPrice,
            unrealizedPct: Number(unrealizedPct.toFixed(2)),
            proceedsUsdt: order.cummulativeQuoteQty ?? null,
            costSource,
          });
        } catch (err) {
          skipped++;
          await logEvent(env.DB, 'GRID_SWEEP_FAILED', {
            symbol,
            action: 'market_sell',
            message: err instanceof Error ? err.message : String(err),
            sellQty,
          });
        }
        continue;
      }

      // ZARARDA: break-even+margin LIMIT_MAKER -> RECOVERING grid (dolunca kapanır).
      const marginPct = (cfg.feeRoundtripPct + cfg.recoveryMarginPct) / 100;
      const rawTarget = avgCost * (1 + marginPct);
      const targetPrice = makerSellPrice(rawTarget, lastPrice, filters.tickSize);

      const notional = bn(sellQty).times(targetPrice).toFixed(8);
      if (!meetsMinNotional(notional, filters.minNotional)) {
        skipped++;
        await logEvent(env.DB, 'GRID_SWEEP_SKIP', {
          symbol,
          reason: 'min_notional',
          sellQty,
          targetPrice,
          minNotional: filters.minNotional,
        });
        continue;
      }

      let orderId: string;
      try {
        const order = await gateway.placeGridLimit(symbol, 'SELL', sellQty, targetPrice);
        orderId = String(order.orderId);
      } catch (err) {
        skipped++;
        await logEvent(env.DB, 'GRID_SWEEP_FAILED', {
          symbol,
          action: 'recovery_limit',
          message: err instanceof Error ? err.message : String(err),
          sellQty,
          targetPrice,
        });
        continue;
      }

      await createRecoveryGrid(env.DB, {
        symbol,
        investmentUsdt: Number(bn(sellQty).times(avgCost).toFixed(4)),
        recoveryOrderId: orderId,
        recoveryTargetPrice: targetPrice,
        recoveryQty: sellQty,
        recoveryAvgCost: String(avgCost),
      });
      busy.add(symbol);
      swept++;

      await logEvent(env.DB, 'GRID_SWEEP_OPENED', {
        symbol,
        sellQty,
        avgCost: Number(avgCost.toFixed(8)),
        targetPrice,
        lastPrice,
        unrealizedPct: Number(unrealizedPct.toFixed(2)),
        costSource,
      });
    } catch (err) {
      await logEvent(env.DB, 'GRID_SWEEP_ERROR', {
        symbol,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await logEvent(env.DB, 'GRID_SWEEP', { swept, skipped, live: true });
}
