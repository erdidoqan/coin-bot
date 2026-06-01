import { bn } from '../math/decimal';

export interface TickAggFlowConfig {
  enabled: boolean;
  windowSec: number;
  buyCountMin: number;
  buyQuoteMinUsdt: string;
  imbalanceMin: string;
}

export interface AggFlowSample {
  t: number;
  quoteUsdt: number;
  aggressiveBuy: boolean;
}

export interface TickAggFlowEvaluation {
  ok: boolean;
  failReason: string | null;
  buyCount: number;
  buyQuoteUsdt: string;
  sellQuoteUsdt: string;
  imbalance: string;
}

export function defaultTickAggFlowConfig(): TickAggFlowConfig {
  return {
    enabled: true,
    windowSec: 10,
    buyCountMin: 12,
    buyQuoteMinUsdt: '300000',
    imbalanceMin: '0.10',
  };
}

export function appendAggFlowSample(
  samples: AggFlowSample[],
  sample: AggFlowSample,
  maxRetentionMs: number,
): AggFlowSample[] {
  if (!Number.isFinite(sample.quoteUsdt) || sample.quoteUsdt <= 0) return samples;
  const next = [...samples, sample];
  const cutoff = sample.t - maxRetentionMs;
  return next.filter((s) => s.t >= cutoff);
}

export function evaluateTickAggFlow(
  samples: AggFlowSample[],
  config: TickAggFlowConfig,
  nowMs = Date.now(),
): TickAggFlowEvaluation {
  const empty: TickAggFlowEvaluation = {
    ok: !config.enabled,
    failReason: null,
    buyCount: 0,
    buyQuoteUsdt: '0',
    sellQuoteUsdt: '0',
    imbalance: '0',
  };
  if (!config.enabled) return empty;

  const windowMs = Math.max(1000, config.windowSec * 1000);
  const inWindow = samples.filter((s) => nowMs - s.t <= windowMs);
  if (inWindow.length === 0) {
    return { ...empty, ok: false, failReason: 'no_agg_samples' };
  }

  let buyCount = 0;
  let buyQuote = bn(0);
  let sellQuote = bn(0);
  for (const sample of inWindow) {
    if (sample.aggressiveBuy) {
      buyCount += 1;
      buyQuote = buyQuote.plus(sample.quoteUsdt);
    } else {
      sellQuote = sellQuote.plus(sample.quoteUsdt);
    }
  }

  const total = buyQuote.plus(sellQuote);
  const imbalance = total.gt(0)
    ? buyQuote.minus(sellQuote).dividedBy(total).toFixed(4)
    : '0';

  if (buyCount < config.buyCountMin) {
    return {
      ok: false,
      failReason: 'agg_buy_count_low',
      buyCount,
      buyQuoteUsdt: buyQuote.toFixed(2),
      sellQuoteUsdt: sellQuote.toFixed(2),
      imbalance,
    };
  }
  if (buyQuote.lt(config.buyQuoteMinUsdt)) {
    return {
      ok: false,
      failReason: 'agg_buy_quote_low',
      buyCount,
      buyQuoteUsdt: buyQuote.toFixed(2),
      sellQuoteUsdt: sellQuote.toFixed(2),
      imbalance,
    };
  }
  if (bn(imbalance).lt(config.imbalanceMin)) {
    return {
      ok: false,
      failReason: 'agg_imbalance_low',
      buyCount,
      buyQuoteUsdt: buyQuote.toFixed(2),
      sellQuoteUsdt: sellQuote.toFixed(2),
      imbalance,
    };
  }

  return {
    ok: true,
    failReason: null,
    buyCount,
    buyQuoteUsdt: buyQuote.toFixed(2),
    sellQuoteUsdt: sellQuote.toFixed(2),
    imbalance,
  };
}
