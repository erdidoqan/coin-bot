/**
 * Dip Reversal Sniper — çıkış / bakım döngüsü (her dk).
 *
 * Açık dip_reversal pozisyonlarını yönetir (strateji kapalı olsa bile çalışır,
 * böylece mevcut pozisyonlar güvenle kapanır):
 *   1. Native trailing (TAKE_PROFIT) emri FILLED ise → pozisyonu finalize et.
 *   2. Hard-stop zarar eşiği aşıldıysa → trailing iptal + market sat + finalize
 *      (bounce başarısız olup düşüş sürerse bag koruması).
 */
import { getDipReversalConfig } from '../db/dip-reversal';
import { listOpenPositions } from '../db/open-positions';
import { logEvent } from '../db/trade-log';
import type { TradingGateway } from '../exchange/gateway';
import { ensureTrailingCanceled } from '../exchange/ensure-trailing-canceled';
import { computeLossPct, fetchSymbolLastPrice } from '../risk/hard-stop';
import { effectiveAvgCost } from '../position/floating-pnl';
import {
  finalizeOpenPositionClose,
  finalizeOpenPositionCloseFromFilledOrder,
} from './finalize-open-position-close';
import { bn } from '../math/decimal';

export async function runDipReversalReconcile(
  env: Env,
  gateway: TradingGateway,
): Promise<void> {
  const positions = await listOpenPositions(env.DB, { entryMode: 'dip_reversal' });
  if (positions.length === 0) return;

  const cfg = await getDipReversalConfig(env.DB, env);

  for (const pos of positions) {
    const symbol = pos.symbol;
    if (bn(pos.net_base_qty).lte(0)) continue;

    const lastPrice = await fetchSymbolLastPrice(gateway, symbol);
    if (!lastPrice || !bn(lastPrice).gt(0)) continue;

    const avgCost = effectiveAvgCost(pos.total_usdt_spent, pos.net_base_qty);
    const lossPct = computeLossPct(avgCost, lastPrice);
    const hardStop = pos.scalp_stop_loss_pct ?? cfg.hardStopPct;

    // 1) Hard-stop: zarar eşiği aşıldı → trailing iptal + sat.
    if (bn(hardStop).gt(0) && bn(lossPct).gte(hardStop)) {
      await logEvent(env.DB, 'HARD_STOP_TRIGGERED', {
        symbol,
        lastPrice,
        avg_cost: avgCost,
        lossPct,
        thresholdPct: hardStop,
        trailing_order_id: pos.trailing_order_id,
        source: 'dip_reversal_hard_stop',
        entry_mode: 'dip_reversal',
        position_id: pos.id,
      });

      if (pos.trailing_order_id) {
        const res = await ensureTrailingCanceled(gateway, symbol, pos.trailing_order_id);
        if (res === 'filled') {
          const order = await gateway.getOrder(symbol, pos.trailing_order_id);
          await finalizeOpenPositionCloseFromFilledOrder(env, pos, order, {
            source: 'dip_reversal_trailing_filled',
          });
          continue;
        }
      }

      await finalizeOpenPositionClose(env, gateway, pos, {
        source: 'dip_reversal_hard_stop',
      });
      continue;
    }

    // 2) Native trailing FILLED mi?
    if (pos.trailing_order_id) {
      const order = await gateway.getOrder(symbol, pos.trailing_order_id);
      if (order.status === 'FILLED') {
        await finalizeOpenPositionCloseFromFilledOrder(env, pos, order, {
          source: 'dip_reversal_trailing_filled',
        });
        continue;
      }
    }

    // 3) Zaman-stop: pozisyon çok uzun süredir açık ve HÂLÂ kârda değil (trailing
    //    aktive olmamış) → başarısız bounce; saatlerce bag-hold yerine erken çık.
    //    Kârdaki pozisyonlara dokunmaz (onları native trailing yönetir).
    if (cfg.maxHoldMin > 0) {
      const ageMin = positionAgeMin(pos.position_opened_at ?? pos.updated_at);
      const inProfit = bn(lastPrice).gt(avgCost);
      if (ageMin != null && ageMin >= cfg.maxHoldMin && !inProfit) {
        await logEvent(env.DB, 'DIP_REVERSAL_TIME_STOP', {
          symbol,
          lastPrice,
          avg_cost: avgCost,
          lossPct,
          ageMin: Math.round(ageMin),
          maxHoldMin: cfg.maxHoldMin,
          trailing_order_id: pos.trailing_order_id,
          source: 'dip_reversal_time_stop',
          entry_mode: 'dip_reversal',
          position_id: pos.id,
        });

        if (pos.trailing_order_id) {
          const res = await ensureTrailingCanceled(gateway, symbol, pos.trailing_order_id);
          if (res === 'filled') {
            const order = await gateway.getOrder(symbol, pos.trailing_order_id);
            await finalizeOpenPositionCloseFromFilledOrder(env, pos, order, {
              source: 'dip_reversal_trailing_filled',
            });
            continue;
          }
        }

        await finalizeOpenPositionClose(env, gateway, pos, {
          source: 'dip_reversal_time_stop',
        });
        continue;
      }
    }
  }
}

function positionAgeMin(openedAt: string | null | undefined): number | null {
  if (!openedAt) return null;
  const iso = openedAt.includes('T') ? openedAt : openedAt.replace(' ', 'T') + 'Z';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return (Date.now() - t) / 60_000;
}
