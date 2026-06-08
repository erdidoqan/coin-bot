import { getBotState, resetToIdle } from '../db/bot-state';
import {
  clearAllOpenPositions,
  listOpenPositions,
  type OpenPosition,
} from '../db/open-positions';
import {
  listAllConfig,
  setConfigs,
  getConfig,
  getTickScalpConfig,
  type BotConfigKey,
} from '../db/bot-config';
import { effectiveRecoveryMinPct } from '../indicators/tick-reversal';
import { tickReversalConfigFromScalp } from '../jobs/tick-config-sync';
import { listWatchlist } from '../db/watchlist';
import { getPnlSummaryBundle } from '../db/pnl-summary';
import { getRegimeCache } from '../db/trade-features';
import { isMicroScalpEnabled, isTickScalpEnabled } from '../db/bot-config';
import { listTradeLogs, countTradeLogs } from '../db/trade-log';
import { BinanceClient, BinanceApiError } from '../exchange/binance';
import { usesBinanceProxy } from '../exchange/binance-fetch';
import { isTriggerAuthorized, parseManualJob, runManualJob } from '../trigger';
import { runForceClose } from '../jobs/force-close';
import { enrichWatchlistLive, formatWatchlistForAdmin } from './watchlist-enrich';
import { fetchMarketDataStatus } from '../exchange/market-data-client';
import {
  buildDipReversalLive,
  buildDipReversalPositionsLive,
  buildDipReversalReport,
} from './dip-reversal-status';
import { manualDipReversalBuy } from '../jobs/dip-reversal-sniper';
import { buildTickLiveReport } from './tick-live';
import { getShadowSummary } from '../db/micro-shadow';
import { buildBinanceRangePnl } from './binance-pnl';
import {
  fetchFloatingPnlForOpenPositionsLight,
  fetchFloatingPnlForStateLight,
} from './floating-pnl';
import { fetchRotationStatus } from './rotation-status';
import { jsonResponse, optionsResponse } from './cors';

const CONFIG_KEYS: BotConfigKey[] = [
  'live_gate',
  // --- Dip Reversal Sniper (bağımsız strateji) ---
  'dip_reversal_enabled',
  'dip_reversal_buy_quote_usdt',
  'dip_reversal_max_concurrent',
  'dip_reversal_min_capitulation_drop_pct',
  'dip_reversal_flash_window_min',
  'dip_reversal_min_ws_decline_pct',
  'dip_reversal_min_recovery_from_low_pct',
  'dip_reversal_min_reversal_score',
  'dip_reversal_max_sec_since_trough',
  'dip_reversal_require_mid_slope',
  'dip_reversal_trailing_activation_pct',
  'dip_reversal_trailing_callback_pct',
  'dip_reversal_hard_stop_pct',
  'dip_reversal_max_hold_min',
  'dip_reversal_post_exit_cooldown_min',
  'dip_reversal_regime_filter',
  'dip_reversal_adapt_enabled',
  'dip_reversal_adapt_downtrend_mode',
  'dip_reversal_adapt_ema_min_sep_pct',
  'dip_reversal_adapt_calm_atr_max',
  'dip_reversal_adapt_volatile_atr_min',
  'dip_reversal_adapt_downtrend_breadth_max',
  'dip_reversal_adapt_calm_drop_mult',
  'dip_reversal_adapt_dtvol_drop_mult',
  'dip_reversal_adapt_dtvol_reversal_mult',
  'dip_reversal_adapt_dtvol_recovery_mult',
  'dip_reversal_adapt_dtgrind_drop_mult',
  'dip_reversal_adapt_dtgrind_reversal_mult',
  'dip_reversal_adapt_dtgrind_recovery_mult',
  'dip_reversal_adapt_volatile_block_enabled',
  'dip_reversal_adapt_volatile_block_breadth_max',
];

function isConfigKey(key: string): key is BotConfigKey {
  return (CONFIG_KEYS as string[]).includes(key);
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

interface AdminOpenPositionRow {
  id: number;
  symbol: string;
  entry_mode: string;
  net_base_qty: string;
  total_usdt_spent: string;
  avg_cost: string;
  take_profit_price: string | null;
  scalp_stop_loss_pct: string | null;
  position_opened_at: string;
  updated_at: string;
  floating_pnl_pct: string | null;
  floating_pnl_usdt: string | null;
  market_value_usdt: string | null;
  last_price: string | null;
}

async function buildOpenPositionRows(
  env: Env,
  openPositions: OpenPosition[],
): Promise<AdminOpenPositionRow[]> {
  const pnlMap = await fetchFloatingPnlForOpenPositionsLight(
    env,
    openPositions.map((p) => ({
      id: p.id,
      symbol: p.symbol,
      net_base_qty: p.net_base_qty,
      total_usdt_spent: p.total_usdt_spent,
    })),
  );
  return openPositions.map((p) => {
    const pnl = pnlMap.get(p.id);
    return {
      id: p.id,
      symbol: p.symbol,
      entry_mode: p.entry_mode,
      net_base_qty: p.net_base_qty,
      total_usdt_spent: p.total_usdt_spent,
      avg_cost: p.avg_cost,
      take_profit_price: p.take_profit_price,
      scalp_stop_loss_pct: p.scalp_stop_loss_pct,
      position_opened_at: p.position_opened_at,
      updated_at: p.updated_at,
      floating_pnl_pct: pnl?.pnlPct ?? null,
      floating_pnl_usdt: pnl?.pnlUsdt ?? null,
      market_value_usdt: pnl?.marketValueUsdt ?? null,
      last_price: pnl?.lastPrice ?? null,
    };
  });
}

export async function handleAdminApi(request: Request, env: Env): Promise<Response> {
  if (request.method === 'OPTIONS') return optionsResponse(request);

  if (!isTriggerAuthorized(request, env)) {
    return jsonResponse(request, { error: 'Unauthorized' }, 401);
  }

  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/admin\/api/, '') || '/';

  try {
    if (path === '/binance-test' && request.method === 'GET') {
      const client = new BinanceClient(env);
      const baseUrl = env.BINANCE_BASE_URL;
      const hasKeys = Boolean(env.BINANCE_API_KEY && env.BINANCE_API_SECRET);

      let publicOk = false;
      let publicError: string | null = null;
      try {
        const tickers = await client.getTicker24hr();
        publicOk = tickers.some((t) => t.symbol === 'BTCUSDT');
      } catch (err) {
        publicError = err instanceof Error ? err.message : String(err);
      }

      let signedOk = false;
      let signedError: string | null = null;
      let usdtFree: string | null = null;
      let apiCode: number | undefined;
      if (hasKeys) {
        try {
          const balances = await client.getAccountBalances();
          const usdt = balances.find((b) => b.asset === 'USDT');
          usdtFree = usdt?.free ?? '0';
          signedOk = true;
        } catch (err) {
          if (err instanceof BinanceApiError) {
            signedError = err.message;
            apiCode = err.code;
          } else {
            signedError = err instanceof Error ? err.message : String(err);
          }
        }
      } else {
        signedError = 'BINANCE_API_KEY veya BINANCE_API_SECRET tanımlı değil';
      }

      return jsonResponse(request, {
        at: new Date().toISOString(),
        baseUrl,
        binanceProxy: usesBinanceProxy(env) ? env.BINANCE_PROXY_URL : null,
        tradingEnabled: env.TRADING_ENABLED ?? 'false',
        hasApiKeys: hasKeys,
        public: { ok: publicOk, error: publicError },
        signed: { ok: signedOk, error: signedError, code: apiCode, usdtFree },
        hint:
          signedError?.includes('IP') || apiCode === -2015
            ? 'IP whitelist Worker çıkış IP’si ile uyuşmuyor olabilir'
            : null,
      });
    }

    if (path === '/market-data' && request.method === 'GET') {
      const status = await fetchMarketDataStatus(env);
      return jsonResponse(request, {
        available: Boolean(env.MARKET_DATA),
        status,
      });
    }

    if (path === '/dip-reversal/live' && request.method === 'GET') {
      const report = await buildDipReversalLive(env);
      return jsonResponse(request, report);
    }

    if (path === '/dip-reversal/positions-live' && request.method === 'GET') {
      const report = await buildDipReversalPositionsLive(env);
      return jsonResponse(request, report);
    }

    if (path === '/dip-reversal' && request.method === 'GET') {
      const report = await buildDipReversalReport(env);
      return jsonResponse(request, report);
    }

    if (path === '/dip-reversal/manual-buy' && request.method === 'POST') {
      const body = (await request.json()) as { symbol?: string };
      const symbol = body.symbol?.trim();
      if (!symbol) {
        return jsonResponse(request, { ok: false, error: 'symbol_required' }, 400);
      }
      const result = await manualDipReversalBuy(env, symbol);
      return jsonResponse(request, result, result.ok ? 200 : 400);
    }

    if (path === '/tick-live' && request.method === 'GET') {
      const symbol = url.searchParams.get('symbol')?.toUpperCase();
      if (!symbol?.endsWith('USDT')) {
        return jsonResponse(
          request,
          { error: 'symbol required', example: '/admin/api/tick-live?symbol=ZECUSDT' },
          400,
        );
      }
      const report = await buildTickLiveReport(env, symbol);
      return jsonResponse(request, report);
    }

    if (path === '/shadow-summary' && request.method === 'GET') {
      const days = Math.min(30, Math.max(1, Number(url.searchParams.get('days') ?? '7')));
      const summary = await getShadowSummary(env.DB, days);
      return jsonResponse(request, summary);
    }

    if (path === '/pnl/binance-range' && request.method === 'GET') {
      const startMs = Number(url.searchParams.get('startMs'));
      const endMs = Number(url.searchParams.get('endMs'));
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
        return jsonResponse(
          request,
          { error: 'startMs ve endMs gerekli', example: '/admin/api/pnl/binance-range?startMs=...&endMs=...' },
          400,
        );
      }

      const report = await buildBinanceRangePnl(env, {
        startMs,
        endMs,
        timezone: url.searchParams.get('timezone'),
        bucket: url.searchParams.get('bucket'),
      });
      return jsonResponse(request, report);
    }

    if (path === '/dashboard' && request.method === 'GET') {
      const [state, watchlistRaw, logs, config, pnl, openPositions] = await Promise.all([
        getBotState(env.DB),
        listWatchlist(env.DB),
        listTradeLogs(env.DB, {
          limit: 12,
          offset: 0,
          excludeEventTypes: ['SCOUT_RUN', 'SNIPER_SKIP', 'MICRO_SCORE_SCAN'],
        }),
        listAllConfig(env.DB),
        getPnlSummaryBundle(env.DB),
        listOpenPositions(env.DB),
      ]);
      const [microEnabled, tickEnabled] = await Promise.all([
        isMicroScalpEnabled(env.DB, env),
        isTickScalpEnabled(env.DB, env),
      ]);
      const tickMeta = tickEnabled
        ? await Promise.all([getTickScalpConfig(env.DB, env), fetchMarketDataStatus(env)])
        : null;
      const tickCfg = tickMeta?.[0] ?? null;
      const doStatus = tickMeta?.[1] ?? null;
      const [watchlistEnriched, floatingPnl, microScanCursor, openPositionRows] = await Promise.all([
        enrichWatchlistLive(
          env,
          watchlistRaw,
          state,
          openPositions.map((p) => p.symbol),
        ),
        fetchFloatingPnlForStateLight(env, state),
        microEnabled ? getConfig(env.DB, 'micro_scan_cursor', env) : Promise.resolve('0'),
        buildOpenPositionRows(env, openPositions),
      ]);
      const watchlist = formatWatchlistForAdmin(watchlistEnriched);
      const rotationStatus = await fetchRotationStatus(env, state, floatingPnl);
      const regimeCache = microEnabled ? await getRegimeCache(env.DB) : null;
      const tickOpenCount = openPositions.filter((p) => p.entry_mode === 'tick_scalp').length;
      let regimeDetail: Record<string, unknown> = {};
      if (regimeCache?.detail) {
        try {
          regimeDetail = JSON.parse(regimeCache.detail) as Record<string, unknown>;
        } catch {
          regimeDetail = {};
        }
      }
      return jsonResponse(request, {
        botState: state,
        openPositionCount: openPositions.length,
        openPositions: openPositionRows,
        tickOpenSlots: tickCfg
          ? {
              open: tickOpenCount,
              max: tickCfg.maxOpenPositions,
            }
          : null,
        floatingPnl,
        rotationStatus,
        microScalpEnabled: microEnabled,
        tickScalpEnabled: tickEnabled,
        tickEntryThresholds: tickCfg
          ? {
              gainMinPct: tickCfg.entryGainPct,
              gainMaxPct: tickCfg.entryGainMaxPct,
              recoveryMinPct: tickCfg.recoveryMinPct,
              recoveryEffectiveMinPct: effectiveRecoveryMinPct(
                tickReversalConfigFromScalp(tickCfg),
              ),
              orderbookRatioMin: tickCfg.orderbookRatioMin,
              takeProfitPct: tickCfg.takeProfitPct,
              doSymbolCount: doStatus?.symbolCount ?? null,
              wsStale:
                doStatus?.lastMessageAt != null
                  ? Date.now() - doStatus.lastMessageAt > 60_000
                  : true,
            }
          : null,
        watchlistDbCount: watchlistRaw.length,
        microScanCursor: microEnabled ? Number(microScanCursor) || 0 : null,
        marketRegime: regimeCache?.regime ?? 'trend',
        marketRegimeDetail: regimeDetail,
        watchlist,
        watchlistUpdatedAt: new Date().toISOString(),
        pnl: pnl.today,
        pnlAllTime: pnl.allTime,
        pnlTodayLabel: pnl.todayLabel,
        recentLogs: logs.map((l) => ({
          ...l,
          payload: safeParseJson(l.payload),
        })),
        config,
        tradingEnabled: env.TRADING_ENABLED ?? 'false',
        binanceBaseUrl: env.BINANCE_BASE_URL,
        crons: [
          '*/15 * * * * (scout)',
          '* * * * * (tick: shadow+reconcile; giriş WS DO sniper)',
        ],
      });
    }

    if (path === '/open-positions' && request.method === 'GET') {
      const [openPositions, tickEnabled] = await Promise.all([
        listOpenPositions(env.DB),
        isTickScalpEnabled(env.DB, env),
      ]);
      const [rows, tickCfg] = await Promise.all([
        buildOpenPositionRows(env, openPositions),
        tickEnabled ? getTickScalpConfig(env.DB, env) : Promise.resolve(null),
      ]);
      const tickOpenCount = openPositions.filter((p) => p.entry_mode === 'tick_scalp').length;
      return jsonResponse(request, {
        openPositionCount: rows.length,
        openPositions: rows,
        tickOpenSlots: tickCfg
          ? {
              open: tickOpenCount,
              max: tickCfg.maxOpenPositions,
            }
          : null,
        updatedAt: new Date().toISOString(),
      });
    }

    if (path === '/logs' && request.method === 'GET') {
      const limit = Math.min(Number(url.searchParams.get('limit') ?? '50'), 200);
      const offset = Number(url.searchParams.get('offset') ?? '0');
      const eventType = url.searchParams.get('event') ?? undefined;
      const excludeRaw = url.searchParams.get('exclude') ?? '';
      const excludeEventTypes = excludeRaw
        ? excludeRaw.split(',').map((s) => s.trim()).filter(Boolean)
        : undefined;
      const [rows, total] = await Promise.all([
        listTradeLogs(env.DB, { limit, offset, eventType, excludeEventTypes }),
        countTradeLogs(env.DB, eventType, excludeEventTypes),
      ]);
      return jsonResponse(request, {
        logs: rows.map((l) => ({ ...l, payload: safeParseJson(l.payload) })),
        total,
        limit,
        offset,
      });
    }

    if (path === '/config' && request.method === 'GET') {
      return jsonResponse(request, { config: await listAllConfig(env.DB) });
    }

    if (path === '/config' && request.method === 'PUT') {
      const body = (await request.json()) as { updates?: Record<string, string> };
      const updates = body.updates ?? {};
      const filtered: Record<string, string> = {};
      for (const [k, v] of Object.entries(updates)) {
        if (isConfigKey(k) && typeof v === 'string') filtered[k] = v;
      }
      if (Object.keys(filtered).length === 0) {
        return jsonResponse(request, { error: 'No valid config keys' }, 400);
      }
      await setConfigs(env.DB, filtered);
      return jsonResponse(request, { ok: true, updated: filtered });
    }

    if (path === '/actions/trigger' && request.method === 'POST') {
      const body = (await request.json()) as { job?: string };
      const job = parseManualJob(body.job ?? null);
      if (!job) {
        return jsonResponse(request, { error: 'Invalid job' }, 400);
      }
      await runManualJob(env, job);
      return jsonResponse(request, { ok: true, job, at: new Date().toISOString() });
    }

    if (path === '/actions/reset-state' && request.method === 'POST') {
      await clearAllOpenPositions(env.DB);
      await resetToIdle(env.DB);
      return jsonResponse(request, { ok: true, status: 'IDLE', openPositionsCleared: true });
    }

    if (path === '/actions/force-close' && request.method === 'POST') {
      const result = await runForceClose(env);
      return jsonResponse(request, result, result.ok ? 200 : 500);
    }

    return jsonResponse(request, { error: 'Not found' }, 404);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResponse(request, { error: message }, 500);
  }
}

export function adminApiPreflight(request: Request): Response | null {
  if (request.method === 'OPTIONS' && request.url.includes('/admin/api')) {
    return optionsResponse(request);
  }
  return null;
}
