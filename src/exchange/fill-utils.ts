import type { OrderFill, OrderResponse } from './binance';
import { bn, subtract, sum } from '../math/decimal';

export interface NetQtyResult {
  net_base_qty: string;
  gross_base_qty: string;
  commission_in_base: boolean;
  commission_base_total: string;
}

export function computeNetBaseQty(order: OrderResponse, baseAsset: string): NetQtyResult {
  const fills = order.fills ?? [];
  if (fills.length === 0) {
    const executed = order.executedQty ?? '0';
    return {
      net_base_qty: executed,
      gross_base_qty: executed,
      commission_in_base: false,
      commission_base_total: '0',
    };
  }

  let gross = bn(0);
  let commissionBase = bn(0);
  let commissionInBase = false;

  for (const fill of fills) {
    gross = gross.plus(fill.qty);
    if (fill.commissionAsset === baseAsset && bn(fill.commission).gt(0)) {
      commissionInBase = true;
      commissionBase = commissionBase.plus(fill.commission);
    }
  }

  const grossStr = gross.toFixed();
  const net = commissionInBase ? subtract(grossStr, commissionBase.toFixed()) : grossStr;

  return {
    net_base_qty: net,
    gross_base_qty: grossStr,
    commission_in_base: commissionInBase,
    commission_base_total: commissionBase.toFixed(),
  };
}

export function mockFillsFromOrder(
  symbol: string,
  executedQty: string,
  quoteSpent: string,
  baseAsset: string,
  useBnbCommission = true,
): OrderFill[] {
  const price = bn(quoteSpent).dividedBy(executedQty).toFixed(8);
  if (useBnbCommission) {
    return [
      {
        price,
        qty: executedQty,
        commission: '0',
        commissionAsset: 'BNB',
      },
    ];
  }
  const commission = bn(executedQty).times('0.001').toFixed(8);
  return [
    {
      price,
      qty: executedQty,
      commission,
      commissionAsset: baseAsset,
    },
  ];
}

export function baseAssetFromSymbol(symbol: string): string {
  if (symbol.endsWith('USDT')) return symbol.slice(0, -4);
  return symbol;
}
