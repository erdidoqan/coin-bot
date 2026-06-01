import { getMicroScalpConfig, getMicroShadowConfig } from '../db/bot-config';
import { hasRecentPendingShadow, insertShadowSetup } from '../db/micro-shadow';
import { fetchSymbolMidPrice } from '../exchange/market-data-client';
import { wouldPassScoreOnly } from '../indicators/micro-shadow';
import { bn } from '../math/decimal';

export interface ShadowScanCandidate {
  symbol: string;
  score: string;
  pass: boolean;
  failReason: string | null;
  regime: string | null;
  trend15mOk: boolean;
  regimeAllowed: boolean;
  volumeRatio: string;
  aggressionRatio: string;
  klineClose: string | null;
}

export async function recordShadowSetupsFromScan(
  env: Env,
  candidates: ShadowScanCandidate[],
): Promise<number> {
  const [shadow, micro] = await Promise.all([
    getMicroShadowConfig(env.DB, env),
    getMicroScalpConfig(env.DB, env),
  ]);
  if (!shadow.enabled || candidates.length === 0) return 0;

  const nowMs = Date.now();
  let inserted = 0;

  for (const c of candidates) {
    if (c.pass) continue;
    const scoreNum = Number(c.score);
    if (!Number.isFinite(scoreNum) || scoreNum < shadow.minScore) continue;

    if (await hasRecentPendingShadow(env.DB, c.symbol, shadow.dedupeMinutes, nowMs)) {
      continue;
    }

    let ref = await fetchSymbolMidPrice(env, c.symbol);
    if (!ref || !bn(ref).gt(0)) ref = c.klineClose;
    if (!ref || !bn(ref).gt(0)) continue;

    await insertShadowSetup(env.DB, {
      symbol: c.symbol,
      recordedAtMs: nowMs,
      entryRefPrice: ref,
      score: c.score,
      microOk: false,
      pass: false,
      failReason: c.failReason,
      regime: c.regime,
      trend15mOk: c.trend15mOk,
      regimeAllowed: c.regimeAllowed,
      wouldPassScoreOnly: wouldPassScoreOnly(scoreNum, micro.entryMinScore, c.regimeAllowed),
      volumeRatio: c.volumeRatio,
      aggressionRatio: c.aggressionRatio,
    });
    inserted++;
  }

  return inserted;
}
