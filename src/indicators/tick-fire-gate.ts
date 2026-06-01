/** DO sniper: debounce ve cooldown (saf fonksiyon, test edilebilir). */

export const TICK_EVAL_DEBOUNCE_MS = 400;
export const TICK_SYMBOL_FIRE_COOLDOWN_MS = 60_000;
export const TICK_GLOBAL_FIRE_COOLDOWN_MS = 10_000;

export function shouldScheduleTickEval(
  nowMs: number,
  lastScheduledMs: number,
  debounceMs = TICK_EVAL_DEBOUNCE_MS,
): boolean {
  return nowMs - lastScheduledMs >= debounceMs;
}

export function canFireTickSignal(opts: {
  nowMs: number;
  lastGlobalFireMs: number;
  lastSymbolFireMs: number;
  globalCooldownMs?: number;
  symbolCooldownMs?: number;
}): boolean {
  const globalMs = opts.globalCooldownMs ?? TICK_GLOBAL_FIRE_COOLDOWN_MS;
  const symbolMs = opts.symbolCooldownMs ?? TICK_SYMBOL_FIRE_COOLDOWN_MS;
  if (opts.nowMs - opts.lastGlobalFireMs < globalMs) return false;
  if (opts.nowMs - opts.lastSymbolFireMs < symbolMs) return false;
  return true;
}
