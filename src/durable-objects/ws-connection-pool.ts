export type WsMessageHandler = (data: unknown, stream?: string) => void;

export interface WsPoolOptions {
  baseUrl?: string;
  maxStreamsPerSocket?: number;
  onMessage: WsMessageHandler;
}

const DEFAULT_BASE = 'wss://stream.binance.com:9443/stream?streams=';

export class WsConnectionPool {
  private sockets = new Map<string, WebSocket>();
  private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private streamSets = new Map<string, string[]>();
  private readonly baseUrl: string;
  private readonly maxStreams: number;
  private readonly onMessage: WsMessageHandler;

  constructor(opts: WsPoolOptions) {
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE;
    this.maxStreams = opts.maxStreamsPerSocket ?? 80;
    this.onMessage = opts.onMessage;
  }

  setStreams(streams: string[]): void {
    const normalized = [...new Set(streams)].sort();
    const shards = chunk(normalized, this.maxStreams);
    const nextIds = new Set(shards.map((_, i) => `shard-${i}`));

    for (const id of this.sockets.keys()) {
      if (!nextIds.has(id)) this.closeShard(id);
    }

    shards.forEach((shardStreams, i) => {
      const id = `shard-${i}`;
      const prev = this.streamSets.get(id);
      const same =
        prev &&
        prev.length === shardStreams.length &&
        prev.every((s, j) => s === shardStreams[j]);
      this.streamSets.set(id, shardStreams);
      if (!same || !this.isOpen(id)) {
        this.connectShard(id, shardStreams);
      }
    });
  }

  closeAll(): void {
    for (const id of [...this.sockets.keys()]) this.closeShard(id);
  }

  getStatus(): Array<{ id: string; streams: number; open: boolean }> {
    return [...this.streamSets.entries()].map(([id, streams]) => ({
      id,
      streams: streams.length,
      open: this.isOpen(id),
    }));
  }

  private isOpen(id: string): boolean {
    const ws = this.sockets.get(id);
    return ws != null && ws.readyState === WebSocket.OPEN;
  }

  private connectShard(id: string, streams: string[]): void {
    if (streams.length === 0) {
      this.closeShard(id);
      return;
    }
    this.closeShard(id, false);
    const url = this.baseUrl + streams.join('/');
    try {
      const ws = new WebSocket(url);
      this.sockets.set(id, ws);
      ws.addEventListener('message', (ev) => {
        try {
          const parsed = JSON.parse(String(ev.data)) as { stream?: string; data?: unknown };
          if (parsed.stream && parsed.data != null) {
            this.onMessage(parsed.data, parsed.stream);
          } else {
            this.onMessage(parsed);
          }
        } catch {
          /* ignore */
        }
      });
      ws.addEventListener('close', () => {
        this.sockets.delete(id);
        this.scheduleReconnect(id);
      });
      ws.addEventListener('error', () => {
        this.scheduleReconnect(id);
      });
    } catch {
      this.scheduleReconnect(id);
    }
  }

  private scheduleReconnect(id: string): void {
    if (this.reconnectTimers.has(id)) return;
    const streams = this.streamSets.get(id);
    if (!streams?.length) return;
    const t = setTimeout(() => {
      this.reconnectTimers.delete(id);
      this.connectShard(id, streams);
    }, 5000);
    this.reconnectTimers.set(id, t);
  }

  private closeShard(id: string, removeStreams = true): void {
    const t = this.reconnectTimers.get(id);
    if (t) {
      clearTimeout(t);
      this.reconnectTimers.delete(id);
    }
    const ws = this.sockets.get(id);
    if (ws) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      this.sockets.delete(id);
    }
    if (removeStreams) this.streamSets.delete(id);
  }
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out.length > 0 ? out : [];
}

/** Watchlist + BTC: depth, kline, bookTicker (hafif fiyat; !ticker@arr DO'da parse/ boyut sorunu) */
export function buildMarketStreams(symbols: string[]): string[] {
  const streams: string[] = [];
  const set = new Set(symbols.map((s) => s.toUpperCase()));
  set.add('BTCUSDT');
  for (const sym of set) {
    const s = sym.toLowerCase();
    streams.push(`${s}@bookTicker`);
    streams.push(`${s}@aggTrade`);
    streams.push(`${s}@depth20@100ms`);
    streams.push(`${s}@kline_1m`);
    streams.push(`${s}@kline_5m`);
    streams.push(`${s}@kline_15m`);
  }
  return streams;
}
