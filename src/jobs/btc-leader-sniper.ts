import { getBotState } from '../db/bot-state';
import { listWatchlist } from '../db/watchlist';
import { logEvent } from '../db/trade-log';
import { TradingGateway } from '../exchange/gateway';
import { fetchTickRank } from '../exchange/market-data-client';
import { getTickScalpConfig, getScalpConfig } from '../db/bot-config';
import { tryScalpEntry } from './scalp-entry';
import { isInHardStopCooldown } from './hybrid-sniper';
import type { TickScanRow } from '../durable-objects/market-data-do';

/**
 * BTC-Lider Order-Flow Sniper.
 *
 * Mantık (kullanıcı tasarımı): önce BTC'yi izle — satış dalgası EMİLİP (absorpsiyon,
 * aggTrade) dönüş başladıysa (recovery + yükselen mid), BTC RECOVERING. O an, kaliteli
 * adaylar arasında en güçlü order-flow'lu (reversalScore + alıcı baskınlığı) coine
 * KÜÇÜK pozisyonla gir → trend'e bin, kaçırma. Çıkış scalp-entry (OCO/trailing).
 *
 * Saniye-bazlı (DO @aggTrade/@depth100ms tespit + REST ~1-3sn icra). Backtest edilemez
 * → küçük poz + sıkı koruma (cooldown, tek pozisyon, IDLE şartı).
 */
const BTC = 'BTCUSDT';
const BTC_LEADER_QUOTE = '25'; // küçük test pozisyonu (USDT)
const COOLDOWN_MIN = 30;
const MIN_REVERSAL = 1.0;
const MIN_IMBALANCE = 0.1; // aggTrade alıcı baskınlığı (absorpsiyon işareti)

/** Order-flow ile dönüş: dipten toparlanma + alıcı baskın (absorpsiyon) + yükselen mid. */
function flowRecovering(r: TickScanRow): boolean {
  if (r.stale) return false;
  const recovered =
    r.recoveryFromWsLowPct != null && Number(r.recoveryFromWsLowPct) > 0;
  const reversal = r.reversalScore >= MIN_REVERSAL;
  const buyerDominant =
    r.aggBurstOk || (r.aggImbalance != null && Number(r.aggImbalance) >= MIN_IMBALANCE);
  return recovered && reversal && buyerDominant && r.midSlopeOk;
}

/** @returns true ise giriş yapıldı (dip fallback atlanmalı). */
export async function runBtcLeaderSniper(env: Env): Promise<boolean> {
  const state = await getBotState(env.DB);
  if (state.status !== 'IDLE') return false;

  const tickCfg = await getTickScalpConfig(env.DB, env);
  const rank = await fetchTickRank(env, tickCfg);
  if (!rank || rank.rows.length === 0) return false;

  // 1) BTC RECOVERING mi? (lider — BTC dönmüyorsa hiç girme)
  const btc = rank.rows.find((r) => r.symbol === BTC);
  if (!btc || !flowRecovering(btc)) return false;

  await logEvent(env.DB, 'BTC_RECOVERING', {
    reversalScore: btc.reversalScore,
    recovery: btc.recoveryFromWsLowPct,
    aggImbalance: btc.aggImbalance,
    aggBurstOk: btc.aggBurstOk,
  });

  // 2) BTC dönüyor → en güçlü order-flow aday (BTC hariç), reversalScore'a göre sırala.
  const candidates = rank.rows
    .filter((r) => r.symbol !== BTC && flowRecovering(r))
    .sort((a, b) => b.reversalScore - a.reversalScore);

  if (candidates.length === 0) {
    await logEvent(env.DB, 'BTC_LEADER_SKIP', { reason: 'no_flow_candidate' });
    return false;
  }

  const watchlist = await listWatchlist(env.DB);
  const wlMap = new Map(watchlist.map((e, i) => [e.symbol, { entry: e, index: i }]));
  const gateway = new TradingGateway(env);
  const scalp = await getScalpConfig(env.DB, env);

  for (const c of candidates) {
    const row = wlMap.get(c.symbol);
    if (!row) continue;
    if (await isInHardStopCooldown(env.DB, c.symbol, COOLDOWN_MIN)) {
      await logEvent(env.DB, 'COOLDOWN_SKIP', {
        symbol: c.symbol,
        reason: 'recent_hard_stop',
        source: 'btc_leader',
      });
      continue;
    }
    await logEvent(env.DB, 'BTC_LEADER_PICK', {
      symbol: c.symbol,
      reversalScore: c.reversalScore,
      aggImbalance: c.aggImbalance,
      bidAskRatio: c.bidAskRatio,
      recovery: c.recoveryFromWsLowPct,
      quoteUsdt: BTC_LEADER_QUOTE,
    });
    const entered = await tryScalpEntry(env, row.entry, {
      gateway,
      quoteUsdt: BTC_LEADER_QUOTE,
      scalp,
      entryIndex: row.index,
    });
    if (entered) return true;
  }

  await logEvent(env.DB, 'BTC_LEADER_SKIP', {
    reason: 'scalp_failed',
    tried: candidates.slice(0, 3).map((c) => c.symbol),
  });
  return false;
}
