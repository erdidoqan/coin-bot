/**
 * Dip Reversal Sniper — çıkış / bakım döngüsü (her dk).
 *
 * Açık dip_reversal + grid (alımdan sonra devredilen) pozisyonlarını yönetir
 * (strateji kapalı olsa bile çalışır, böylece mevcut pozisyonlar güvenle kapanır):
 *   1. Native trailing (TAKE_PROFIT) emri FILLED ise → pozisyonu finalize et.
 *   2. Hard-stop zarar eşiği aşıldıysa → trailing iptal + market sat + finalize
 *      (bounce başarısız olup düşüş sürerse bag koruması).
 */
import { getDipReversalConfig } from '../db/dip-reversal';
import { listOpenPositions } from '../db/open-positions';
import { logEvent } from '../db/trade-log';
import type { TradingGateway } from '../exchange/gateway';
import type { DipReversalAdaptSnapshot } from './dip-reversal-context';
import { adaptEntryBlockReason } from '../strategy/dip-reversal-adapt';
import { ensureTrailingCanceled } from '../exchange/ensure-trailing-canceled';
import { fetchKlinesFromDo } from '../exchange/market-data-client';
import { isSymbolMomentumUp } from '../indicators/momentum-breadth';
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
  adaptSnapshot?: DipReversalAdaptSnapshot | null,
): Promise<void> {
  // Dip Reversal pozisyonları + grid'den devredilen (entry_mode='grid') pozisyonlar
  // aynı tek-pozisyon çıkış mantığıyla yönetilir (trailing + hard/time/adapt stop).
  const [dipPositions, gridPositions] = await Promise.all([
    listOpenPositions(env.DB, { entryMode: 'dip_reversal' }),
    listOpenPositions(env.DB, { entryMode: 'grid' }),
  ]);
  const positions = [...dipPositions, ...gridPositions];
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
        source: `${pos.entry_mode}_hard_stop`,
        entry_mode: pos.entry_mode,
        position_id: pos.id,
      });

      if (pos.trailing_order_id) {
        const res = await ensureTrailingCanceled(gateway, symbol, pos.trailing_order_id);
        if (res === 'filled') {
          const order = await gateway.getOrder(symbol, pos.trailing_order_id);
          await finalizeOpenPositionCloseFromFilledOrder(env, pos, order, {
            source: `${pos.entry_mode}_trailing_filled`,
          });
          continue;
        }
      }

      await finalizeOpenPositionClose(env, gateway, pos, {
        source: `${pos.entry_mode}_hard_stop`,
      });
      continue;
    }

    // 2) Native trailing FILLED mi?
    if (pos.trailing_order_id) {
      const order = await gateway.getOrder(symbol, pos.trailing_order_id);
      if (order.status === 'FILLED') {
        await finalizeOpenPositionCloseFromFilledOrder(env, pos, order, {
          source: `${pos.entry_mode}_trailing_filled`,
        });
        continue;
      }
    }

    // 3) Adapt erken çıkış: rejim blocking'e geçtiyse VE kârda değilsek hemen çık.
    //    Normal time_stop'un 40 dk beklemesi yerine piyasa bozulunca erken kapatır.
    //    2 dk grace period — giriş cycle'ıyla çakışmayı önler.
    if (adaptSnapshot && cfg.adapt.enabled) {
      const blockReason = adaptEntryBlockReason(adaptSnapshot.mode, {
        downtrendMode: cfg.adapt.downtrendMode,
        volatileBlockEnabled: cfg.adapt.volatileBlockEnabled,
        volatileBlockBreadthMax: cfg.adapt.volatileBlockBreadthMax,
        breadthPct: adaptSnapshot.context.breadthPct,
      });
      if (blockReason) {
        const ageMin = positionAgeMin(pos.position_opened_at ?? pos.updated_at);
        const inProfit = bn(lastPrice).gt(avgCost);
        if (ageMin != null && ageMin >= 2 && !inProfit) {
          // #2 Akıllı exit: pozisyon kendi kısa momentumunda toparlanıyorsa dibe
          // satma; çıkışı ertele, bir sonraki cycle yeniden değerlendir. Hard/time
          // stop nihai güvence olarak devrede kalır.
          if (cfg.adapt.smartExitEnabled) {
            const k1m = await fetchKlinesFromDo(env, symbol, '1m', 16);
            if (k1m) {
              const rec = isSymbolMomentumUp(k1m, cfg.adapt.exitMomentumAtrMult, 3);
              if (rec.up === true) {
                await logEvent(env.DB, 'DIP_REVERSAL_ADAPT_EXIT_DEFERRED', {
                  symbol,
                  lastPrice,
                  avg_cost: avgCost,
                  momentumPct: rec.momentumPct,
                  atrPct: rec.atrPct,
                  exitMomentumAtrMult: cfg.adapt.exitMomentumAtrMult,
                  ageMin: Math.round(ageMin),
                  blockReason,
                  entry_mode: pos.entry_mode,
                  position_id: pos.id,
                });
                continue;
              }
            }
          }
          await logEvent(env.DB, 'DIP_REVERSAL_ADAPT_EXIT', {
            symbol,
            lastPrice,
            avg_cost: avgCost,
            lossPct,
            ageMin: Math.round(ageMin),
            adaptMode: adaptSnapshot.mode,
            blockReason,
            trailing_order_id: pos.trailing_order_id,
            entry_mode: pos.entry_mode,
            position_id: pos.id,
            source: `${pos.entry_mode}_adapt_exit`,
          });
          if (pos.trailing_order_id) {
            const res = await ensureTrailingCanceled(gateway, symbol, pos.trailing_order_id);
            if (res === 'filled') {
              const order = await gateway.getOrder(symbol, pos.trailing_order_id);
              await finalizeOpenPositionCloseFromFilledOrder(env, pos, order, {
                source: `${pos.entry_mode}_trailing_filled`,
              });
              continue;
            }
          }
          await finalizeOpenPositionClose(env, gateway, pos, {
            source: `${pos.entry_mode}_adapt_exit`,
          });
          continue;
        }
      }
    }

    // 4) Zaman-stop: pozisyon çok uzun süredir açık ve HÂLÂ kârda değil (trailing
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
          source: `${pos.entry_mode}_time_stop`,
          entry_mode: pos.entry_mode,
          position_id: pos.id,
        });

        if (pos.trailing_order_id) {
          const res = await ensureTrailingCanceled(gateway, symbol, pos.trailing_order_id);
          if (res === 'filled') {
            const order = await gateway.getOrder(symbol, pos.trailing_order_id);
            await finalizeOpenPositionCloseFromFilledOrder(env, pos, order, {
              source: `${pos.entry_mode}_trailing_filled`,
            });
            continue;
          }
        }

        await finalizeOpenPositionClose(env, gateway, pos, {
          source: `${pos.entry_mode}_time_stop`,
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
