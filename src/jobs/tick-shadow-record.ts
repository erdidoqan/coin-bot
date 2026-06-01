import { getTickShadowConfig } from '../db/bot-config';
import { hasRecentPendingTickShadow, insertTickShadowSetup } from '../db/tick-shadow';
import { passesScoutPriceBand } from '../indicators/tick-reversal';
import { bn } from '../math/decimal';
import type { TickScalpConfig } from '../db/bot-config';
import type { TickScanRow } from '../durable-objects/market-data-do';

export interface TickSignalShadowInput {
  symbol: string;
  mid: string;
  scoutPrice: string | null;
  row: Pick<
    TickScanRow,
    | 'gainPct'
    | 'wsDeclinePct'
    | 'recoveryFromWsLowPct'
    | 'reversalScore'
    | 'reversalOk'
    | 'pass'
  >;
}

export async function recordTickShadowFromSignal(
  env: Env,
  tick: TickScalpConfig,
  input: TickSignalShadowInput,
): Promise<void> {
  const shadow = await getTickShadowConfig(env.DB, env);
  if (!shadow.enabled) return;
  if (!input.mid || !bn(input.mid).gt(0)) return;

  const nowMs = Date.now();
  if (await hasRecentPendingTickShadow(env.DB, input.symbol, shadow.dedupeMinutes, nowMs)) {
    return;
  }

  let scoutVsFill: string | null = null;
  if (input.scoutPrice && bn(input.scoutPrice).gt(0)) {
    const band = passesScoutPriceBand(
      input.scoutPrice,
      input.mid,
      tick.scoutMaxBelowPct,
      tick.scoutMaxAbovePct,
    );
    scoutVsFill = band.scoutVsFillPct;
  }

  const wouldPassReversal = Boolean(input.row.pass && input.row.reversalOk);

  await insertTickShadowSetup(env.DB, {
    symbol: input.symbol,
    recordedAtMs: nowMs,
    entryRefPrice: input.mid,
    gainPct: input.row.gainPct,
    wsDeclinePct: input.row.wsDeclinePct,
    recoveryPct: input.row.recoveryFromWsLowPct,
    reversalScore: input.row.reversalScore,
    scoutPrice: input.scoutPrice,
    scoutVsFillPct: scoutVsFill,
    wouldPassReversal,
  });
}
