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
import { adaptEntryBlockReason } from '../strategy/dip-reversal-adapt';
import { resolveDipBuyQuoteFromConfig } from '../strategy/dip-reversal-quote';
import type { DipReversalAdaptSnapshot } from './dip-reversal-context';
import { getDipReversalAdaptContext } from './dip-reversal-context';
import {
  dipReversalOpenSymbols,
  gridHeldSymbols,
  scanDipReversalCandidates,
  type DipReversalScanRow,
} from './dip-reversal-scan';
import { isSystemTradeBlockedSymbol } from '../config/system-trade-rules';
import { emergencyMarketSell } from './emergency-exit';

async function executeDipReversalEntry(
  env: Env,
  gateway: TradingGateway,
  candidate: DipReversalScanRow,
  cfg: DipReversalConfig,
  quoteUsdt: string,
): Promise<boolean> {
  const { symbol } = candidate;
  const info = await gateway.binance.getExchangeInfo(symbol);
  const symInfo = info.symbols[0];
  if (!symInfo) return false;

  const filters = parseSymbolFilters(symInfo);
  if (!meetsMinNotional(quoteUsdt, filters.minNotional)) {
    await logEvent(env.DB, 'DIP_REVERSAL_MIN_NOTIONAL_SKIP', {
      symbol,
      quoteUsdt,
      minNotional: filters.minNotional,
    });
    return false;
  }

  const buyOrder = await gateway.marketBuy(symbol, quoteUsdt);
  const net = netQtyFromBuy(buyOrder, symbol);
  const usdtSpent = buyOrder.cummulativeQuoteQty ?? quoteUsdt;
  const avgCost = computeAvgCost(usdtSpent, net.net_base_qty);

  await logEvent(env.DB, 'BUY_FILLED', {
    symbol,
    order: buyOrder,
    entry_mode: 'dip_reversal',
    quoteUsdt,
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

export async function runDipReversalSniper(
  env: Env,
  gateway: TradingGateway,
  adaptSnapshot?: DipReversalAdaptSnapshot | null,
): Promise<void> {
  const cfg = await getDipReversalConfig(env.DB, env);
  if (!cfg.enabled) return;

  const openCount = await countOpenPositions(env.DB, { entryMode: 'dip_reversal' });
  if (openCount >= cfg.maxConcurrent) return;

  let snapshot = adaptSnapshot;
  if (cfg.adapt.enabled && snapshot === undefined) {
    snapshot = await getDipReversalAdaptContext(env, cfg.adapt.thresholds);
  }

  if (cfg.adapt.enabled && !snapshot) {
    await logEvent(env.DB, 'DIP_REVERSAL_ENTRY_BLOCKED', {
      reason: 'adapt_context_missing',
      detail: 'Rejim adaptasyonu açık ama BTC 15m / breadth bağlamı alınamadı; taban eşikle giriş yapılmaz.',
    });
    return;
  }

  const adaptBlockOpts = {
    downtrendMode: cfg.adapt.downtrendMode,
    volatileBlockEnabled: cfg.adapt.volatileBlockEnabled,
    volatileBlockBreadthMax: cfg.adapt.volatileBlockBreadthMax,
    breadthPct: snapshot?.context.breadthPct,
  };
  const adaptBlockReason =
    cfg.adapt.enabled && snapshot
      ? adaptEntryBlockReason(snapshot.mode, adaptBlockOpts)
      : null;
  if (adaptBlockReason) {
    await logEvent(env.DB, 'DIP_REVERSAL_ADAPT_SKIP', {
      reason: adaptBlockReason,
      mode: snapshot.mode,
      downtrendMode: cfg.adapt.downtrendMode,
      volatileBlockEnabled: cfg.adapt.volatileBlockEnabled,
      volatileBlockBreadthMax: cfg.adapt.volatileBlockBreadthMax,
      breadthPct: snapshot.context.breadthPct,
      atrPct: snapshot.context.atrPct,
      trend: snapshot.context.trend,
    });
    return;
  }

  const { rows } = await scanDipReversalCandidates(env, cfg, {
    panelMode: 'live',
    adaptSnapshot: snapshot ?? null,
  });
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

  const quoteUsdt = resolveDipBuyQuoteFromConfig(
    cfg.buyQuoteUsdt,
    cfg.adapt,
    snapshot?.mode,
  );

  await logEvent(env.DB, 'DIP_REVERSAL_ENTRY_SIGNAL', {
    chosen: best.symbol,
    score: best.score,
    windowDropPct: best.windowDropPct,
    reversalScore: best.reversalScore,
    candidateCount: eligible.length,
    sample: eligible.slice(0, 5).map((c) => ({ symbol: c.symbol, score: c.score })),
    adaptMode: snapshot?.mode ?? null,
    quoteUsdt,
  });

  await executeDipReversalEntry(env, gateway, best, cfg, quoteUsdt);
}

/** Dakika-içi loop: adapt context bir kez hesaplanır, tüm geçişlerde paylaşılır. */
export async function prepareDipReversalAdaptSnapshot(
  env: Env,
  cfg: DipReversalConfig,
): Promise<DipReversalAdaptSnapshot | null> {
  if (!cfg.adapt.enabled) return null;
  return getDipReversalAdaptContext(env, cfg.adapt.thresholds);
}

export type ManualDipBuyError =
  | 'trading_disabled'
  | 'dip_reversal_disabled'
  | 'max_concurrent'
  | 'already_open'
  | 'grid_held'
  | 'symbol_not_found'
  | 'no_mid'
  | 'system_blocked'
  | 'entry_failed';

export type ManualDipBuyResult =
  | { ok: true; symbol: string }
  | { ok: false; error: ManualDipBuyError; message?: string };

/** Panel: sabitlenmiş sembol — sniper ile aynı market alım + trailing (adapt/rejim atlanır). */
export async function manualDipReversalBuy(env: Env, symbolRaw: string): Promise<ManualDipBuyResult> {
  const symbol = symbolRaw.trim().toUpperCase();
  if (!symbol.endsWith('USDT')) {
    return { ok: false, error: 'symbol_not_found', message: 'Sembol USDT çifti olmalı' };
  }
  if (isSystemTradeBlockedSymbol(symbol)) {
    return { ok: false, error: 'system_blocked' };
  }

  const cfg = await getDipReversalConfig(env.DB, env);
  if (!cfg.enabled) return { ok: false, error: 'dip_reversal_disabled' };
  if (String(env.TRADING_ENABLED) !== 'true') {
    return { ok: false, error: 'trading_disabled' };
  }

  const [openCount, openSymbols, gridSymbols] = await Promise.all([
    countOpenPositions(env.DB, { entryMode: 'dip_reversal' }),
    dipReversalOpenSymbols(env.DB),
    gridHeldSymbols(env.DB),
  ]);
  if (openCount >= cfg.maxConcurrent) {
    return { ok: false, error: 'max_concurrent' };
  }
  if (openSymbols.has(symbol)) {
    return { ok: false, error: 'already_open' };
  }
  if (gridSymbols.has(symbol)) {
    return { ok: false, error: 'grid_held' };
  }

  const { rows } = await scanDipReversalCandidates(env, cfg, { panelMode: 'live' });
  const candidate = rows.find((r) => r.symbol === symbol);
  if (!candidate) {
    return { ok: false, error: 'symbol_not_found', message: 'Sembol watchlist taramasında yok' };
  }
  if (candidate.excluded === 'no_mid' || !candidate.mid) {
    return { ok: false, error: 'no_mid' };
  }

  const quoteUsdt = resolveDipBuyQuoteFromConfig(cfg.buyQuoteUsdt, cfg.adapt, null, true);

  await logEvent(env.DB, 'DIP_REVERSAL_MANUAL_BUY', {
    symbol,
    mid: candidate.mid,
    windowDropPct: candidate.windowDropPct,
    reversalScore: candidate.reversalScore,
    quoteUsdt,
    manual: true,
  });

  const gateway = new TradingGateway(env);
  const success = await executeDipReversalEntry(env, gateway, candidate, cfg, quoteUsdt);
  if (!success) {
    return { ok: false, error: 'entry_failed', message: 'Emir veya trailing reddedildi — loglara bakın' };
  }
  return { ok: true, symbol };
}
