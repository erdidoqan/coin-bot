/**
 * Dip Reversal — rejim moduna göre dinamik alım tutarı (USDT).
 *
 * Sıra (kötü→iyi): grind tighten → downtrend_volatile → volatile → normal → calm
 * Adapt kapalıyken config buyQuoteUsdt; manuel panel alımı sabit 20 USDT.
 */
import type { DipReversalAdaptConfig } from '../db/dip-reversal';
import type { DipReversalMode } from './dip-reversal-adapt';

export const DIP_MANUAL_BUY_QUOTE_USDT = '20';

const ADAPT_MODE_QUOTE_USDT: Record<DipReversalMode, string> = {
  downtrend_grind: '30',
  downtrend_volatile: '40',
  volatile: '50',
  normal: '60',
  calm: '70',
};

export interface ResolveDipBuyQuoteOpts {
  manual?: boolean;
  adaptEnabled?: boolean;
  adaptMode?: DipReversalMode | null;
  /** Config taban tutarı (adapt kapalı veya mod yok). */
  baseQuoteUsdt: string;
}

export function resolveDipBuyQuoteUsdt(opts: ResolveDipBuyQuoteOpts): string {
  if (opts.manual) return DIP_MANUAL_BUY_QUOTE_USDT;
  if (opts.adaptEnabled && opts.adaptMode) {
    return ADAPT_MODE_QUOTE_USDT[opts.adaptMode];
  }
  return opts.baseQuoteUsdt;
}

export function resolveDipBuyQuoteFromConfig(
  baseQuoteUsdt: string,
  adapt: DipReversalAdaptConfig,
  adaptMode: DipReversalMode | null | undefined,
  manual?: boolean,
): string {
  return resolveDipBuyQuoteUsdt({
    manual,
    adaptEnabled: adapt.enabled,
    adaptMode: adaptMode ?? null,
    baseQuoteUsdt,
  });
}
