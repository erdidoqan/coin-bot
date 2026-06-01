import type { BotState } from '../db/bot-state';
import { getRotationConfig } from '../db/bot-config';
import { resolvePositionOpenedAt, resolveEntryMode } from '../db/bot-state';
import { minutesSinceOpenedAt } from '../indicators/watchlist-sma';
import { resolveRotationThresholds } from '../risk/rotation-thresholds';
import type { FloatingPnlSnapshot } from '../position/floating-pnl';

export interface RotationStatus {
  elapsedMinutes: string | null;
  graceMinutes: number;
  inGracePeriod: boolean;
  rotationChecksActive: boolean;
  bypassGraceForLoss: boolean;
  lossRelaxedMin: boolean;
  configuredMinImprovementPct: string;
  effectiveMinImprovementPct: string;
  floatingPnlPct: string | null;
  summary: string;
}

export function buildRotationStatus(
  state: BotState,
  rotationWindowMinutes: string,
  rotationMinImprovementPct: string,
  floatingPnl: FloatingPnlSnapshot | null,
): RotationStatus | null {
  if (state.status !== 'TIER_1_BULL' || !state.active_symbol) return null;
  if (
    resolveEntryMode(state) === 'momentum_scalp' ||
    resolveEntryMode(state) === 'micro_scalp' ||
    resolveEntryMode(state) === 'tick_scalp'
  ) {
    return {
      elapsedMinutes: null,
      graceMinutes: 0,
      inGracePeriod: false,
      rotationChecksActive: false,
      bypassGraceForLoss: false,
      lossRelaxedMin: false,
      configuredMinImprovementPct: '—',
      effectiveMinImprovementPct: '—',
      floatingPnlPct: floatingPnl?.pnlPct ?? null,
      summary: 'Momentum scalp — watchlist rotasyonu kapalı',
    };
  }

  const openedAt = resolvePositionOpenedAt(state);
  const elapsed = minutesSinceOpenedAt(openedAt);
  const fpPct = floatingPnl?.pnlPct ?? null;

  const t = resolveRotationThresholds(
    rotationWindowMinutes,
    rotationMinImprovementPct,
    elapsed,
    fpPct,
  );

  let summary: string;
  if (t.inGracePeriod) {
    const left = Math.max(0, t.graceMinutes - (elapsed ?? 0));
    summary = `Bekleme: ~${left.toFixed(0)} dk kaldı (trailing). Zarar ≤%0,5 olursa erken rotasyon.`;
  } else if (t.bypassGraceForLoss) {
    summary = `Zarar modu: min SMA iyileşmesi 0 — watchlist’te daha iyi Hazır aday aranıyor.`;
  } else if (t.lossRelaxedMin) {
    summary = `Hafif zarar: gevşetilmiş SMA eşiği (%${t.effectiveMinImprovementPct}) ile rotasyon aktif.`;
  } else {
    summary = `Rotasyon aktif — watchlist’te daha düşük SMA sapması + min %${t.effectiveMinImprovementPct} iyileşme.`;
  }

  return {
    elapsedMinutes: elapsed !== null ? elapsed.toFixed(1) : null,
    graceMinutes: t.graceMinutes,
    inGracePeriod: t.inGracePeriod,
    rotationChecksActive: t.rotationChecksActive,
    bypassGraceForLoss: t.bypassGraceForLoss,
    lossRelaxedMin: t.lossRelaxedMin,
    configuredMinImprovementPct: t.configuredMinImprovementPct,
    effectiveMinImprovementPct: t.effectiveMinImprovementPct,
    floatingPnlPct: fpPct,
    summary,
  };
}

export async function fetchRotationStatus(
  env: Env,
  state: BotState,
  floatingPnl: FloatingPnlSnapshot | null,
): Promise<RotationStatus | null> {
  const cfg = await getRotationConfig(env.DB, env);
  return buildRotationStatus(state, cfg.rotationWindowMinutes, cfg.rotationMinImprovementPct, floatingPnl);
}
