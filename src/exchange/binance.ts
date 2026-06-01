import { fetchBinance } from './binance-fetch';
import { buildSignedQuery, signRequest } from './sign';

export class BinanceApiError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'BinanceApiError';
  }
}

export interface Ticker24hr {
  symbol: string;
  lastPrice: string;
  highPrice: string;
  lowPrice: string;
  quoteVolume: string;
  priceChangePercent: string;
}

export interface Kline {
  openTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  closeTime: number;
  numberOfTrades: number;
  takerBuyBaseVolume: string;
  takerBuyQuoteVolume: string;
}

export interface BookTicker {
  symbol: string;
  bidPrice: string;
  bidQty: string;
  askPrice: string;
  askQty: string;
}

export interface DepthLevel {
  price: string;
  qty: string;
}

export interface OrderBookDepth {
  bids: DepthLevel[];
  asks: DepthLevel[];
}

export interface OrderFill {
  price: string;
  qty: string;
  commission: string;
  commissionAsset: string;
}

export interface OrderResponse {
  symbol: string;
  orderId: number;
  status: string;
  executedQty: string;
  cummulativeQuoteQty: string;
  fills?: OrderFill[];
  type?: string;
  side?: string;
}

export interface MyTrade {
  symbol: string;
  id: number;
  orderId: number;
  price: string;
  qty: string;
  quoteQty: string;
  commission: string;
  commissionAsset: string;
  time: number;
  isBuyer: boolean;
  isMaker: boolean;
}

export interface OrderListOrder {
  symbol: string;
  orderId: number;
  clientOrderId: string;
}

export interface OcoOrderResponse {
  orderListId: number;
  contingencyType: string;
  listStatusType: string;
  listOrderStatus: string;
  listClientOrderId: string;
  transactionTime: number;
  symbol: string;
  orders: OrderListOrder[];
  orderReports?: OrderResponse[];
}

export interface SymbolInfo {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  filters: Array<Record<string, string>>;
  /** Binance listelenme zamanı (ms) */
  onboardDate?: number;
}

export interface ExchangeInfoResponse {
  symbols: SymbolInfo[];
}

export interface AccountBalance {
  asset: string;
  free: string;
  locked: string;
}

export interface SymbolPrice {
  symbol: string;
  price: string;
}

export interface DustListItem {
  asset: string;
  assetFullName: string;
  amountFree: string;
  toBTC: string;
  toBNB: string;
  toBNBOffExchange: string;
  exchange: string;
}

export interface DustListResponse {
  details: DustListItem[];
  totalTransferBtc: string;
  totalTransferBNB: string;
  dribbletPercentage: string;
}

export interface DustTransferResultItem {
  amount: string;
  fromAsset: string;
  operateTime: number;
  serviceChargeAmount: string;
  tranId: number;
  transferedAmount: string;
}

export interface DustTransferResponse {
  totalServiceCharge: string;
  totalTransfered: string;
  transferResult: DustTransferResultItem[];
}

type FetchOpts = {
  method?: string;
  params?: Record<string, string | number | boolean | undefined>;
  signed?: boolean;
};

export class BinanceClient {
  constructor(private readonly env: Env) {}

  private get baseUrl(): string {
    return this.env.BINANCE_BASE_URL;
  }

  async fetch<T>(path: string, opts: FetchOpts = {}): Promise<T> {
    const { method = 'GET', params = {}, signed = false } = opts;
    let url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {};

    if (signed) {
      if (!this.env.BINANCE_API_KEY || !this.env.BINANCE_API_SECRET) {
        throw new BinanceApiError('Missing BINANCE_API_KEY or BINANCE_API_SECRET', undefined, 401);
      }
      headers['X-MBX-APIKEY'] = this.env.BINANCE_API_KEY;
      const query = await buildSignedQuery(params, this.env.BINANCE_API_SECRET);
      url += url.includes('?') ? `&${query}` : `?${query}`;
    } else if (Object.keys(params).length > 0) {
      const qs = new URLSearchParams(
        Object.entries(params)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, String(v)]),
      ).toString();
      url += `?${qs}`;
    }

    const res = await fetchBinance(this.env, url, {
      method,
      headers: { ...headers, ...(method !== 'GET' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    });

    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new BinanceApiError(`Invalid JSON from Binance: ${text.slice(0, 200)}`, undefined, res.status);
    }

    const err = data as { code?: number; msg?: string };
    if (!res.ok || (typeof err.code === 'number' && err.code < 0)) {
      const msg = err.msg ?? res.statusText;
      if (res.status === 401 || res.status === 403 || err.code === -2015) {
        throw new BinanceApiError(`BINANCE_AUTH_ERROR: ${msg}`, err.code, res.status);
      }
      throw new BinanceApiError(msg, err.code, res.status);
    }

    return data as T;
  }

  getTicker24hr(): Promise<Ticker24hr[]> {
    return this.fetch<Ticker24hr[]>('/api/v3/ticker/24hr');
  }

  getSymbolPrice(symbol: string): Promise<string> {
    return this.fetch<{ price: string }>('/api/v3/ticker/price', { params: { symbol } }).then(
      (r) => r.price,
    );
  }

  getKlines(symbol: string, interval: string, limit: number): Promise<Kline[]> {
    return this.fetch<unknown[][]>('/api/v3/klines', {
      params: { symbol, interval, limit },
    }).then((rows) =>
      rows.map((r) => ({
        openTime: r[0] as number,
        open: String(r[1]),
        high: String(r[2]),
        low: String(r[3]),
        close: String(r[4]),
        volume: String(r[5]),
        closeTime: r[6] as number,
        numberOfTrades: Number(r[8] ?? 0),
        takerBuyBaseVolume: String(r[9] ?? '0'),
        takerBuyQuoteVolume: String(r[10] ?? '0'),
      })),
    );
  }

  getBookTicker(symbol?: string): Promise<BookTicker[]> {
    return this.fetch<BookTicker[]>('/api/v3/ticker/bookTicker', {
      params: symbol ? { symbol } : undefined,
    });
  }

  getDepth(symbol: string, limit = 20): Promise<OrderBookDepth> {
    return this.fetch<{ bids: string[][]; asks: string[][] }>('/api/v3/depth', {
      params: { symbol, limit },
    }).then((d) => ({
      bids: (d.bids ?? []).map(([price, qty]) => ({ price, qty })),
      asks: (d.asks ?? []).map(([price, qty]) => ({ price, qty })),
    }));
  }

  getExchangeInfo(symbol?: string): Promise<ExchangeInfoResponse> {
    return this.fetch<ExchangeInfoResponse>('/api/v3/exchangeInfo', {
      params: symbol ? { symbol } : undefined,
    });
  }

  placeOrder(params: Record<string, string | number>): Promise<OrderResponse> {
    return this.fetch<OrderResponse>('/api/v3/order', {
      method: 'POST',
      params,
      signed: true,
    });
  }

  placeOrderListOco(params: Record<string, string | number>): Promise<OcoOrderResponse> {
    return this.fetch<OcoOrderResponse>('/api/v3/orderList/oco', {
      method: 'POST',
      params,
      signed: true,
    });
  }

  getOrder(symbol: string, orderId: string | number): Promise<OrderResponse> {
    return this.fetch<OrderResponse>('/api/v3/order', {
      params: { symbol, orderId },
      signed: true,
    });
  }

  cancelOrder(symbol: string, orderId: string | number): Promise<OrderResponse> {
    return this.fetch<OrderResponse>('/api/v3/order', {
      method: 'DELETE',
      params: { symbol, orderId },
      signed: true,
    });
  }

  getOpenOrders(symbol: string): Promise<OrderResponse[]> {
    return this.fetch<OrderResponse[]>('/api/v3/openOrders', {
      params: { symbol },
      signed: true,
    });
  }

  getAccountBalances(): Promise<AccountBalance[]> {
    return this.fetch<{ balances: AccountBalance[] }>('/api/v3/account', { signed: true }).then(
      (a) => a.balances,
    );
  }

  getMyTrades(symbol: string, limit = 1000): Promise<MyTrade[]> {
    return this.fetch<MyTrade[]>('/api/v3/myTrades', {
      params: { symbol, limit },
      signed: true,
    });
  }

  /** Tüm semboller için son fiyat (tek çağrı). */
  getAllSymbolPrices(): Promise<SymbolPrice[]> {
    return this.fetch<SymbolPrice[]>('/api/v3/ticker/price');
  }

  /** BNB'ye dönüştürülebilir dust (küçük bakiye) listesi. */
  getDustList(): Promise<DustListResponse> {
    return this.fetch<DustListResponse>('/sapi/v1/asset/dust-btc', {
      method: 'POST',
      signed: true,
    });
  }

  /** Verilen varlıkları BNB'ye dönüştürür (asset paramı tekrarlı imzalanır). */
  async dustTransfer(assets: string[]): Promise<DustTransferResponse> {
    if (!this.env.BINANCE_API_KEY || !this.env.BINANCE_API_SECRET) {
      throw new BinanceApiError('Missing BINANCE_API_KEY or BINANCE_API_SECRET', undefined, 401);
    }
    const pairs: Array<[string, string]> = [
      ...assets.map((a) => ['asset', a] as [string, string]),
      ['timestamp', String(Date.now())],
      ['recvWindow', '5000'],
    ];
    const query = new URLSearchParams(pairs).toString();
    const signature = await signRequest(query, this.env.BINANCE_API_SECRET);
    // Proxy forward body taşımadığından imzalı sorguyu URL'e koyup boş gövde ile POST ediyoruz.
    const url = `${this.baseUrl}/sapi/v1/asset/dust?${query}&signature=${signature}`;
    const res = await fetchBinance(this.env, url, {
      method: 'POST',
      headers: {
        'X-MBX-APIKEY': this.env.BINANCE_API_KEY,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });
    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new BinanceApiError(`Invalid JSON from Binance: ${text.slice(0, 200)}`, undefined, res.status);
    }
    const err = data as { code?: number; msg?: string };
    if (!res.ok || (typeof err.code === 'number' && err.code < 0)) {
      throw new BinanceApiError(err.msg ?? res.statusText, err.code, res.status);
    }
    return data as DustTransferResponse;
  }
}
