import { isMicroScalpEnabled, isTickScalpEnabled } from '../db/bot-config';
import { runHybridSniper } from './hybrid-sniper';
import { runMicroScalpSniper } from './micro-scalp-sniper';
import { runTickScalpMaintenance } from './tick-scalp-sniper';
import { runPullbackOnlySniper } from './sniper-pullback-only';

export async function runSniper(env: Env): Promise<void> {
  if (await isTickScalpEnabled(env.DB, env)) {
    await runTickScalpMaintenance(env);
    return;
  }
  if (await isMicroScalpEnabled(env.DB, env)) {
    await runMicroScalpSniper(env);
    return;
  }
  await runHybridSniper(env);
}
