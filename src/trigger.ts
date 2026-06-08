import { runScout } from './jobs/scout';
import { runSniper } from './jobs/sniper';
import { runReconcile } from './jobs/reconcile';
import { runTickScalpMaintenance } from './jobs/tick-scalp-sniper';
import { runDustConvert } from './jobs/dust-convert';
import {
  prepareDipReversalAdaptSnapshot,
  runDipReversalSniper,
} from './jobs/dip-reversal-sniper';
import { adaptEntryBlockReason } from './strategy/dip-reversal-adapt';
import { getDipReversalConfig } from './db/dip-reversal';
import { runDipReversalReconcile } from './jobs/dip-reversal-reconcile';
import { runHybridSniper } from './jobs/hybrid-sniper';
import { TradingGateway } from './exchange/gateway';
import { isBinanceRateLimitError } from './exchange/order-errors';
import { fetchBtcIntradayMomentum } from './exchange/market-data-client';
import { selectStrategy, type StrategyChoice } from './strategy/strategy-router';
import { logEvent } from './db/trade-log';
import { getBotState } from './db/bot-state';
import {
  isTickScalpEnabled,
  isStrategyAutoMode,
  getStrategyRouterConfig,
} from './db/bot-config';
import { countOpenPositions } from './db/open-positions';
import type { DipReversalAdaptSnapshot } from './jobs/dip-reversal-context';

export type ManualJob =
  | 'scout'
  | 'sniper'
  | 'reconcile'
  | 'tick'
  | 'dust-convert'
  | 'dip-reversal'
  | 'all';

/**
 * Dip Reversal Sniper — grid ile PARALEL, bağımsız strateji. Sadece dakika cron'unda
 * çalışır (giriş + çıkış). Kendi try/catch'inde; hatası grid'i etkilemez.
 *
 * Cron minimumu 60 sn ama bounce "hazır" penceresi yalnızca saniyeler sürer. Bu yüzden
 * tek invocation içinde ~8 sn aralıkla ~50 sn boyunca tekrar tarar (≈6 geçiş) — fleeting
 * dip+bounce anını yakalama olasılığını katlar. Reconcile her geçişte çalışır (çıkışlar
 * da daha hızlı yönetilir).
 */
const DIP_TICK_BUDGET_MS = 50_000;
const DIP_TICK_GAP_MS = 8_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 15m mum sınırının ilk N saniyesinde miyiz? Binance kline propagation lag koruma penceresi. */
function isNear15mBoundary(windowSec = 30): boolean {
  const secInto15m = Math.floor(Date.now() / 1000) % 900;
  return secInto15m < windowSec;
}

async function runDipReversalCycle(
  env: Env,
  opts?: {
    singlePass?: boolean;
    /** Auto-mode kararı; 'dip_reversal' değilse yeni dip girişi yapılmaz (reconcile sürer). */
    routed?: StrategyChoice | null;
    /** Paylaşılan adapt snapshot (router'da bir kez hesaplandı; tekrar hesaplama). */
    snapshot?: DipReversalAdaptSnapshot | null;
  },
): Promise<void> {
  const gateway = new TradingGateway(env);
  const cfg = await getDipReversalConfig(env.DB, env);
  let adaptSnapshot: Awaited<ReturnType<typeof prepareDipReversalAdaptSnapshot>> =
    opts?.snapshot ?? null;
  let blockNewEntries = false;
  let errorLogged = false;
  let entryBlockLogged = false;

  // Auto-mode: router dip dışı bir strateji seçtiyse yeni dip girişi yapma.
  // Reconcile her geçişte çalışmaya devam eder (açık dip pozisyonları yönetilir).
  if (opts?.routed != null && opts.routed !== 'dip_reversal') {
    blockNewEntries = true;
  }

  const logEntryBlocked = async (reason: string, phase: string): Promise<void> => {
    if (entryBlockLogged) return;
    entryBlockLogged = true;
    await logEvent(env.DB, 'DIP_REVERSAL_ENTRY_BLOCKED', { reason, phase });
  };

  const handleDipError = async (err: unknown, phase: string): Promise<void> => {
    const message = err instanceof Error ? err.message : String(err);
    if (!errorLogged) {
      await logEvent(env.DB, 'DIP_REVERSAL_ERROR', { message, phase });
      errorLogged = true;
    }
    if (isBinanceRateLimitError(err)) {
      blockNewEntries = true;
      await logEntryBlocked('binance_rate_limit', phase);
    }
  };

  // Snapshot paylaşılmadıysa hesapla (auto-mode'da router bir kez hesaplayıp paslar).
  if (opts?.snapshot === undefined) {
    try {
      adaptSnapshot = await prepareDipReversalAdaptSnapshot(env, cfg);
    } catch (err) {
      await handleDipError(err, 'adapt_context');
    }
  }

  if (cfg.adapt.enabled && adaptSnapshot === null) {
    blockNewEntries = true;
    await logEntryBlocked('adapt_context_missing', 'minute_start');
  }

  let boundaryRefreshDone = false;
  const nearBoundaryOnStart = cfg.adapt.enabled && isNear15mBoundary();

  const start = Date.now();
  for (;;) {
    // Sınır dakikasının 1. geçişinde sniper atlanır: 15m mum yeni kapandı,
    // Binance kline verisi henüz kesinleşmemiş olabilir (propagation lag ~5-10s).
    // 8s sleep sonrası snapshot yenilenir, 2. geçişten itibaren normal devam eder.
    const skipSniperThisPass = nearBoundaryOnStart && !boundaryRefreshDone;

    try {
      await runDipReversalReconcile(env, gateway, adaptSnapshot);
    } catch (err) {
      await handleDipError(err, 'reconcile');
    }

    if (!blockNewEntries && !skipSniperThisPass) {
      try {
        await runDipReversalSniper(env, gateway, adaptSnapshot);
      } catch (err) {
        await handleDipError(err, 'sniper');
      }
    }

    if (opts?.singlePass) break;
    if (Date.now() - start + DIP_TICK_GAP_MS > DIP_TICK_BUDGET_MS) break;
    await sleep(DIP_TICK_GAP_MS);

    // İlk sleep sonrası: sınır penceresindeyse snapshot'ı tazele.
    // Bu noktada ~8s geçti, Binance 15m kline verisi artık kesinleşmiştir.
    if (cfg.adapt.enabled && !boundaryRefreshDone && isNear15mBoundary(90)) {
      boundaryRefreshDone = true;
      try {
        const fresh = await prepareDipReversalAdaptSnapshot(env, cfg);
        if (fresh !== null) {
          const prevMode = adaptSnapshot?.mode ?? null;
          adaptSnapshot = fresh;
          const reason = adaptEntryBlockReason(fresh.mode, {
            downtrendMode: cfg.adapt.downtrendMode,
            volatileBlockEnabled: cfg.adapt.volatileBlockEnabled,
            volatileBlockBreadthMax: cfg.adapt.volatileBlockBreadthMax,
            breadthPct: fresh.context.breadthPct,
          });
          if (reason && !blockNewEntries) {
            blockNewEntries = true;
            await logEntryBlocked('adapt_boundary_block', 'boundary_refresh');
            await logEvent(env.DB, 'DIP_REVERSAL_ADAPT_BOUNDARY_BLOCK', {
              reason,
              mode: fresh.mode,
              prevMode,
              breadthPct: fresh.context.breadthPct,
              atrPct: fresh.context.atrPct,
              trend: fresh.context.trend,
            });
          } else if (prevMode !== fresh.mode) {
            await logEvent(env.DB, 'DIP_REVERSAL_ADAPT_BOUNDARY_REFRESH', {
              prevMode,
              mode: fresh.mode,
              breadthPct: fresh.context.breadthPct,
            });
          }
        }
      } catch {
        // non-fatal: stale snapshot ile devam et
      }
    }
  }
}

async function runDipReversalTick(
  env: Env,
  cron: string,
  opts?: { routed?: StrategyChoice | null; snapshot?: DipReversalAdaptSnapshot | null },
): Promise<void> {
  if (cron === '*/15 * * * *') return;
  await runDipReversalCycle(env, opts);
}

/**
 * Cron yönlendirici. 15-dk: watchlist taraması (scout). 1-dk: strateji router
 * (momentum/dip/pause) + dip-reversal cycle.
 */
export async function runScheduled(env: Env, cron: string): Promise<void> {
  if (cron === '*/15 * * * *') {
    await runScout(env);
    return;
  }

  // Auto-mode: rejimi bir kez oku, stratejiyi seç, hem sniper hem dip cycle'a paslama.
  let routed: StrategyChoice | null = null;
  let sharedSnapshot: DipReversalAdaptSnapshot | null | undefined = undefined;
  if (await isStrategyAutoMode(env.DB, env)) {
    const cfg = await getDipReversalConfig(env.DB, env);
    let snap: DipReversalAdaptSnapshot | null = null;
    try {
      snap = await prepareDipReversalAdaptSnapshot(env, cfg);
    } catch {
      snap = null;
    }
    const routerCfg = await getStrategyRouterConfig(env.DB, env);
    const mom = await fetchBtcIntradayMomentum(env);
    const decision = selectStrategy(
      {
        btcM15Pct: mom.m15Pct,
        btcM30Pct: mom.m30Pct,
        btcM60Pct: mom.m60Pct,
        atrPct: snap?.context.atrPct ?? null,
        breadthPct: snap?.context.breadthPct ?? 0,
      },
      {
        momentumBreadthMin: routerCfg.momentumBreadthMin,
        dipBreadthMin: routerCfg.dipBreadthMin,
        volatileAtrMin: routerCfg.volatileAtrMin,
        killAtrMult: routerCfg.killAtrMult,
        momentumAtrMult: routerCfg.momentumAtrMult,
        recoverAtrMult: routerCfg.recoverAtrMult,
      },
    );
    routed = decision.strategy;
    sharedSnapshot = snap;
    await logEvent(env.DB, 'STRATEGY_ROUTER_DECISION', {
      strategy: decision.strategy,
      reason: decision.reason,
      btcM15Pct: mom.m15Pct,
      btcM30Pct: mom.m30Pct,
      btcM60Pct: mom.m60Pct,
      trend: snap?.context.trend ?? null,
      breadthPct: snap?.context.breadthPct ?? null,
      atrPct: snap?.context.atrPct ?? null,
    });
  }

  await runSniperOrReconcile(env, { routed });
  await runDipReversalTick(env, cron, { routed, snapshot: sharedSnapshot });
}

export async function runSniperOrReconcile(
  env: Env,
  opts?: { routed?: StrategyChoice | null },
): Promise<void> {
  // Auto-mode: tick-scalp havuzda yok. Açık pozisyonları yönet + momentum seçiliyse giriş.
  if (opts?.routed != null) {
    const state = await getBotState(env.DB);
    const tickEnabled = await isTickScalpEnabled(env.DB, env);
    const tickOpenCount = tickEnabled
      ? await countOpenPositions(env.DB, { entryMode: 'tick_scalp' })
      : 0;
    // Açık pozisyon varsa (state aktif veya tick pozisyonu) çıkışları yönet.
    if (state.status !== 'IDLE' || tickOpenCount > 0) {
      await runReconcile(env);
    }
    // Yeni giriş yalnızca momentum seçildiyse ve bot boştaysa.
    // forceMomentum: pullback fallback'ine düşmeden gerçek hybrid momentum çalışır.
    if (opts.routed === 'momentum' && state.status === 'IDLE') {
      await runHybridSniper(env, { forceMomentum: true });
    }
    return;
  }

  const state = await getBotState(env.DB);
  const tickEnabled = await isTickScalpEnabled(env.DB, env);
  const tickOpenCount = tickEnabled
    ? await countOpenPositions(env.DB, { entryMode: 'tick_scalp' })
    : 0;

  if (tickEnabled && tickOpenCount > 0) {
    await runReconcile(env);
    await runTickScalpMaintenance(env);
    return;
  }

  if (state.status === 'IDLE') {
    if (tickEnabled) {
      await runTickScalpMaintenance(env);
      return;
    }
    await runSniper(env);
    return;
  }
  if (
    state.status === 'TIER_1_BULL' ||
    state.status === 'MANUAL_INTERVENTION' ||
    state.status === 'ERROR'
  ) {
    await runReconcile(env);
    if (tickEnabled) {
      await runTickScalpMaintenance(env);
    }
  }
}

/** Manuel tick koşusu: sadece tick sniper/reconcile akışı. */
export async function runManualTick(env: Env): Promise<void> {
  await runSniperOrReconcile(env);
}

export async function runManualJob(env: Env, job: ManualJob): Promise<void> {
  switch (job) {
    case 'scout':
      await runScout(env);
      break;
    case 'sniper':
      await runSniper(env);
      break;
    case 'reconcile':
      await runReconcile(env);
      break;
    case 'tick':
      await runManualTick(env);
      break;
    case 'dust-convert':
      await runDustConvert(env);
      break;
    case 'dip-reversal':
      await runDipReversalCycle(env, { singlePass: true });
      break;
    case 'all':
      await runScout(env);
      await runSniperOrReconcile(env);
      break;
  }
}

export function parseManualJob(value: string | null): ManualJob | null {
  const jobs: ManualJob[] = [
    'scout',
    'sniper',
    'reconcile',
    'tick',
    'dust-convert',
    'dip-reversal',
    'all',
  ];
  return jobs.includes(value as ManualJob) ? (value as ManualJob) : null;
}

export function isTriggerAuthorized(request: Request, env: Env): boolean {
  const secret = env.TRIGGER_SECRET;
  if (!secret) return false;
  const header = request.headers.get('X-Trigger-Secret');
  const query = new URL(request.url).searchParams.get('secret');
  return header === secret || query === secret;
}
