/**
 * Dip Reversal Sniper — admin panel raporu.
 *
 * Sniper ile AYNI taramayı (`scanDipReversalCandidates`) kullanır; her aday için
 * canlı capitulation/bounce metrikleri + kapı durumları + "HAZIR" işareti döndürür.
 * Ayrıca açık dip_reversal pozisyonları (yüzen PnL) ve son alım/çıkış aktivitesini verir.
 */
import { getDipReversalConfig } from '../db/dip-reversal';
import { countOpenPositions, listOpenPositions } from '../db/open-positions';
import { listTradeLogs } from '../db/trade-log';
import {
  getDipReversalAdaptContext,
  type DipReversalAdaptSnapshot,
} from '../jobs/dip-reversal-context';
import { fetchTickRank } from '../exchange/market-data-client';
import { getTickScalpConfig } from '../db/bot-config';
import {
  dipReversalOpenSymbols,
  scanDipReversalCandidates,
  thresholdsFromConfig,
  type DipReversalScanAdaptMeta,
  type DipReversalScanRow,
} from '../jobs/dip-reversal-scan';
import type { TickScanRow } from '../durable-objects/market-data-do';
import {
  adaptEntryBlockReason,
  resolveAdaptiveThresholds,
  type DipReversalMode,
} from '../strategy/dip-reversal-adapt';
import { resolveDipBuyQuoteFromConfig } from '../strategy/dip-reversal-quote';
import { fetchFloatingPnlForOpenPositionsLight } from './floating-pnl';

export interface DipReversalGateView {
  id: string;
  pass: boolean;
  actual: number | null;
  threshold: string;
}

export interface DipReversalCandidateView {
  symbol: string;
  mid: string | null;
  windowDropPct: number | null;
  change1mPct: number | null;
  change3mPct: number | null;
  change10mPct: number | null;
  change30mPct: number | null;
  flashDrop3mPct: number | null;
  wsDeclinePct: number | null;
  recoveryFromWsLowPct: number | null;
  reversalScore: number;
  secSinceTrough: number | null;
  midSlopeOk: boolean;
  gates: DipReversalGateView[];
  gatesPassed: number;
  gatesTotal: number;
  excluded: string | null;
  ready: boolean;
  score: number | null;
  primaryBlocker: string | null;
  /** Açık dip_reversal pozisyonu — aday listesinde üstte sabitlenir. */
  pinned: boolean;
}

export interface DipReversalPositionView {
  id: number;
  symbol: string;
  avgCost: string;
  netBaseQty: string;
  spentUsdt: string;
  hardStopPct: string | null;
  trailingOrderId: string | null;
  openedAt: string;
  lastPrice: string | null;
  pnlPct: string | null;
  pnlUsdt: string | null;
  marketValueUsdt: string | null;
}

export interface DipReversalActivityView {
  eventType: string;
  symbol: string | null;
  createdAt: string;
  detail: Record<string, unknown>;
}

export interface DipReversalClosedTrade {
  symbol: string;
  pnlUsdt: number;
  pnlPct: number | null;
  proceeds: number | null;
  spent: number | null;
  source: string | null;
  closedAt: string;
}

export interface DipReversalPnlSummary {
  totalPnlUsdt: number;
  tradeCount: number;
  wins: number;
  losses: number;
}

export interface DipReversalTotals {
  realizedPnlToday: string;
  tradesToday: number;
}

export interface DipReversalAdaptView {
  enabled: boolean;
  mode: DipReversalMode | null;
  trend: string | null;
  emaSepPct: number | null;
  atrPct: number | null;
  breadthPct: number | null;
  riskOff: boolean | null;
  effectiveMinCapitulationDropPct: number | null;
  effectiveMinReversalScore: number | null;
  effectiveMinRecoveryFromLowPct: number | null;
  /** Sniper otomatik giriş tutarı (adapt moduna göre; kapalıysa config). */
  effectiveBuyQuoteUsdt: string | null;
  manualBuyQuoteUsdt: string;
  blocksEntry: boolean;
  blockReason: 'downtrend_grind' | 'volatile_riskoff_breadth' | null;
  volatileBlockEnabled: boolean;
  volatileBlockBreadthMax: number;
  /** Adapt açık ama BTC 15m / bağlam alınamadı (deploy sonrası DO boş vb.). */
  dataWarning: string | null;
  /** Live poll: rejim önbelleği 30sn+ eski (tam rapor bekleniyor). */
  adaptStale?: boolean;
}

export interface DipReversalLiveReport {
  candidates: DipReversalCandidateView[];
  adapt: DipReversalAdaptView;
  adaptStale: boolean;
  scannedAt: string;
}

export interface DipReversalPositionsLiveReport {
  capacity: { open: number; max: number };
  positions: DipReversalPositionView[];
  scannedAt: string;
}

const ADAPT_CACHE_TTL_MS = 30_000;
const ADAPT_CACHE_STALE_MS = 60_000;

let dipAdaptCache: { snapshot: DipReversalAdaptSnapshot; at: number } | null = null;

function setDipAdaptCache(snapshot: DipReversalAdaptSnapshot | null): void {
  if (snapshot) dipAdaptCache = { snapshot, at: Date.now() };
}

function getDipAdaptCacheAgeMs(): number | null {
  if (!dipAdaptCache) return null;
  return Date.now() - dipAdaptCache.at;
}

function getCachedAdaptSnapshot(): DipReversalAdaptSnapshot | null {
  const age = getDipAdaptCacheAgeMs();
  if (age == null || age > ADAPT_CACHE_STALE_MS) return null;
  return dipAdaptCache!.snapshot;
}

export interface DipReversalReport {
  enabled: boolean;
  tradingEnabled: boolean;
  capacity: { open: number; max: number };
  config: {
    buyQuoteUsdt: string;
    minCapitulationDropPct: number;
    flashWindowMin: number;
    minWsDeclinePct: number;
    minRecoveryFromLowPct: number;
    minReversalScore: number;
    maxSecSinceTrough: number;
    requireMidSlope: boolean;
    trailingActivationPct: string;
    trailingCallbackPct: string;
    hardStopPct: string;
    postExitCooldownMin: number;
    regimeFilter: string[];
  };
  candidates: DipReversalCandidateView[];
  positions: DipReversalPositionView[];
  closedTradesToday: DipReversalClosedTrade[];
  pnl: DipReversalPnlSummary;
  totals: DipReversalTotals;
  adapt: DipReversalAdaptView;
  recent: DipReversalActivityView[];
  scannedAt: string;
}

function parseClosedTradeRow(
  r: { payload: string; created_at: string },
): DipReversalClosedTrade | null {
  let d: Record<string, unknown> = {};
  try {
    d = JSON.parse(r.payload) as Record<string, unknown>;
  } catch {
    return null;
  }
  const symbol = typeof d.symbol === 'string' ? d.symbol : null;
  if (!symbol) return null;
  const pnlUsdt = Number(d.pnl);
  if (Number.isNaN(pnlUsdt)) return null;
  const proceeds = d.proceeds != null ? Number(d.proceeds) : null;
  const spent = d.spent != null ? Number(d.spent) : null;
  const pnlPct = spent && spent > 0 ? (pnlUsdt / spent) * 100 : null;
  return {
    symbol,
    pnlUsdt,
    pnlPct,
    proceeds: proceeds != null && !Number.isNaN(proceeds) ? proceeds : null,
    spent: spent != null && !Number.isNaN(spent) ? spent : null,
    source: typeof d.source === 'string' ? d.source : null,
    closedAt: r.created_at,
  };
}

async function loadClosedTrades(db: D1Database): Promise<DipReversalClosedTrade[]> {
  const { results } = await db
    .prepare(
      `SELECT payload, created_at FROM trade_log
       WHERE event_type = 'POSITION_CLOSED'
         AND payload LIKE '%"entry_mode":"dip_reversal"%'
       ORDER BY id DESC LIMIT 200`,
    )
    .all<{ payload: string; created_at: string }>();
  const out: DipReversalClosedTrade[] = [];
  for (const r of results ?? []) {
    const t = parseClosedTradeRow(r);
    if (t) out.push(t);
  }
  return out;
}

/** TR saati 00:00'dan beri kapanan dip_reversal pozisyonları. */
async function loadClosedTradesToday(db: D1Database): Promise<DipReversalClosedTrade[]> {
  const { results } = await db
    .prepare(
      `SELECT payload, created_at FROM trade_log
       WHERE event_type = 'POSITION_CLOSED'
         AND payload LIKE '%"entry_mode":"dip_reversal"%'
         AND created_at >= datetime(date('now','+3 hours'),'-3 hours')
       ORDER BY id DESC LIMIT 100`,
    )
    .all<{ payload: string; created_at: string }>();
  const out: DipReversalClosedTrade[] = [];
  for (const r of results ?? []) {
    const t = parseClosedTradeRow(r);
    if (t) out.push(t);
  }
  return out;
}

function summarizePnl(trades: DipReversalClosedTrade[]): DipReversalPnlSummary {
  let total = 0;
  let wins = 0;
  let losses = 0;
  for (const t of trades) {
    total += t.pnlUsdt;
    if (t.pnlUsdt >= 0) wins++;
    else losses++;
  }
  return {
    totalPnlUsdt: Number(total.toFixed(4)),
    tradeCount: trades.length,
    wins,
    losses,
  };
}

function summarizeToday(trades: DipReversalClosedTrade[]): DipReversalTotals {
  let realizedPnlToday = 0;
  for (const t of trades) {
    realizedPnlToday += t.pnlUsdt;
  }
  return {
    realizedPnlToday: realizedPnlToday.toFixed(4),
    tradesToday: trades.length,
  };
}

function sortCandidates(
  rows: DipReversalCandidateView[],
  pinnedSymbols?: Set<string>,
  /** Açık pozisyonlar — üst blokta bu sıra korunur. */
  pinnedOrder?: string[],
): DipReversalCandidateView[] {
  const pinned = pinnedSymbols ?? new Set(pinnedOrder ?? []);
  const pinIndex = new Map((pinnedOrder ?? [...pinned]).map((s, i) => [s, i]));
  return [...rows].sort((a, b) => {
    const aPin = pinned.has(a.symbol);
    const bPin = pinned.has(b.symbol);
    if (aPin !== bPin) return aPin ? -1 : 1;
    if (aPin && bPin) {
      const ai = pinIndex.get(a.symbol) ?? 0;
      const bi = pinIndex.get(b.symbol) ?? 0;
      if (ai !== bi) return ai - bi;
    }
    if (a.ready !== b.ready) return a.ready ? -1 : 1;
    if (b.gatesPassed !== a.gatesPassed) return b.gatesPassed - a.gatesPassed;
    return b.reversalScore - a.reversalScore;
  });
}

function toCandidateView(
  row: DipReversalScanRow,
  pinnedSymbols?: Set<string>,
): DipReversalCandidateView {
  const gates = row.signal.gates.map((g) => ({
    id: g.id,
    pass: g.pass,
    actual: g.actual,
    threshold: g.threshold,
  }));
  return {
    symbol: row.symbol,
    mid: row.mid,
    windowDropPct: row.windowDropPct,
    change1mPct: row.change1mPct,
    change3mPct: row.change3mPct,
    change10mPct: row.change10mPct,
    change30mPct: row.change30mPct,
    flashDrop3mPct: row.flashDrop3mPct,
    wsDeclinePct: row.wsDeclinePct,
    recoveryFromWsLowPct: row.recoveryFromWsLowPct,
    reversalScore: row.reversalScore,
    secSinceTrough: row.secSinceTrough,
    midSlopeOk: row.midSlopeOk,
    gates,
    gatesPassed: gates.filter((g) => g.pass).length,
    gatesTotal: gates.length,
    excluded: row.excluded,
    ready: row.eligible,
    score: row.score,
    primaryBlocker: row.excluded ?? row.signal.primaryBlocker,
    pinned: pinnedSymbols?.has(row.symbol) ?? false,
  };
}

const RECENT_EVENT_TYPES = new Set([
  'DIP_REVERSAL_ENTRY_SIGNAL',
  'DIP_REVERSAL_ADAPT_SKIP',
  'DIP_REVERSAL_TIME_STOP',
  'DIP_REVERSAL_REGIME_SKIP',
  'DIP_REVERSAL_TRAILING_REJECTED',
  'DIP_REVERSAL_MIN_NOTIONAL_SKIP',
  'DIP_REVERSAL_LOT_SIZE_TOO_SMALL',
  'DIP_REVERSAL_EMERGENCY_SELL_FAILED',
  'DIP_REVERSAL_ERROR',
  'DIP_REVERSAL_ENTRY_BLOCKED',
  'DIP_REVERSAL_MANUAL_BUY',
  'BUY_FILLED',
  'TRAILING_PLACED',
  'POSITION_CLOSED',
  'HARD_STOP_TRIGGERED',
]);

function parseActivity(
  raw: { event_type: string; payload: string; created_at: string },
): DipReversalActivityView | null {
  let detail: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(raw.payload);
    if (parsed && typeof parsed === 'object') detail = parsed as Record<string, unknown>;
  } catch {
    detail = { raw: raw.payload };
  }
  // dip_reversal'a ait olmayan genel event'leri ele
  const isDipPrefixed = raw.event_type.startsWith('DIP_REVERSAL');
  const isDipTagged = detail.entry_mode === 'dip_reversal' || detail.source === 'dip_reversal_hard_stop' ||
    String(detail.source ?? '').startsWith('dip_reversal');
  if (!isDipPrefixed && !isDipTagged) return null;
  return {
    eventType: raw.event_type,
    symbol: typeof detail.symbol === 'string' ? detail.symbol : (typeof detail.chosen === 'string' ? detail.chosen : null),
    createdAt: raw.created_at,
    detail,
  };
}

async function fetchDipRankAndAdapt(
  env: Env,
  cfg: Awaited<ReturnType<typeof getDipReversalConfig>>,
): Promise<{
  rank: { rows: TickScanRow[] } | null;
  adaptSnapshot: DipReversalAdaptSnapshot | null;
}> {
  const tickCfg = await getTickScalpConfig(env.DB, env);
  const rank = await fetchTickRank(env, tickCfg);
  let adaptSnapshot: DipReversalAdaptSnapshot | null = null;
  if (cfg.adapt.enabled) {
    adaptSnapshot = await getDipReversalAdaptContext(env, cfg.adapt.thresholds, { rank });
    setDipAdaptCache(adaptSnapshot);
  }
  return { rank, adaptSnapshot };
}

function buildAdaptView(
  cfg: Awaited<ReturnType<typeof getDipReversalConfig>>,
  adaptSnapshot: DipReversalAdaptSnapshot | null,
  scanAdapt: DipReversalScanAdaptMeta | null,
  opts?: { adaptStale?: boolean },
): DipReversalAdaptView {
  const baseThr = thresholdsFromConfig(cfg);
  const effectiveThr =
    scanAdapt?.effectiveThresholds ??
    (adaptSnapshot
      ? resolveAdaptiveThresholds(baseThr, adaptSnapshot.mode, cfg.adapt.thresholds)
      : baseThr);

  const stale = opts?.adaptStale ?? false;
  const missing = cfg.adapt.enabled && adaptSnapshot == null;
  const mode = scanAdapt?.mode ?? adaptSnapshot?.mode ?? null;

  return {
    enabled: cfg.adapt.enabled,
    mode,
    trend: scanAdapt?.context?.trend ?? adaptSnapshot?.context.trend ?? null,
    emaSepPct: scanAdapt?.context?.emaSepPct ?? adaptSnapshot?.context.emaSepPct ?? null,
    atrPct: scanAdapt?.context?.atrPct ?? adaptSnapshot?.context.atrPct ?? null,
    breadthPct: scanAdapt?.context?.breadthPct ?? adaptSnapshot?.context.breadthPct ?? null,
    riskOff: scanAdapt?.context?.riskOff ?? adaptSnapshot?.context.riskOff ?? null,
    effectiveMinCapitulationDropPct: effectiveThr?.minCapitulationDropPct ?? null,
    effectiveMinReversalScore: effectiveThr?.minReversalScore ?? null,
    effectiveMinRecoveryFromLowPct: effectiveThr?.minRecoveryFromLowPct ?? null,
    effectiveBuyQuoteUsdt: resolveDipBuyQuoteFromConfig(cfg.buyQuoteUsdt, cfg.adapt, mode),
    manualBuyQuoteUsdt: resolveDipBuyQuoteFromConfig(cfg.buyQuoteUsdt, cfg.adapt, mode, true),
    blocksEntry:
      cfg.adapt.enabled &&
      adaptSnapshot != null &&
      adaptEntryBlockReason(adaptSnapshot.mode, {
        downtrendMode: cfg.adapt.downtrendMode,
        volatileBlockEnabled: cfg.adapt.volatileBlockEnabled,
        volatileBlockBreadthMax: cfg.adapt.volatileBlockBreadthMax,
        breadthPct: adaptSnapshot.context.breadthPct,
      }) != null,
    blockReason:
      cfg.adapt.enabled && adaptSnapshot
        ? adaptEntryBlockReason(adaptSnapshot.mode, {
            downtrendMode: cfg.adapt.downtrendMode,
            volatileBlockEnabled: cfg.adapt.volatileBlockEnabled,
            volatileBlockBreadthMax: cfg.adapt.volatileBlockBreadthMax,
            breadthPct: adaptSnapshot.context.breadthPct,
          })
        : null,
    volatileBlockEnabled: cfg.adapt.volatileBlockEnabled,
    volatileBlockBreadthMax: cfg.adapt.volatileBlockBreadthMax,
    dataWarning: missing
      ? 'BTC 15m verisi yok — taban eşikler kullanılıyor. grid-scout veya birkaç dk bekleyin.'
      : stale
        ? 'Rejim verisi 30sn+ eski — tam yenileme bekleniyor.'
        : null,
    adaptStale: stale || undefined,
  };
}

export async function buildDipReversalLive(env: Env): Promise<DipReversalLiveReport> {
  const cfg = await getDipReversalConfig(env.DB, env);
  const tickCfg = await getTickScalpConfig(env.DB, env);
  const rank = await fetchTickRank(env, tickCfg);

  const cacheAge = getDipAdaptCacheAgeMs();
  const adaptSnapshot = cfg.adapt.enabled ? getCachedAdaptSnapshot() : null;
  const adaptStale =
    cfg.adapt.enabled &&
    (adaptSnapshot == null || (cacheAge != null && cacheAge > ADAPT_CACHE_TTL_MS));

  const [scanResult, pinnedSymbols] = await Promise.all([
    scanDipReversalCandidates(env, cfg, {
      panelMode: 'live',
      adaptSnapshot,
      rank,
    }),
    dipReversalOpenSymbols(env.DB),
  ]);

  const pinnedOrder = [...pinnedSymbols].sort();
  const candidates = sortCandidates(
    scanResult.rows.map((r) => toCandidateView(r, pinnedSymbols)),
    pinnedSymbols,
    pinnedOrder,
  );

  return {
    candidates,
    adapt: buildAdaptView(cfg, adaptSnapshot, scanResult.adapt, { adaptStale }),
    adaptStale,
    scannedAt: new Date().toISOString(),
  };
}

export async function buildDipReversalPositionsLive(
  env: Env,
): Promise<DipReversalPositionsLiveReport> {
  const cfg = await getDipReversalConfig(env.DB, env);
  const [openCount, positions] = await Promise.all([
    countOpenPositions(env.DB, { entryMode: 'dip_reversal' }),
    listOpenPositions(env.DB, { entryMode: 'dip_reversal' }),
  ]);

  const pnlMap = await fetchFloatingPnlForOpenPositionsLight(
    env,
    positions.map((p) => ({
      id: p.id,
      symbol: p.symbol,
      net_base_qty: p.net_base_qty,
      total_usdt_spent: p.total_usdt_spent,
    })),
  );

  const positionViews: DipReversalPositionView[] = positions.map((p) => {
    const pnl = pnlMap.get(p.id);
    return {
      id: p.id,
      symbol: p.symbol,
      avgCost: p.avg_cost,
      netBaseQty: p.net_base_qty,
      spentUsdt: p.total_usdt_spent,
      hardStopPct: p.scalp_stop_loss_pct,
      trailingOrderId: p.trailing_order_id,
      openedAt: p.position_opened_at ?? p.updated_at,
      lastPrice: pnl?.lastPrice ?? null,
      pnlPct: pnl?.pnlPct ?? null,
      pnlUsdt: pnl?.pnlUsdt ?? null,
      marketValueUsdt: pnl?.marketValueUsdt ?? null,
    };
  });

  return {
    capacity: { open: openCount, max: cfg.maxConcurrent },
    positions: positionViews,
    scannedAt: new Date().toISOString(),
  };
}

export async function buildDipReversalReport(env: Env): Promise<DipReversalReport> {
  const cfg = await getDipReversalConfig(env.DB, env);
  const tradingEnabled = String(env.TRADING_ENABLED) === 'true';

  const { rank, adaptSnapshot } = await fetchDipRankAndAdapt(env, cfg);

  const [scanResult, openCount, positions, logs, closedTrades, closedTradesToday] =
    await Promise.all([
      scanDipReversalCandidates(env, cfg, {
        panelMode: 'full',
        adaptSnapshot,
        rank,
      }),
      countOpenPositions(env.DB, { entryMode: 'dip_reversal' }),
    listOpenPositions(env.DB, { entryMode: 'dip_reversal' }),
    listTradeLogs(env.DB, { limit: 60, offset: 0 }),
    loadClosedTrades(env.DB),
    loadClosedTradesToday(env.DB),
  ]);
  const pnl = summarizePnl(closedTrades);
  const totals = summarizeToday(closedTradesToday);

  const pnlMap = await fetchFloatingPnlForOpenPositionsLight(
    env,
    positions.map((p) => ({
      id: p.id,
      symbol: p.symbol,
      net_base_qty: p.net_base_qty,
      total_usdt_spent: p.total_usdt_spent,
    })),
  );

  const positionViews: DipReversalPositionView[] = positions.map((p) => {
    const pnl = pnlMap.get(p.id);
    return {
      id: p.id,
      symbol: p.symbol,
      avgCost: p.avg_cost,
      netBaseQty: p.net_base_qty,
      spentUsdt: p.total_usdt_spent,
      hardStopPct: p.scalp_stop_loss_pct,
      trailingOrderId: p.trailing_order_id,
      openedAt: p.position_opened_at ?? p.updated_at,
      lastPrice: pnl?.lastPrice ?? null,
      pnlPct: pnl?.pnlPct ?? null,
      pnlUsdt: pnl?.pnlUsdt ?? null,
      marketValueUsdt: pnl?.marketValueUsdt ?? null,
    };
  });

  const { rows, adapt: scanAdapt } = scanResult;

  const adaptView = buildAdaptView(cfg, adaptSnapshot, scanAdapt);

  const pinnedOrder = positions.map((p) => p.symbol);
  const pinnedSymbols = new Set(pinnedOrder);
  const candidates = sortCandidates(
    rows.map((r) => toCandidateView(r, pinnedSymbols)),
    pinnedSymbols,
    pinnedOrder,
  );

  const recent = logs
    .filter((l) => RECENT_EVENT_TYPES.has(l.event_type))
    .map(parseActivity)
    .filter((a): a is DipReversalActivityView => a !== null)
    .slice(0, 25);

  return {
    enabled: cfg.enabled,
    tradingEnabled,
    capacity: { open: openCount, max: cfg.maxConcurrent },
    config: {
      buyQuoteUsdt: cfg.buyQuoteUsdt,
      minCapitulationDropPct: cfg.minCapitulationDropPct,
      flashWindowMin: cfg.flashWindowMin,
      minWsDeclinePct: cfg.minWsDeclinePct,
      minRecoveryFromLowPct: cfg.minRecoveryFromLowPct,
      minReversalScore: cfg.minReversalScore,
      maxSecSinceTrough: cfg.maxSecSinceTrough,
      requireMidSlope: cfg.requireMidSlope,
      trailingActivationPct: cfg.trailingActivationPct,
      trailingCallbackPct: cfg.trailingCallbackPct,
      hardStopPct: cfg.hardStopPct,
      postExitCooldownMin: cfg.postExitCooldownMin,
      regimeFilter: cfg.regimeFilter,
    },
    candidates,
    positions: positionViews,
    closedTradesToday,
    pnl,
    totals,
    adapt: adaptView,
    recent,
    scannedAt: new Date().toISOString(),
  };
}
