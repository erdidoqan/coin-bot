import { runScout } from './jobs/scout';
import { runReconcile } from './jobs/reconcile';
import { runDustConvert } from './jobs/dust-convert';
import {
  prepareDipReversalAdaptSnapshot,
  runDipReversalSniper,
} from './jobs/dip-reversal-sniper';
import { adaptEntryBlockReason } from './strategy/dip-reversal-adapt';
import { getDipReversalConfig } from './db/dip-reversal';
import { runDipReversalReconcile } from './jobs/dip-reversal-reconcile';
import { runHybridSniper } from './jobs/hybrid-sniper';
import { runBtcLeaderSniper } from './jobs/btc-leader-sniper';
import { TradingGateway } from './exchange/gateway';
import { isBinanceRateLimitError } from './exchange/order-errors';
import { fetchBtcIntradayMomentum } from './exchange/market-data-client';
import { selectStrategy, type StrategyChoice } from './strategy/strategy-router';
import { logEvent } from './db/trade-log';
import { getBotState } from './db/bot-state';
import { isAutoStrategyEnabled, getStrategyRouterConfig } from './db/bot-config';
import type { DipReversalAdaptSnapshot } from './jobs/dip-reversal-context';

export type ManualJob =
  | 'scout'
  | 'sniper'
  | 'reconcile'
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
/** BTC 30dk momentum bu eşiğin altındaysa (sert düşüş) yeni dip girişi durdurulur —
 *  hard-stop kümeleri BTC çöküş anlarında oluşuyordu (zarar analizi 2026-06-10). */
const BTC_SELLOFF_FLOOR = -0.5;
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
    /** BTC 30dk momentum — sert düşüşte (selloff) yeni giriş durdurulur. */
    btcM30Pct?: number | null;
  },
): Promise<void> {
  const gateway = new TradingGateway(env);
  const cfg = await getDipReversalConfig(env.DB, env);
  let adaptSnapshot: Awaited<ReturnType<typeof prepareDipReversalAdaptSnapshot>> =
    opts?.snapshot ?? null;
  let blockNewEntries = false;
  let errorLogged = false;
  let entryBlockLogged = false;

  // Multi-TF dönüş girişi HER rejimde çalışır (momentum dahil). Risk-off/downtrend
  // koruması adapt guard'ında. Reconcile her geçişte çalışır.
  // BTC SERT DÜŞÜŞ guard: zarar analizi gösterdi ki hard-stop'lar BTC çöküş anlarında
  // KÜME halinde geliyor (tüm dipler birlikte batıyor). BTC m30 < -0.5 ise yeni giriş yok.
  if (opts?.btcM30Pct != null && opts.btcM30Pct < BTC_SELLOFF_FLOOR) {
    blockNewEntries = true;
  }

  const logEntryBlocked = async (reason: string, phase: string): Promise<void> => {
    if (entryBlockLogged) return;
    entryBlockLogged = true;
    await logEvent(env.DB, 'DIP_REVERSAL_ENTRY_BLOCKED', { reason, phase });
  };

  // ROUTER REJİM KAPISI: 'pause' (zayıf breadth / intraday selloff / belirsiz) → yeni
  // giriş YOK. Zarar analizi (2026-06-11): giriş sinyali her çözünürlükte kazananı
  // kaybedenden ayırmıyor; tek tutarlı sinyal REJİM. Dip, router 408× 'pause' derken
  // girmeye devam edip +5 sabah kazancını akşam zayıf tape'te -10'a çevirdi. Dip sadece
  // 'momentum' (uptrend) ve 'dip_reversal' (dip_recovery) rejimlerinde girer. Reconcile
  // (açık poz yönetimi) HER zaman sürer — sadece yeni giriş durur.
  if (opts?.routed === 'pause') {
    blockNewEntries = true;
    await logEntryBlocked('router_pause', 'minute_start');
  }

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
  opts?: {
    routed?: StrategyChoice | null;
    snapshot?: DipReversalAdaptSnapshot | null;
    btcM30Pct?: number | null;
  },
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

  // Auto Strateji: router HER ZAMAN piyasayı okur, stratejiyi seçer (momentum/dip/pause).
  // auto_strategy_enabled=false ise bot tamamen durur (acil kapatma).
  if (!(await isAutoStrategyEnabled(env.DB, env))) return;

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
  const routed = decision.strategy;
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

  await runSniperOrReconcile(env, { routed, btcM30Pct: mom.m30Pct });
  // BTC-Lider order-flow giriş (öncelikli yeni paradigma — küçük poz). BTC RECOVERING
  // (satış emildi + dönüş) anında en güçlü order-flow coine girer. Girerse dip fallback
  // atlanır; girmezse mevcut multi-TF dip devreye girer (geçiş dönemi fallback'i).
  const btcLed = await runBtcLeaderSniper(env);
  if (!btcLed) {
    await runDipReversalTick(env, cron, { routed, snapshot: snap, btcM30Pct: mom.m30Pct });
  }
}


export async function runSniperOrReconcile(
  env: Env,
  _opts?: { routed?: StrategyChoice | null; btcM30Pct?: number | null },
): Promise<void> {
  const state = await getBotState(env.DB);
  // Otomatik YENİ giriş yalnızca multi-TF dip (runDipReversalTick) yolundan yapılır.
  // Momentum/solo otomatik girişi KALDIRILDI — risk-off'ta guard'sız girip zarar
  // veriyordu (PEPE micro_scalp -0.40, breadth 0'da). Burada sadece açık pozisyon
  // yönetimi (reconcile) kalır.
  if (state.status !== 'IDLE') {
    await runReconcile(env);
  }
}

export async function runManualJob(env: Env, job: ManualJob): Promise<void> {
  switch (job) {
    case 'scout':
      await runScout(env);
      break;
    case 'sniper':
      await runHybridSniper(env, { forceMomentum: true });
      break;
    case 'reconcile':
      await runReconcile(env);
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
