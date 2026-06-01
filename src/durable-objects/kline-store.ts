import type { Kline } from '../exchange/binance';

export type KlineInterval = '1m' | '5m' | '15m';

const MAX_BUFFER = 40;

export interface BinanceKlineEvent {
  e?: string;
  E?: number;
  s?: string;
  k?: {
    t: number;
    T: number;
    o: string;
    h: string;
    l: string;
    c: string;
    v: string;
    n: number;
    x: boolean;
    q: string;
    V: string;
    Q: string;
  };
}

export function parseKlineEvent(
  msg: unknown,
  stream?: string,
): { symbol: string; interval: KlineInterval; kline: Kline; closed: boolean } | null {
  const wrapped = msg as { data?: BinanceKlineEvent };
  const m = (wrapped.data ?? msg) as BinanceKlineEvent;
  if (m.e !== 'kline' || !m.k || !m.s) return null;
  let interval = intervalFromStreamName(stream) ?? intervalFromDuration(m.k);
  if (!interval) return null;
  const k = m.k;
  return {
    symbol: m.s.toUpperCase(),
    interval,
    closed: k.x,
    kline: {
      openTime: k.t,
      open: k.o,
      high: k.h,
      low: k.l,
      close: k.c,
      volume: k.v,
      closeTime: k.T,
      numberOfTrades: k.n,
      takerBuyBaseVolume: k.V,
      takerBuyQuoteVolume: k.Q,
    },
  };
}

function intervalFromStreamName(stream?: string): KlineInterval | null {
  if (!stream) return null;
  if (stream.includes('kline_1m')) return '1m';
  if (stream.includes('kline_5m')) return '5m';
  if (stream.includes('kline_15m')) return '15m';
  return null;
}

function intervalFromDuration(k: NonNullable<BinanceKlineEvent['k']>): KlineInterval | null {
  const dur = k.T - k.t;
  if (dur <= 90_000) return '1m';
  if (dur <= 360_000) return '5m';
  if (dur <= 1_100_000) return '15m';
  return null;
}

interface SymbolIntervals {
  closed: Kline[];
  open: Kline | null;
  lastClosedAt: number;
  lastUpdateAt: number;
}

export class KlineStore {
  private data = new Map<string, Map<KlineInterval, SymbolIntervals>>();

  seed(symbol: string, interval: KlineInterval, klines: Kline[]): void {
    const sym = symbol.toUpperCase();
    let map = this.data.get(sym);
    if (!map) {
      map = new Map();
      this.data.set(sym, map);
    }
    const closed = klines.filter((k, i, arr) => {
      const isLast = i === arr.length - 1;
      if (isLast && k.closeTime >= Date.now() - 1000) return false;
      return true;
    });
    const open =
      klines.length > 0 && klines[klines.length - 1]!.closeTime >= Date.now() - 1000
        ? klines[klines.length - 1]!
        : null;
    map.set(interval, {
      closed: closed.slice(-MAX_BUFFER),
      open,
      lastClosedAt: closed.length > 0 ? closed[closed.length - 1]!.closeTime : 0,
      lastUpdateAt: Date.now(),
    });
  }

  onKline(symbol: string, interval: KlineInterval, kline: Kline, closed: boolean): boolean {
    const sym = symbol.toUpperCase();
    let map = this.data.get(sym);
    if (!map) {
      map = new Map();
      this.data.set(sym, map);
    }
    let slot = map.get(interval);
    if (!slot) {
      slot = { closed: [], open: null, lastClosedAt: 0, lastUpdateAt: 0 };
      map.set(interval, slot);
    }
    slot.lastUpdateAt = Date.now();

    if (closed) {
      const last = slot.closed[slot.closed.length - 1];
      if (!last || last.openTime !== kline.openTime) {
        slot.closed.push(kline);
        if (slot.closed.length > MAX_BUFFER) slot.closed.shift();
      } else {
        slot.closed[slot.closed.length - 1] = kline;
      }
      slot.open = null;
      slot.lastClosedAt = kline.closeTime;
      return true;
    }
    slot.open = kline;
    return false;
  }

  /** Skor için: kapalı mumlar + (isteğe bağlı) son açık hariç */
  getSeries(symbol: string, interval: KlineInterval, limit: number, includeOpen = false): Kline[] {
    const slot = this.data.get(symbol.toUpperCase())?.get(interval);
    if (!slot) return [];
    const out = [...slot.closed];
    if (includeOpen && slot.open) out.push(slot.open);
    return out.slice(-limit);
  }

  getForScoring(symbol: string, interval: KlineInterval, limit: number): Kline[] {
    const slot = this.data.get(symbol.toUpperCase())?.get(interval);
    if (!slot) return [];
    const closed = slot.closed.slice(-limit);
    if (closed.length >= limit) return closed;
    if (slot.open && closed.length > 0) {
      return [...closed, slot.open].slice(-limit);
    }
    if (slot.open && closed.length === 0) return [slot.open];
    return closed;
  }

  getLastClosedAgeMs(symbol: string, interval: KlineInterval): number | null {
    const slot = this.data.get(symbol.toUpperCase())?.get(interval);
    if (!slot || slot.lastClosedAt === 0) return null;
    return Date.now() - slot.lastClosedAt;
  }

  /** Admin: son WS güncellemesi (açık mum dahil) */
  getLastUpdateAgeMs(symbol: string, interval: KlineInterval): number | null {
    const slot = this.data.get(symbol.toUpperCase())?.get(interval);
    if (!slot || slot.lastUpdateAt === 0) return null;
    return Date.now() - slot.lastUpdateAt;
  }

  hasMinimum(symbol: string, interval: KlineInterval, minClosed: number): boolean {
    const slot = this.data.get(symbol.toUpperCase())?.get(interval);
    if (!slot) return false;
    return slot.closed.length >= minClosed;
  }

  /** Aktif mum: açık varsa o, yoksa son kapalı */
  getActiveCandle(
    symbol: string,
    interval: KlineInterval,
  ): { candle: Kline; isClosed: boolean } | null {
    const slot = this.data.get(symbol.toUpperCase())?.get(interval);
    if (!slot) return null;
    if (slot.open) return { candle: slot.open, isClosed: false };
    const last = slot.closed[slot.closed.length - 1];
    if (!last) return null;
    return { candle: last, isClosed: true };
  }
}
