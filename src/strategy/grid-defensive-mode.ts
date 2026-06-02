/**
 * Chop / piyasa düşüş / manuel kilit savunma modu.
 * Yeni grid yok; muaf olmayan aktif gridler recovery; recovery hedef altı MARKET çıkış.
 */
import type { BinanceClient } from '../exchange/binance';
import type { GridConfig } from '../db/grid';
import { detectMarketRegime, refreshMarketRegime } from '../indicators/market-regime';
import { logEvent } from '../db/trade-log';
import {
  evaluateGridMarketDownturn,
  downturnThresholdsFromGrid,
  type GridMarketDownturnResult,
} from './grid-market-downturn';

export type DefensiveReason = 'chop' | 'panic' | 'market_downturn' | 'force_active';

export interface DefensiveMarketMode {
  active: boolean;
  reasons: DefensiveReason[];
  regime: string;
  breadthPct: string;
  downturn: GridMarketDownturnResult | null;
}

export function isGridDefensiveExempt(cfg: GridConfig, gridId: number): boolean {
  return cfg.defensiveExemptGridIds.includes(gridId);
}

/** Recovery LIMIT hedefinin stopPct% altına inince MARKET sat. */
export function shouldStopRecoveryAtTarget(
  lastPrice: number,
  targetPrice: number,
  stopPct: number,
): boolean {
  if (!(lastPrice > 0) || !(targetPrice > 0) || !(stopPct > 0)) return false;
  const floor = targetPrice * (1 - stopPct / 100);
  return lastPrice <= floor;
}

export function evaluateDefensiveMarketMode(input: {
  cfg: GridConfig;
  regime: string;
  breadthPct: string;
  downturn: GridMarketDownturnResult | null;
}): DefensiveMarketMode {
  const reasons: DefensiveReason[] = [];
  if (!input.cfg.defensiveModeEnabled) {
    return {
      active: false,
      reasons: [],
      regime: input.regime,
      breadthPct: input.breadthPct,
      downturn: input.downturn,
    };
  }

  if (input.cfg.marketDownturnForceActive) {
    reasons.push('force_active');
  }
  if (input.regime === 'chop') {
    reasons.push('chop');
  }
  if (input.regime === 'panic') {
    reasons.push('panic');
  }
  if (input.downturn?.active) {
    if (input.downturn.reasons.includes('panic') && !reasons.includes('panic')) {
      reasons.push('panic');
    }
    reasons.push('market_downturn');
  }

  const unique = [...new Set(reasons)];
  return {
    active: unique.length > 0,
    reasons: unique,
    regime: input.regime,
    breadthPct: input.breadthPct,
    downturn: input.downturn,
  };
}

export async function resolveDefensiveMarketMode(
  env: Env,
  client: BinanceClient,
  cfg: GridConfig,
  watchlistSymbols: string[],
): Promise<DefensiveMarketMode> {
  const syms = watchlistSymbols.filter((s) => s.endsWith('USDT'));
  const regimeResult = await refreshMarketRegime(client, syms, env);
  const regimePct = detectMarketRegime({
    btcKlines15m: await client.getKlines('BTCUSDT', '15m', 30),
    breadthPct: regimeResult.breadthPct,
    thresholds: {
      btcAtrPanicPct: 1.2,
      breadthPanicMax: 35,
      breadthChopMax: 45,
    },
  });
  const regime = regimePct.regime;

  let downturn: GridMarketDownturnResult | null = null;
  if (cfg.marketDownturnEnabled) {
    const btcKlines = await client.getKlines('BTCUSDT', '15m', 30);
    let btc24h: number | null = null;
    try {
      const tickers = await client.getTicker24hr();
      const btc = tickers.find((t) => t.symbol === 'BTCUSDT');
      if (btc) btc24h = Number(btc.priceChangePercent);
    } catch {
      /* optional */
    }
    downturn = evaluateGridMarketDownturn({
      enabled: true,
      forceActive: cfg.marketDownturnForceActive,
      regime: { ...regimeResult, regime },
      btcKlines15m: btcKlines,
      btc24hChangePct: btc24h,
      thresholds: downturnThresholdsFromGrid(cfg),
    });
  }

  return evaluateDefensiveMarketMode({
    cfg,
    regime,
    breadthPct: regimeResult.breadthPct,
    downturn,
  });
}

/** setupGrids: true → kurulum yapılmaz. */
export async function blockSetupForDefensiveMode(
  db: D1Database,
  mode: DefensiveMarketMode,
): Promise<boolean> {
  if (!mode.active) return false;
  await logEvent(db, 'GRID_WAIT', {
    reason: 'defensive_mode',
    reasons: mode.reasons,
    regime: mode.regime,
    breadthPct: mode.breadthPct,
  });
  return true;
}
