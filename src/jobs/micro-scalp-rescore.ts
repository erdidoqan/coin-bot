import { getMicroScalpConfig } from '../db/bot-config';
import {
  fetchKlinesFromDo,
  fetchOrderbookMetrics,
} from '../exchange/market-data-client';
import type { TradingGateway } from '../exchange/gateway';
import {
  buildMicroScalpScoreConfig,
  computeMicroScalpScore,
} from '../indicators/micro-scalp';

export async function rescoreSymbolMicro(
  env: Env,
  _gateway: TradingGateway,
  symbol: string,
): Promise<{ score: string; failReason: string | null } | null> {
  const micro = await getMicroScalpConfig(env.DB, env);

  try {
    const klines1m = await fetchKlinesFromDo(env, symbol, '1m', 35);
    if (!klines1m || klines1m.length < 10) return null;

    const klines5m = micro.phase2Enabled
      ? await fetchKlinesFromDo(env, symbol, '5m', 30)
      : undefined;
    const klines15m = micro.phase2Enabled
      ? await fetchKlinesFromDo(env, symbol, '15m', 30)
      : undefined;

    const orderbook = await fetchOrderbookMetrics(env, symbol);

    const result = computeMicroScalpScore({
      klines1m,
      klines5m: klines5m ?? undefined,
      klines15m: klines15m ?? undefined,
      orderbook,
      depth: null,
      config: buildMicroScalpScoreConfig(micro),
      skipOpenCandleGate: true,
    });
    return { score: result.score, failReason: result.failReason };
  } catch {
    return null;
  }
}
