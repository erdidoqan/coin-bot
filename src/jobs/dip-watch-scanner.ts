import { BinanceClient } from '../exchange/binance';
import {
  getDipWatchFundamentalsMap,
  getDipWatchListingMap,
  listingAgeDays,
  lookupFundamentals,
} from '../exchange/dip-watch-meta-cache';
import type { DipWatchQualityConfig } from '../strategy/dip-watch-quality';
import {
  evaluateDipWatchQuality,
  quoteDepthWithinBand,
  spreadPctFromBookTicker,
  volMcapRatio,
} from '../strategy/dip-watch-quality';
import {
  buildDipScannerRows,
  type DipWatchScannerRow,
  type DipWatchTickerInput,
} from '../strategy/dip-watch';

export interface DipWatchQualitySummary {
  enabled: boolean;
  poolBefore: number;
  poolAfter: number;
  rejected: Partial<Record<string, number>>;
}

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let i = 0;
  async function worker(): Promise<void> {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]!);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

export async function buildQualityFilteredScanner(
  env: Env,
  poolInputs: DipWatchTickerInput[],
  quality: DipWatchQualityConfig,
  scanPoolSize: number,
  minQuoteVolumeUsdt: number,
): Promise<{ scanner: DipWatchScannerRow[]; qualitySummary: DipWatchQualitySummary }> {
  const rejected: Partial<Record<string, number>> = {};
  const bump = (reason: string) => {
    rejected[reason] = (rejected[reason] ?? 0) + 1;
  };

  if (!quality.enabled) {
    return {
      scanner: buildDipScannerRows(poolInputs, minQuoteVolumeUsdt, scanPoolSize),
      qualitySummary: {
        enabled: false,
        poolBefore: poolInputs.length,
        poolAfter: poolInputs.length,
        rejected: {},
      },
    };
  }

  const [listingMap, fundamentalsMap, books] = await Promise.all([
    getDipWatchListingMap(env),
    getDipWatchFundamentalsMap(),
    new BinanceClient(env).getBookTicker(),
  ]);
  const bookMap = new Map(books.map((b) => [b.symbol, b]));

  const afterCheap: DipWatchTickerInput[] = [];
  const metaBySymbol = new Map<
    string,
    {
      spreadPct: number | null;
      onboardMs: number | null;
      marketCapUsd: number | null;
      fdvUsd: number | null;
      circulatingSupply: number | null;
      maxSupply: number | null;
      volMcap: number | null;
      listingDays: number | null;
    }
  >();

  for (const t of poolInputs) {
    const book = bookMap.get(t.symbol);
    const spreadPct = book ? spreadPctFromBookTicker(book) : null;
    const onboardMs = listingMap.get(t.symbol) ?? null;
    const fund = lookupFundamentals(t.symbol, fundamentalsMap);
    const marketCapUsd = fund?.marketCapUsd ?? null;
    const volMcap = marketCapUsd != null ? volMcapRatio(t.quoteVolume, marketCapUsd) : null;

    const cheap = evaluateDipWatchQuality({
      cfg: quality,
      spreadPct,
      bidDepthUsdt: 0,
      askDepthUsdt: 0,
      onboardMs,
      quoteVolume24h: t.quoteVolume,
      marketCapUsd,
      circulatingSupply: fund?.circulatingSupply ?? null,
      maxSupply: fund?.maxSupply ?? null,
      fdvUsd: fund?.fdvUsd ?? null,
      skipDepthCheck: true,
    });

    if (!cheap.pass) {
      if (cheap.reason) bump(cheap.reason);
      continue;
    }

    metaBySymbol.set(t.symbol, {
      spreadPct,
      onboardMs,
      marketCapUsd,
      fdvUsd: fund?.fdvUsd ?? null,
      circulatingSupply: fund?.circulatingSupply ?? null,
      maxSupply: fund?.maxSupply ?? null,
      volMcap,
      listingDays: listingAgeDays(onboardMs),
    });
    afterCheap.push(t);
  }

  const client = new BinanceClient(env);
  const depthResults = await mapConcurrent(afterCheap, 8, async (t) => {
    const book = bookMap.get(t.symbol);
    const bid = Number(book?.bidPrice);
    const ask = Number(book?.askPrice);
    const mid =
      bid > 0 && ask > 0 ? (bid + ask) / 2 : t.lastPrice > 0 ? t.lastPrice : 0;
    if (!(mid > 0)) return { symbol: t.symbol, pass: false, reason: 'depth' as const };

    try {
      const depth = await client.getDepth(t.symbol, 100);
      const { bidQuoteUsdt, askQuoteUsdt } = quoteDepthWithinBand(
        mid,
        depth.bids,
        depth.asks,
        quality.depthBandPct,
      );
      const depthEval = evaluateDipWatchQuality({
        cfg: quality,
        spreadPct: metaBySymbol.get(t.symbol)?.spreadPct ?? null,
        bidDepthUsdt: bidQuoteUsdt,
        askDepthUsdt: askQuoteUsdt,
        onboardMs: metaBySymbol.get(t.symbol)?.onboardMs ?? null,
        quoteVolume24h: t.quoteVolume,
        marketCapUsd: metaBySymbol.get(t.symbol)?.marketCapUsd ?? null,
        circulatingSupply: metaBySymbol.get(t.symbol)?.circulatingSupply ?? null,
        maxSupply: metaBySymbol.get(t.symbol)?.maxSupply ?? null,
        fdvUsd: metaBySymbol.get(t.symbol)?.fdvUsd ?? null,
      });
      return { symbol: t.symbol, pass: depthEval.pass, reason: depthEval.reason };
    } catch {
      return { symbol: t.symbol, pass: true };
    }
  });

  const depthPass = new Set(
    depthResults.filter((r) => r.pass).map((r) => r.symbol),
  );
  for (const r of depthResults) {
    if (!r.pass && r.reason) bump(r.reason);
  }

  const afterDepth = afterCheap.filter((t) => depthPass.has(t.symbol));
  const rows = buildDipScannerRows(afterDepth, minQuoteVolumeUsdt, scanPoolSize).map((row) => {
    const meta = metaBySymbol.get(row.symbol);
    return {
      ...row,
      spreadPct: meta?.spreadPct ?? null,
      volMcapRatio: meta?.volMcap ?? null,
      listingDays: meta?.listingDays ?? null,
    };
  });

  return {
    scanner: rows,
    qualitySummary: {
      enabled: true,
      poolBefore: poolInputs.length,
      poolAfter: rows.length,
      rejected,
    },
  };
}
