import type { BinanceClient, Kline } from '../exchange/binance';
import { fetchKlinesFromDo } from '../exchange/market-data-client';
import { bn } from '../math/decimal';

function windowGainPct(klines: Kline[]): string | null {
  if (klines.length === 0) return null;
  const first = klines[0]!;
  const last = klines[klines.length - 1]!;
  const open = bn(first.open);
  if (open.isZero()) return null;
  return bn(last.close).minus(open).dividedBy(open).times(100).toFixed(4);
}

/** Son 15m (2×15m mum) lineer artış pump mu? */
export async function isLate15mPump(
  client: BinanceClient,
  symbol: string,
  maxPumpPct: string,
  env?: Env,
): Promise<{ pumped: boolean; gainPct: string | null }> {
  let klines: Kline[] | null = null;
  if (env?.MARKET_DATA) {
    klines = await fetchKlinesFromDo(env, symbol, '15m', 2);
  }
  if (!klines || klines.length < 2) {
    klines = await client.getKlines(symbol, '15m', 2);
  }
  const gain = windowGainPct(klines);
  if (gain === null) return { pumped: false, gainPct: null };
  return {
    pumped: bn(gain).gt(maxPumpPct),
    gainPct: gain,
  };
}
