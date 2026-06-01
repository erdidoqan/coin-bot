import { getMicroShadowConfig } from '../db/bot-config';
import {
  listPendingShadowSetups,
  purgeOldShadowSetups,
  updateShadowHorizon,
  type ShadowSetupRow,
} from '../db/micro-shadow';
import { logEvent } from '../db/trade-log';
import { fetchSymbolMidPrice } from '../exchange/market-data-client';
import {
  forwardPctFromRef,
  hitTakeProfitGross,
  isHorizonDue,
  parseShadowHorizons,
  type ShadowHorizonMin,
} from '../indicators/micro-shadow';
import { bn } from '../math/decimal';

function resolvedHorizons(row: ShadowSetupRow, horizons: ShadowHorizonMin[]): ShadowHorizonMin[] {
  const done: ShadowHorizonMin[] = [];
  if (row.resolved_5m_at) done.push(5);
  if (row.resolved_15m_at) done.push(15);
  if (row.resolved_30m_at) done.push(30);
  return horizons.filter((h) => !done.includes(h));
}

export async function runMicroShadowResolve(env: Env): Promise<void> {
  const shadow = await getMicroShadowConfig(env.DB, env);
  if (!shadow.enabled) return;

  const horizons = parseShadowHorizons(shadow.horizonsMin);
  const nowMs = Date.now();
  const nowIso = new Date().toISOString();
  const pending = await listPendingShadowSetups(env.DB, 150);

  for (const row of pending) {
    const due = resolvedHorizons(row, horizons)
      .filter((h) => isHorizonDue(row.recorded_at_ms, h, nowMs))
      .sort((a, b) => a - b);
    const nextHorizon = due[0];
    if (nextHorizon == null) continue;

    const price = await fetchSymbolMidPrice(env, row.symbol);
    if (!price || !bn(price).gt(0)) continue;

    const forwardPct = forwardPctFromRef(row.entry_ref_price, price);
    if (forwardPct == null) continue;

    const hitTp = hitTakeProfitGross(forwardPct, shadow.tpGrossPct);
    const latest = await updateShadowHorizon(
      env.DB,
      row.id,
      nextHorizon,
      forwardPct,
      hitTp,
      nowIso,
      horizons,
    );

    if (latest?.status === 'complete') {
      await logEvent(env.DB, 'MICRO_SHADOW_RESOLVED', {
        shadowId: latest.id,
        symbol: latest.symbol,
        failReason: latest.fail_reason,
        regime: latest.regime,
        score: latest.score,
        entryRefPrice: latest.entry_ref_price,
        wouldPassScoreOnly: latest.would_pass_score_only === 1,
        trend15mOk: latest.trend15m_ok === 1,
        forward5mPct: latest.forward_5m_pct,
        forward15mPct: latest.forward_15m_pct,
        forward30mPct: latest.forward_30m_pct,
        hitTp5m: latest.hit_tp_5m === 1,
        hitTp15m: latest.hit_tp_15m === 1,
        hitTp30m: latest.hit_tp_30m === 1,
        tpGrossPct: shadow.tpGrossPct,
        recordedAtMs: latest.recorded_at_ms,
      });
    }
  }

  await purgeOldShadowSetups(env.DB, 7);
}
