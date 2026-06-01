import { getTickShadowConfig } from '../db/bot-config';
import {
  forwardPctFromRef,
  listPendingTickShadowSetups,
  purgeOldTickShadowSetups,
  resolveTickShadowHorizon,
} from '../db/tick-shadow';
import { logEvent } from '../db/trade-log';
import { fetchSymbolMidPrice } from '../exchange/market-data-client';
import { bn } from '../math/decimal';

export async function runTickShadowResolve(env: Env): Promise<void> {
  const shadow = await getTickShadowConfig(env.DB, env);
  if (!shadow.enabled) return;

  const nowMs = Date.now();
  const horizonMs = shadow.horizonSec * 1000;
  await purgeOldTickShadowSetups(env.DB, nowMs - 7 * 24 * 60 * 60_000);

  const pending = await listPendingTickShadowSetups(env.DB, 200);
  const nowIso = new Date().toISOString();

  for (const row of pending) {
    if (nowMs - row.recorded_at_ms < horizonMs) continue;

    const price = await fetchSymbolMidPrice(env, row.symbol);
    if (!price || !bn(price).gt(0)) continue;

    const forwardPct = forwardPctFromRef(row.entry_ref_price, price);
    if (forwardPct == null) continue;

    const positive = bn(forwardPct).gt(0);
    const latest = await resolveTickShadowHorizon(
      env.DB,
      row.id,
      forwardPct,
      positive,
      nowIso,
    );
    if (!latest) continue;

    await logEvent(env.DB, 'TICK_SHADOW_RESOLVED', {
      symbol: row.symbol,
      forward60sPct: forwardPct,
      forward60sPositive: positive,
      wouldPassReversal: row.would_pass_reversal === 1,
      gainPctAtSignal: row.gain_pct,
      recoveryPctAtSignal: row.recovery_pct,
      reversalScore: row.reversal_score,
    });
  }
}
