import {
  getConfig,
  getMicroScalpConfig,
  setConfig,
  isMicroScalpEnabled,
} from '../db/bot-config';
import { listWatchlist, updateWatchlistMicroScalp } from '../db/watchlist';
import { logEvent } from '../db/trade-log';
import type { TradingGateway } from '../exchange/gateway';
import {
  buildMicroScalpScoreConfig,
  computeMicroScalpScore,
} from '../indicators/micro-scalp';
import { regimeAllowsEntry } from '../indicators/market-regime';
import { setRegimeCache, getRegimeCache } from '../db/trade-features';
import {
  buildWatchlistMetricDeltas,
  parsePrevFromMicroDetail,
} from '../indicators/metric-delta';
import {
  ensureMarketDataWatchlist,
  fetchKlinesFromDo,
  fetchOrderbookMetrics,
  fetchRegimeFromDo,
} from '../exchange/market-data-client';
import {
  recordShadowSetupsFromScan,
  type ShadowScanCandidate,
} from './micro-shadow-record';

const SCAN_CURSOR_KEY = 'micro_scan_cursor' as const;

export async function runMicroScalpScan(env: Env, _gateway: TradingGateway): Promise<void> {
  if (!(await isMicroScalpEnabled(env.DB, env))) return;

  const micro = await getMicroScalpConfig(env.DB, env);
  const watchlist = await listWatchlist(env.DB);
  if (watchlist.length === 0) return;

  const symbols = watchlist.map((w) => w.symbol);
  const scoreConfig = buildMicroScalpScoreConfig(micro);

  await ensureMarketDataWatchlist(env, symbols, scoreConfig);

  const cursor = Number(await getConfig(env.DB, SCAN_CURSOR_KEY, env)) || 0;
  const batch: string[] = [];
  for (let i = 0; i < micro.scanBatchSize && i < symbols.length; i++) {
    batch.push(symbols[(cursor + i) % symbols.length]!);
  }
  const nextCursor = symbols.length > 0 ? (cursor + micro.scanBatchSize) % symbols.length : 0;
  await setConfig(env.DB, SCAN_CURSOR_KEY, String(nextCursor));

  if (micro.phase3Enabled && cursor === 0) {
    try {
      const regime = await fetchRegimeFromDo(env, symbols);
      if (regime) {
        await setRegimeCache(env.DB, regime.regime, regime.detail);
        await logEvent(env.DB, 'MARKET_REGIME', {
          regime: regime.regime,
          btcAtrPct: regime.btcAtrPct,
          breadthPct: regime.breadthPct,
          detail: regime.detail,
        });
      }
    } catch (err) {
      await logEvent(env.DB, 'MARKET_REGIME_SKIP', {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const { regime } = await getRegimeCache(env.DB);
  const regimeGate = regimeAllowsEntry(regime as 'trend' | 'chop' | 'panic' | 'low_liquidity', micro.phase3Enabled);

  const updates: Array<{
    symbol: string;
    micro_ok: boolean;
    micro_score: string;
    micro_detail: string;
  }> = [];
  const shadowCandidates: ShadowScanCandidate[] = [];

  for (const symbol of batch) {
    try {
      const klines1m = await fetchKlinesFromDo(env, symbol, '1m', 35);
      const klines5m = micro.phase2Enabled
        ? await fetchKlinesFromDo(env, symbol, '5m', 30)
        : undefined;
      const klines15m = micro.phase2Enabled
        ? await fetchKlinesFromDo(env, symbol, '15m', 30)
        : undefined;

      if (!klines1m || klines1m.length < 10) {
        updates.push({
          symbol,
          micro_ok: false,
          micro_score: '0',
          micro_detail: JSON.stringify({ failReason: 'klines_not_ready', regime }),
        });
        continue;
      }

      const orderbook = await fetchOrderbookMetrics(env, symbol);

      const result = computeMicroScalpScore({
        klines1m,
        klines5m: klines5m ?? undefined,
        klines15m: klines15m ?? undefined,
        orderbook,
        depth: null,
        config: scoreConfig,
        skipOpenCandleGate: true,
      });

      let pass = result.pass && regimeGate.allowed;
      const failReasons: string[] = [];
      if (result.failReason) failReasons.push(result.failReason);
      if (!regimeGate.allowed) {
        pass = false;
        const regimeReason = regimeGate.reason ?? 'regime_block';
        if (!failReasons.includes(regimeReason)) failReasons.push(regimeReason);
      }
      const failReason = failReasons[0] ?? null;

      const prevEntry = watchlist.find((w) => w.symbol === symbol);
      const prevSnap = parsePrevFromMicroDetail(prevEntry?.micro_detail ?? null);
      const obCurr = result.components?.orderbookRatio;
      const deltas = buildWatchlistMetricDeltas({
        prevScore: prevEntry?.micro_score ?? prevSnap.score,
        prevVolumeRatio: prevSnap.volumeRatio,
        prevAggressionRatio: prevSnap.aggressionRatio,
        prevOrderbook: prevSnap.orderbook,
        score: result.score,
        volumeRatio: result.volumeRatio,
        aggressionRatio: result.aggressionRatio,
        orderbook: obCurr != null ? Number(obCurr) : null,
      });

      updates.push({
        symbol,
        micro_ok: pass,
        micro_score: result.score,
        micro_detail: JSON.stringify({
          score: result.score,
          pass,
          failReason,
          regime,
          components: result.components,
          gates: result.gates,
          volumeRatio: result.volumeRatio,
          tradeCountRatio: result.tradeCountRatio,
          aggressionRatio: result.aggressionRatio,
          atrPct1m: result.atrPct1m,
          source: 'ws_do',
          deltas,
          deltaSince: prevEntry?.micro_checked_at ?? null,
        }),
      });

      if (!pass) {
        const klineClose = klines1m[klines1m.length - 1]?.close ?? null;
        shadowCandidates.push({
          symbol,
          score: result.score,
          pass: false,
          failReason,
          regime: regime ?? null,
          trend15mOk: result.gates.trend15mOk,
          regimeAllowed: regimeGate.allowed,
          volumeRatio: result.volumeRatio,
          aggressionRatio: result.aggressionRatio,
          klineClose,
        });
      }

      if (pass) {
        await logEvent(env.DB, 'MICRO_SCORE_PASS', {
          symbol,
          score: result.score,
          volumeRatio: result.volumeRatio,
          aggressionRatio: result.aggressionRatio,
        });
      }
    } catch (err) {
      updates.push({
        symbol,
        micro_ok: false,
        micro_score: '0',
        micro_detail: JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        }),
      });
    }
  }

  await updateWatchlistMicroScalp(env.DB, updates);
  const shadowInserted = await recordShadowSetupsFromScan(env, shadowCandidates);

  const ranked = [...watchlist]
    .map((w) => {
      const u = updates.find((x) => x.symbol === w.symbol);
      return {
        symbol: w.symbol,
        micro_score: u?.micro_score ?? w.micro_score ?? '0',
        micro_ok: u?.micro_ok ?? w.micro_ok === 1,
      };
    })
    .sort((a, b) => Number(b.micro_score) - Number(a.micro_score));

  await logEvent(env.DB, 'MICRO_SCORE_SCAN', {
    batchScanned: batch,
    scanCursor: cursor,
    nextCursor,
    regime,
    regimeAllowsEntry: regimeGate.allowed,
    best: ranked[0] ?? null,
    rankings: ranked.slice(0, 10),
    shadowRecorded: shadowInserted,
  });
}
