/**
 * Dip Reversal Sniper — giriş döngüsü (her dk).
 *
 * Paylaşılan tarama (`scanDipReversalCandidates`) ile capitulation dip + bounce
 * onayı olan en iyi adayı seçer, tek market alım yapar ve Binance native trailing
 * (TAKE_PROFIT) emri koyar. Grid'in aktif/recovering sembollerine ve açık pozisyonu
 * olan sembollere girmez (tam izolasyon). Panel ile AYNI taramayı kullanır.
 */
import { getDipReversalConfig, type DipReversalConfig } from '../db/dip-reversal';
import { computeAvgCost } from '../db/bot-state';
import { countOpenPositions, createOpenPosition } from '../db/open-positions';
import { logEvent } from '../db/trade-log';
import { TradingGateway, netQtyFromBuy } from '../exchange/gateway';
import { fetchRegimeFromDo } from '../exchange/market-data-client';
import {
  formatQuantity,
  meetsMinNotional,
  meetsMinQty,
  parseSymbolFilters,
} from '../exchange/symbol-filters';
import { resolveTieredTrailing } from '../exchange/trailing-stop';
import { scanDipReversalCandidates, type DipReversalScanRow } from './dip-reversal-scan';
import { emergencyMarketSell } from './emergency-exit';

async function executeDipReversalEntry(
  env: Env,
  gateway: TradingGateway,
  candidate: DipReversalScanRow,
  cfg: DipReversalConfig,
): Promise<boolean> {
  const { symbol } = candidate;
  const info = await gateway.binance.getExchangeInfo(symbol);
  const symInfo = info.symbols[0];
  if (!symInfo) return false;

  const filters = parseSymbolFilters(symInfo);
  if (!meetsMinNotional(cfg.buyQuoteUsdt, filters.minNotional)) {
    await logEvent(env.DB, 'DIP_REVERSAL_MIN_NOTIONAL_SKIP', {
      symbol,
      quoteUsdt: cfg.buyQuoteUsdt,
      minNotional: filters.minNotional,
    });
    return false;
  }

  const buyOrder = await gateway.marketBuy(symbol, cfg.buyQuoteUsdt);
  const net = netQtyFromBuy(buyOrder, symbol);
  const usdtSpent = buyOrder.cummulativeQuoteQty ?? cfg.buyQuoteUsdt;
  const avgCost = computeAvgCost(usdtSpent, net.net_base_qty);

  await logEvent(env.DB, 'BUY_FILLED', {
    symbol,
    order: buyOrder,
    entry_mode: 'dip_reversal',
    windowDropPct: candidate.windowDropPct,
    reversalScore: candidate.reversalScore,
  });

  const sellQty = formatQuantity(net.net_base_qty, filters.stepSize);
  if (!meetsMinQty(sellQty, filters.minQty)) {
    await logEvent(env.DB, 'DIP_REVERSAL_LOT_SIZE_TOO_SMALL', {
      symbol,
      sellQty,
      minQty: filters.minQty,
    });
    try {
      await emergencyMarketSell(env, gateway, symbol, net.net_base_qty);
    } catch {
      /* en iyi çaba */
    }
    return false;
  }

  try {
    const tiered = resolveTieredTrailing(
      avgCost,
      cfg.trailingActivationPct,
      cfg.trailingCallbackPct,
      filters.tickSize,
      symInfo.filters,
    );
    const trail = await gateway.placeTrailingStop(symbol, sellQty, tiered);
    await createOpenPosition(env.DB, {
      symbol,
      entry_mode: 'dip_reversal',
      net_base_qty: net.net_base_qty,
      total_usdt_spent: usdtSpent,
      total_base_qty: net.gross_base_qty,
      avg_cost: avgCost,
      trailing_order_id: String(trail.orderId),
      take_profit_price: null,
      scalp_stop_loss_pct: cfg.hardStopPct,
    });
    await logEvent(env.DB, 'TRAILING_PLACED', {
      symbol,
      orderId: trail.orderId,
      sellQty,
      avg_cost: avgCost,
      activationStopPrice: tiered.stopPrice,
      trailingActivationPct: cfg.trailingActivationPct,
      trailingCallbackPct: cfg.trailingCallbackPct,
      trailingDeltaBips: tiered.trailingDeltaBips,
      orderType: 'TAKE_PROFIT',
      entry_mode: 'dip_reversal',
    });
    return true;
  } catch (trailErr) {
    await logEvent(env.DB, 'DIP_REVERSAL_TRAILING_REJECTED', {
      symbol,
      sellQty,
      error: trailErr instanceof Error ? trailErr.message : String(trailErr),
    });
    try {
      await emergencyMarketSell(env, gateway, symbol, net.net_base_qty);
    } catch (sellErr) {
      await logEvent(env.DB, 'DIP_REVERSAL_EMERGENCY_SELL_FAILED', {
        symbol,
        message: sellErr instanceof Error ? sellErr.message : String(sellErr),
      });
    }
    return false;
  }
}

export async function runDipReversalSniper(env: Env, gateway: TradingGateway): Promise<void> {
  const cfg = await getDipReversalConfig(env.DB, env);
  if (!cfg.enabled) return;

  const openCount = await countOpenPositions(env.DB, { entryMode: 'dip_reversal' });
  if (openCount >= cfg.maxConcurrent) return;

  const rows = await scanDipReversalCandidates(env, cfg, { full: false });
  if (rows.length === 0) return;

  // Rejim filtresi (varsayılan boş = kapalı; düşüşü kasıtlı trade ederiz).
  if (cfg.regimeFilter.length > 0) {
    const regime = await fetchRegimeFromDo(env, rows.map((r) => r.symbol));
    if (regime && !cfg.regimeFilter.includes(regime.regime.toLowerCase())) {
      await logEvent(env.DB, 'DIP_REVERSAL_REGIME_SKIP', {
        regime: regime.regime,
        allowed: cfg.regimeFilter,
      });
      return;
    }
  }

  const eligible = rows.filter((r) => r.eligible);
  if (eligible.length === 0) return;

  eligible.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const best = eligible[0]!;

  await logEvent(env.DB, 'DIP_REVERSAL_ENTRY_SIGNAL', {
    chosen: best.symbol,
    score: best.score,
    windowDropPct: best.windowDropPct,
    reversalScore: best.reversalScore,
    candidateCount: eligible.length,
    sample: eligible.slice(0, 5).map((c) => ({ symbol: c.symbol, score: c.score })),
  });

  await executeDipReversalEntry(env, gateway, best, cfg);
}
