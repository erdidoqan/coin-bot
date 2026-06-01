import type { TickScalpConfig } from '../db/bot-config';
import type { SyncMarketDataOptions } from '../exchange/market-data-client';
import { defaultTickReversalConfig } from '../indicators/tick-reversal';

export function tickReversalConfigFromScalp(tick: TickScalpConfig) {
  return {
    ...defaultTickReversalConfig(),
    recoveryMinPct: tick.recoveryMinPct,
    minSecAfterTrough: tick.minSecAfterTrough,
    maxSecAfterTrough: tick.maxSecAfterTrough,
    requireSpreadTightening: tick.requireSpreadTightening,
    obRatioAtRecoveryMin: tick.obRatioAtRecoveryMin,
    midSlopeSampleCount: tick.midSlopeSampleCount,
    midSlopeMinRising: tick.midSlopeMinRising,
    noNewLowSec: tick.noNewLowSec,
    feeRoundtripPct: tick.feeRoundtripPct,
    recoveryFeeMarginPct: tick.recoveryFeeMarginPct,
  };
}

export function buildTickMarketDataSync(tick: TickScalpConfig): SyncMarketDataOptions {
  return {
    tickEntryConfig: {
      minGainPct: tick.entryGainPct,
      maxGainPct: tick.entryGainMaxPct,
      minOrderbookRatio: tick.orderbookRatioMin,
      maxSpreadPct: tick.maxSpreadPct,
      maxObAgeMs: tick.maxObAgeMs,
      requireOpenCandle: true,
      require5mAlignment: tick.require5mAlignment,
      require5mLight: tick.require5mLight,
      useWsLowForGainBand: true,
    },
    tickDeclineConfig: {
      referenceWindowSec: tick.referenceWindowSec,
      minDeclinePct: tick.declineMinPct,
      requireWsDecline: tick.requireWsDecline,
    },
    tickReversalConfig: tickReversalConfigFromScalp(tick),
    tickAggFlowConfig: {
      enabled: tick.aggBurstEnabled,
      windowSec: tick.aggWindowSec,
      buyCountMin: tick.aggBuyCountMin,
      buyQuoteMinUsdt: tick.aggBuyQuoteMinUsdt,
      imbalanceMin: tick.aggImbalanceMin,
    },
  };
}
