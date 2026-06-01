const STORAGE_KEY = 'trigger_secret';

export function getSecret(): string | null {
  if (typeof window === 'undefined') return null;
  return sessionStorage.getItem(STORAGE_KEY);
}

export function setSecret(secret: string): void {
  sessionStorage.setItem(STORAGE_KEY, secret);
}

export function clearSecret(): void {
  sessionStorage.removeItem(STORAGE_KEY);
}

function apiBase(): string {
  return process.env.NEXT_PUBLIC_API_BASE ?? '';
}

export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const secret = getSecret();
  if (!secret) {
    if (typeof window !== 'undefined') {
      window.location.href = '/admin/login/';
    }
    throw new Error('Unauthorized');
  }

  const res = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-Trigger-Secret': secret,
      ...(init.headers as Record<string, string>),
    },
  });

  if (res.status === 401) {
    clearSecret();
    window.location.href = '/admin/login/';
    throw new Error('Unauthorized');
  }

  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) {
    throw new Error(data.error ?? res.statusText);
  }
  return data;
}

export interface PnlSummary {
  closedTrades: number;
  wins: number;
  losses: number;
  breakeven: number;
  totalPnlUsdt: string;
  totalSpentUsdt: string;
  totalProceedsUsdt: string;
  buyCount: number;
  estimatedBnbCommission: string;
  recentCloses: Array<{
    id: number;
    symbol: string;
    spent: string;
    proceeds: string;
    pnl: string;
    source: string | null;
    closedAt: string;
  }>;
}

export interface FloatingPnl {
  symbol: string;
  avgCost: string;
  lastPrice: string;
  pnlPct: string;
  pnlUsdt: string;
  marketValueUsdt: string;
  netBaseQty: string;
  totalUsdtSpent: string;
}

export interface RotationStatus {
  elapsedMinutes: string | null;
  graceMinutes: number;
  inGracePeriod: boolean;
  rotationChecksActive: boolean;
  bypassGraceForLoss: boolean;
  lossRelaxedMin: boolean;
  configuredMinImprovementPct: string;
  effectiveMinImprovementPct: string;
  floatingPnlPct: string | null;
  summary: string;
}

export interface MicroScoreComponents {
  volumeRatio?: number;
  aggression?: number;
  orderbook?: number;
  trend1m?: number;
  trend5m?: number;
  trend15m?: number;
}

export interface MarketDataStatusRow {
  symbol: string;
  bidAskRatio: number;
  spreadPct: number;
  persistenceScore: number;
  obAgeMs: number;
  kline1mAgeMs: number | null;
  kline5mAgeMs: number | null;
  kline15mAgeMs: number | null;
  stale: boolean;
  liveScore: string | null;
}

export interface MarketDataWsShard {
  id: string;
  streams: number;
  open: boolean;
}

export interface MarketDataStatus {
  symbolCount: number;
  wsShards: MarketDataWsShard[];
  tickerCount: number;
  tickerUpdatedAt: number | null;
  lastMessageAt: number | null;
  messageCount: number;
  regime?: {
    regime: string;
    btcAtrPct: string;
    breadthPct: string;
    detail: string;
  } | null;
  symbols: MarketDataStatusRow[];
}

export interface MarketDataApiResponse {
  available: boolean;
  status: MarketDataStatus | null;
}

export interface ShadowFailReasonStats {
  failReason: string;
  n: number;
  avgForward30m: string | null;
  hitTp30mPct: string | null;
}

export interface ShadowSummary {
  days: number;
  total: number;
  completed: number;
  byFailReason: ShadowFailReasonStats[];
  wouldPassScoreOnly: {
    n: number;
    avgForward30m: string | null;
    hitTp30mPct: string | null;
  };
}

export interface TickEntryThresholds {
  gainMinPct: string;
  gainMaxPct: string;
  recoveryMinPct: string;
  recoveryEffectiveMinPct: string;
  orderbookRatioMin: number;
  takeProfitPct: string;
  doSymbolCount: number | null;
  wsStale?: boolean;
}

export interface DashboardData {
  floatingPnl: FloatingPnl | null;
  openPositionCount?: number;
  openPositions?: Array<{
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
  }>;
  tickOpenSlots?: {
    open: number;
    max: number;
  } | null;
  rotationStatus: RotationStatus | null;
  microScalpEnabled?: boolean;
  tickScalpEnabled?: boolean;
  tickEntryThresholds?: TickEntryThresholds | null;
  watchlistDbCount?: number;
  microScanCursor?: number | null;
  marketRegime?: string;
  marketRegimeDetail?: Record<string, unknown>;
  botState: {
    status: string;
    active_symbol: string | null;
    net_base_qty: string;
    total_usdt_spent: string;
    avg_cost: string;
    trailing_order_id: string | null;
    position_opened_at: string | null;
    watchlist_cursor: number;
    entry_mode: string | null;
    take_profit_price: string | null;
    scalp_stop_loss_pct?: string | null;
    updated_at: string;
  };
  watchlist: Array<{
    symbol: string;
    price_at_addition: string;
    added_at: string;
    target_sma: string | null;
    momentum_ok?: number;
    momentum_checked_at?: string | null;
    lastClose: string;
    sma20: string;
    deviationPct: string;
    smaDeviationPct: string;
    changeSinceScoutPct: string;
    nearSma: boolean;
    pullbackTolerancePct: string;
    isActivePosition: boolean;
    isBestSma: boolean;
    momentumScorePct: string | null;
    momentumRank: number | null;
    momentumPassed: boolean;
    momentumGreenCount?: number | null;
    isBestMomentum: boolean;
    momentumCheckedAt: string | null;
    windowGains: Record<string, { gainPct: string; passed: boolean }>;
    microScore?: string | null;
    microRank?: number | null;
    microPassed?: boolean;
    isBestMicro?: boolean;
    sectorTag?: string | null;
    microVolumeRatio?: string | null;
    microAggression?: string | null;
    microOrderbookRatio?: string | null;
    microTrend1m?: string | null;
    microComponents?: MicroScoreComponents | null;
    microFailReason?: string | null;
    microTrend15mTier?: string | null;
    microScoreDeltaPts?: string | null;
    microVolumeDeltaPct?: string | null;
    microAggressionDeltaPct?: string | null;
    microOrderbookDeltaPct?: string | null;
    tickGainPct?: string | null;
    tickBidAskRatio?: number | null;
    tickFailReason?: string | null;
    tickWsDeclinePct?: string | null;
    tickWsDeclineOk?: boolean;
    trend5mOk?: boolean;
    trend5mFailReason?: string | null;
    tickRecoveryPct?: string | null;
    tickReversalScore?: number | null;
    tickReversalOk?: boolean;
    tickEligible?: boolean;
    tickReadinessPct?: number | null;
    tickGatesPassed?: number | null;
    tickGatesTotal?: number | null;
    tickPrimaryBlocker?: string | null;
  }>;
  watchlistUpdatedAt?: string;
  pnl: PnlSummary;
  pnlAllTime?: PnlSummary;
  pnlTodayLabel?: string;
  recentLogs: Array<{ id: number; event_type: string; created_at: string; payload: unknown }>;
  config: Array<{ key: string; value: string; updated_at: string }>;
  tradingEnabled: string;
  binanceBaseUrl: string;
  crons: string[];
}

export interface OpenPositionsData {
  openPositionCount: number;
  openPositions: NonNullable<DashboardData['openPositions']>;
  tickOpenSlots?: {
    open: number;
    max: number;
  } | null;
  updatedAt?: string;
}

export interface BinanceRangePnlBucketRow {
  bucket: string;
  trades: number;
  spentUsdt: string;
  proceedsUsdt: string;
  pnlUsdt: string;
}

export interface BinanceRangePnlCloseRow {
  id: number;
  symbol: string;
  source: string | null;
  orderId: number | null;
  closedAtUtc: string;
  closedAtLocal: string;
  spentUsdt: string;
  proceedsUsdt: string;
  pnlUsdt: string;
  verification: 'binance' | 'fallback';
  note: string | null;
}

export interface GridLadderLevel {
  levelIndex: number;
  price: number;
  side: 'BUY' | 'SELL' | null;
  open: boolean;
  /** Borsada emir yok; grid planında bu seviyede emir bekleniyor (ör. alış sonrası satış). */
  planned?: boolean;
  kind?: 'floor' | 'grid' | 'planned' | 'waiting';
  orderPrice?: number;
  deferTriggerPrice?: number;
}

export interface GridStatusReport {
  enabled: boolean;
  liveGate: boolean;
  tradingEnabled: boolean;
  active: boolean;
  gridId: number | null;
  symbol: string | null;
  lower: number | null;
  upper: number | null;
  gridCount: number | null;
  spacingPct: number | null;
  lastPrice: number | null;
  rangeStatus: string | null;
  realizedPnl: string | null;
  cycles: number | null;
  openBuys: number;
  openSells: number;
  inventoryCostUsdt: number;
  inventoryQty: number;
  inventoryAvgCost: number | null;
  inventoryUnrealizedPct: number | null;
  ladder: GridLadderLevel[];
  ladderMode?: 'classic' | 'breakeven_dip';
  floorExitMarginPct?: number;
  dipBuyDeferSteps?: number;
  floorExitTargetPrice?: number | null;
  flashDrop: {
    level: 'none' | 'warn' | 'pause' | 'recovery';
    anchorPrice: number;
    dropPct: number;
    windowDropPct: number;
    recentFillCount: number;
    reasons: string[];
  } | null;
}

export interface GridMarketGate {
  active: boolean;
  reasons: string[];
  breadthPct: string;
  btc24hChangePct: number | null;
  btc15mReturnPct: number | null;
  regime: string;
  forceActive: boolean;
}

export interface GridCandidateRow {
  symbol: string;
  ready: boolean;
  isActive: boolean;
  isRecovering: boolean;
  recoveringGridId: number | null;
  setupEligible: boolean;
  score: number;
  efficiencyRatio: number | null;
  rangeWidthPct: number | null;
  atrPct: number | null;
  spreadPct: number | null;
  priceInRange: boolean;
  primaryBlocker: string | null;
  gatesPassed: number;
  gatesTotal: number;
  lastPrice: number | null;
  flashLevel: 'none' | 'warn' | 'pause' | 'recovery' | null;
  windowDropPct: number | null;
  downsideBlocked: boolean;
  flashCooldown: boolean;
  pathRangeRatio: number | null;
  postExitRelax: boolean;
  recentStopReason: string | null;
}

export interface GridRecoveryRow {
  gridId: number;
  symbol: string;
  qty: string;
  avgCost: string;
  targetPrice: string;
  costUsdt: number | null;
  valueUsdt: number | null;
  lastPrice: number | null;
  distancePct: number | null;
  unrealizedPct: number | null;
  waitingSince: string;
  walletFree: number;
  walletLocked: number;
  walletTotal: number;
  excessFree: number;
}

export interface GridDashboard {
  enabled: boolean;
  liveGate: boolean;
  tradingEnabled: string;
  marketDownturnForceActive: boolean;
  maxConcurrent: number;
  grids: GridStatusReport[];
  recovering: GridRecoveryRow[];
  candidates: GridCandidateRow[];
  marketGate?: GridMarketGate;
  /** @deprecated marketGate.active */
  marketPanic?: boolean;
  totals: {
    realizedPnlAllTime: string;
    cyclesAllTime: number;
    activeGrids: number;
    recoveringCount: number;
    realizedPnlToday: string;
    cyclesToday: number;
  };
  recentCycles: Array<{
    symbol: string;
    pnl: string;
    at: string;
    kind: 'cycle' | 'recovery';
    source?: string | null;
    maxAdversePct?: string | null;
  }>;
  recentLogs: Array<{ id: number; event_type: string; created_at: string; payload: unknown }>;
}

export type OrphanRecommend = 'sell' | 'recovery' | 'dust' | 'no_pair';

export interface OrphanBalanceRow {
  asset: string;
  symbol: string;
  free: number;
  locked: number;
  price: number | null;
  valueUsdt: number | null;
  avgCost: number | null;
  unrealizedPct: number | null;
  recommend: OrphanRecommend;
  excessUnderGrid?: boolean;
  walletTotal?: number;
}

export interface OrphanReport {
  thresholdUsdt: number;
  totalValueUsdt: number;
  actionableValueUsdt: number;
  dustValueUsdt: number;
  actionableCount: number;
  dustCount: number;
  rows: OrphanBalanceRow[];
}

export interface BinanceRangePnlData {
  range: {
    startMs: number;
    endMs: number;
    timezone: string;
    bucket: 'hour' | 'day';
    truncated: boolean;
  };
  summary: {
    tradeCount: number;
    totalSpentUsdt: string;
    totalProceedsUsdt: string;
    totalPnlUsdt: string;
    verifiedCount: number;
    fallbackCount: number;
  };
  buckets: BinanceRangePnlBucketRow[];
  closes: BinanceRangePnlCloseRow[];
}
