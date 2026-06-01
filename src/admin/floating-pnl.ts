import type { BotState } from '../db/bot-state';
import { BinanceClient } from '../exchange/binance';
import { fetchSymbolMidPrice, fetchTickersFromDo } from '../exchange/market-data-client';
import { computeFloatingPnl, type FloatingPnlSnapshot } from '../position/floating-pnl';
import { bn } from '../math/decimal';

const OPEN_STATUSES = new Set(['TIER_1_BULL', 'MANUAL_INTERVENTION']);

export async function fetchFloatingPnlForStateLight(
  env: Env,
  state: BotState,
): Promise<FloatingPnlSnapshot | null> {
  if (!state.active_symbol || !OPEN_STATUSES.has(state.status)) return null;
  if (bn(state.net_base_qty).lte(0) || bn(state.total_usdt_spent).lte(0)) return null;

  let lastPrice = await fetchSymbolMidPrice(env, state.active_symbol);
  if (!lastPrice || Number(lastPrice) <= 0) {
    lastPrice = null;
  }
  if (!lastPrice) {
    const client = new BinanceClient(env);
    try {
      lastPrice = await client.getSymbolPrice(state.active_symbol);
    } catch {
      const tickers = await client.getTicker24hr();
      const t = tickers.find((x) => x.symbol === state.active_symbol);
      lastPrice = t?.lastPrice ?? '';
    }
  }
  if (!lastPrice) return null;

  return computeFloatingPnl(
    state.active_symbol,
    lastPrice,
    state.net_base_qty,
    state.total_usdt_spent,
  );
}

export interface OpenPositionPnlInput {
  id: number;
  symbol: string;
  net_base_qty: string;
  total_usdt_spent: string;
}

function normalizePrice(value: string | null | undefined): string | null {
  if (!value) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return value;
}

export async function fetchFloatingPnlForOpenPositionsLight(
  env: Env,
  positions: OpenPositionPnlInput[],
): Promise<Map<number, FloatingPnlSnapshot>> {
  const eligible = positions.filter(
    (p) => bn(p.net_base_qty).gt(0) && bn(p.total_usdt_spent).gt(0),
  );
  const result = new Map<number, FloatingPnlSnapshot>();
  if (eligible.length === 0) return result;

  const priceById = new Map<number, string>();
  const symbolById = new Map<number, string>();
  for (const p of eligible) {
    symbolById.set(p.id, p.symbol);
  }

  const mids = await Promise.all(
    eligible.map(async (p) => ({
      id: p.id,
      symbol: p.symbol,
      price: normalizePrice(await fetchSymbolMidPrice(env, p.symbol)),
    })),
  );
  for (const row of mids) {
    if (row.price) {
      priceById.set(row.id, row.price);
    }
  }

  const missing = eligible.filter((p) => !priceById.has(p.id));
  if (missing.length > 0) {
    const doTickers = await fetchTickersFromDo(env);
    const doTickerMap = new Map<string, string>(
      (doTickers ?? [])
        .map((t) => [t.symbol, normalizePrice(t.lastPrice)] as const)
        .filter((x): x is [string, string] => x[1] != null),
    );
    for (const p of missing) {
      const fromDo = doTickerMap.get(p.symbol);
      if (fromDo) {
        priceById.set(p.id, fromDo);
      }
    }
  }

  const stillMissing = eligible.filter((p) => !priceById.has(p.id));
  if (stillMissing.length > 0) {
    const client = new BinanceClient(env);
    let tickersCache: Array<{ symbol: string; lastPrice: string }> | null = null;
    for (const p of stillMissing) {
      let price: string | null = null;
      try {
        price = normalizePrice(await client.getSymbolPrice(p.symbol));
      } catch {
        /* bir alt fallback kullanılacak */
      }

      if (!price) {
        if (!tickersCache) {
          try {
            tickersCache = await client.getTicker24hr();
          } catch {
            tickersCache = [];
          }
        }
        const ticker = tickersCache.find((t) => t.symbol === p.symbol);
        price = normalizePrice(ticker?.lastPrice);
      }

      if (price) {
        priceById.set(p.id, price);
      }
    }
  }

  for (const p of eligible) {
    const symbol = symbolById.get(p.id);
    const lastPrice = priceById.get(p.id);
    if (!symbol || !lastPrice) continue;
    const snapshot = computeFloatingPnl(
      symbol,
      lastPrice,
      p.net_base_qty,
      p.total_usdt_spent,
    );
    if (snapshot) {
      result.set(p.id, snapshot);
    }
  }

  return result;
}
