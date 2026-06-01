import {
  BinanceClient,
  type OcoOrderResponse,
  type OrderResponse,
} from './binance';
import { initMockTrailingTiered } from '../db/mock-sim';
import { logEvent } from '../db/trade-log';
import { computeNetBaseQty, mockFillsFromOrder, baseAssetFromSymbol } from './fill-utils';
import { MOCK_ORDER_ID_MIN } from './mock-order-id';
import { simulateMockActiveOrder, simulateMockTrailingOrder } from './mock-trailing';
import { bn } from '../math/decimal';

let mockOrderSeq = MOCK_ORDER_ID_MIN;

export interface TieredTrailingOrderParams {
  stopPrice: string;
  trailingDeltaBips: number;
}

export interface ScalpOcoOrderResult {
  orderListId: number;
  takeProfitOrderId: number;
  stopLossOrderId: number;
}

export class TradingGateway {
  private readonly client: BinanceClient;

  constructor(private readonly env: Env) {
    this.client = new BinanceClient(env);
  }

  get binance(): BinanceClient {
    return this.client;
  }

  private get tradingEnabled(): boolean {
    return String(this.env.TRADING_ENABLED) === 'true';
  }

  async marketBuy(symbol: string, quoteOrderQty: string): Promise<OrderResponse> {
    const params = {
      symbol,
      side: 'BUY',
      type: 'MARKET',
      quoteOrderQty,
    };
    if (!this.tradingEnabled) {
      return this.mockMarketBuy(symbol, quoteOrderQty, params);
    }
    return this.client.placeOrder(params);
  }

  async marketSell(symbol: string, quantity: string): Promise<OrderResponse> {
    const params = {
      symbol,
      side: 'SELL',
      type: 'MARKET',
      quantity,
    };
    if (!this.tradingEnabled) {
      return this.mockMarketSell(symbol, quantity, params);
    }
    return this.client.placeOrder(params);
  }

  async placeLimitMakerBuy(
    symbol: string,
    quantity: string,
    price: string,
  ): Promise<OrderResponse> {
    const params = {
      symbol,
      side: 'BUY',
      type: 'LIMIT_MAKER',
      quantity,
      price,
      newOrderRespType: 'RESULT',
    };
    if (!this.tradingEnabled) {
      return this.mockMarketBuy(symbol, bn(quantity).times(price).toFixed(8), params);
    }
    return this.client.placeOrder(params);
  }

  async placeTrailingStop(
    symbol: string,
    quantity: string,
    tiered: TieredTrailingOrderParams,
  ): Promise<OrderResponse> {
    const params = {
      symbol,
      side: 'SELL',
      type: 'TAKE_PROFIT',
      quantity,
      stopPrice: tiered.stopPrice,
      trailingDelta: String(tiered.trailingDeltaBips),
    };
    if (!this.tradingEnabled) {
      return this.mockTrailingStop(symbol, quantity, {
        ...params,
        trailingDeltaBips: tiered.trailingDeltaBips,
      });
    }
    return this.client.placeOrder(params);
  }

  /** Grid: LIMIT_MAKER emir (alış veya satış). Mock'ta sadece kaydeder. */
  async placeGridLimit(
    symbol: string,
    side: 'BUY' | 'SELL',
    quantity: string,
    price: string,
  ): Promise<OrderResponse> {
    const params = {
      symbol,
      side,
      type: 'LIMIT_MAKER',
      quantity,
      price,
      newOrderRespType: 'RESULT',
    };
    if (!this.tradingEnabled) {
      const orderId = ++mockOrderSeq;
      const order: OrderResponse = {
        symbol,
        orderId,
        status: 'NEW',
        executedQty: '0',
        cummulativeQuoteQty: '0',
        side,
        type: 'LIMIT_MAKER',
      };
      await logEvent(this.env.DB, 'MOCK_ORDER', { action: 'gridLimit', params, order });
      return order;
    }
    return this.client.placeOrder(params);
  }

  async placeScalpOcoExit(
    symbol: string,
    quantity: string,
    takeProfitLimitPrice: string,
    stopLossStopPrice: string,
    stopLossLimitPrice: string,
  ): Promise<ScalpOcoOrderResult | null> {
    const params = {
      symbol,
      side: 'SELL',
      quantity,
      aboveType: 'LIMIT_MAKER',
      abovePrice: takeProfitLimitPrice,
      belowType: 'STOP_LOSS_LIMIT',
      belowStopPrice: stopLossStopPrice,
      belowPrice: stopLossLimitPrice,
      belowTimeInForce: 'GTC',
      newOrderRespType: 'RESULT',
    };
    if (!this.tradingEnabled) {
      await logEvent(this.env.DB, 'MOCK_ORDER', {
        action: 'scalpOcoExit',
        params,
        note: 'Dry-run: tick scalp limit OCO koruması simüle edilir (borsaya gönderilmez)',
      });
      return null;
    }
    const oco = await this.client.placeOrderListOco(params);
    const ids = extractScalpOcoOrderIds(oco);
    if (!ids) {
      throw new Error(`OCO order IDs missing for ${symbol}`);
    }
    return {
      orderListId: oco.orderListId,
      takeProfitOrderId: ids.takeProfitOrderId,
      stopLossOrderId: ids.stopLossOrderId,
    };
  }

  async cancelTrailingOrder(symbol: string, orderId: string | number): Promise<void> {
    if (!this.tradingEnabled) {
      await logEvent(this.env.DB, 'MOCK_ORDER', {
        action: 'cancelOrder',
        params: { symbol, orderId: String(orderId) },
      });
      return;
    }
    await this.client.cancelOrder(symbol, orderId);
  }

  async cancelOrder(symbol: string, orderId: string | number): Promise<void> {
    if (!this.tradingEnabled) return;
    await this.client.cancelOrder(symbol, orderId);
  }

  private async resolveOrderMock(symbol: string, orderId: string | number): Promise<OrderResponse> {
      const lastPrice = await this.fetchLastPrice(symbol);
      const id = Number(orderId);
      const trailing = await simulateMockTrailingOrder(this.env, symbol, id, lastPrice);
      if (trailing) return trailing;
      const active = await simulateMockActiveOrder(this.env, symbol, id, lastPrice);
      if (active) return active;
      return {
        symbol,
        orderId: id,
        status: 'NEW',
        executedQty: '0',
        cummulativeQuoteQty: '0',
      };
  }

  async getOrder(symbol: string, orderId: string | number): Promise<OrderResponse> {
    if (!this.tradingEnabled) {
      return this.resolveOrderMock(symbol, orderId);
    }
    return this.client.getOrder(symbol, orderId);
  }

  private async fetchLastPrice(symbol: string): Promise<string> {
    const tickers = await this.client.getTicker24hr();
    const t = tickers.find((x) => x.symbol === symbol);
    return t?.lastPrice ?? '0';
  }

  private async mockMarketBuy(
    symbol: string,
    quoteOrderQty: string,
    params: Record<string, string>,
  ): Promise<OrderResponse> {
    const tickers = await this.client.getTicker24hr();
    const t = tickers.find((x) => x.symbol === symbol);
    const price = t?.lastPrice ?? '1';
    const executedQty = bn(quoteOrderQty).dividedBy(price).toFixed(8);
    const baseAsset = baseAssetFromSymbol(symbol);
    const orderId = ++mockOrderSeq;
    const fills = mockFillsFromOrder(symbol, executedQty, quoteOrderQty, baseAsset, true);

    const order: OrderResponse = {
      symbol,
      orderId,
      status: 'FILLED',
      executedQty,
      cummulativeQuoteQty: quoteOrderQty,
      side: 'BUY',
      type: 'MARKET',
      fills,
    };

    await logEvent(this.env.DB, 'MOCK_ORDER', { action: 'marketBuy', params, order });
    return order;
  }

  private async mockMarketSell(
    symbol: string,
    quantity: string,
    params: Record<string, string>,
  ): Promise<OrderResponse> {
    const tickers = await this.client.getTicker24hr();
    const t = tickers.find((x) => x.symbol === symbol);
    const price = t?.lastPrice ?? '1';
    const proceeds = bn(quantity).times(price).toFixed(8);
    const orderId = ++mockOrderSeq;

    const order: OrderResponse = {
      symbol,
      orderId,
      status: 'FILLED',
      executedQty: quantity,
      cummulativeQuoteQty: proceeds,
      side: 'SELL',
      type: 'MARKET',
    };

    await logEvent(this.env.DB, 'MOCK_ORDER', { action: 'marketSell', params, order });
    return order;
  }

  private async mockTrailingStop(
    symbol: string,
    quantity: string,
    params: Record<string, string | number>,
  ): Promise<OrderResponse> {
    const stopPrice = String(params.stopPrice ?? '0');
    await initMockTrailingTiered(this.env.DB, stopPrice);

    const orderId = ++mockOrderSeq;
    const order: OrderResponse = {
      symbol,
      orderId,
      status: 'NEW',
      executedQty: '0',
      cummulativeQuoteQty: '0',
      side: 'SELL',
      type: 'TAKE_PROFIT',
    };
    await logEvent(this.env.DB, 'MOCK_ORDER', {
      action: 'trailingStop',
      params,
      order,
      activationStop: stopPrice,
      note: 'Dry-run: TAKE_PROFIT+stopPrice+trailingDelta (uyku → aktivasyon → dar takip)',
    });
    return order;
  }
}

export function netQtyFromBuy(order: OrderResponse, symbol: string) {
  const baseAsset = baseAssetFromSymbol(symbol);
  return computeNetBaseQty(order, baseAsset);
}

function extractScalpOcoOrderIds(oco: OcoOrderResponse): {
  takeProfitOrderId: number;
  stopLossOrderId: number;
} | null {
  let takeProfitOrderId: number | null = null;
  let stopLossOrderId: number | null = null;

  for (const report of oco.orderReports ?? []) {
    if (report.type === 'LIMIT_MAKER' || report.type?.startsWith('TAKE_PROFIT')) {
      takeProfitOrderId = report.orderId;
    } else if (report.type?.startsWith('STOP_LOSS')) {
      stopLossOrderId = report.orderId;
    }
  }

  if (takeProfitOrderId != null && stopLossOrderId != null) {
    return { takeProfitOrderId, stopLossOrderId };
  }
  return null;
}
