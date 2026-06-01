/**
 * Dust → BNB dönüştürücü (one-shot, manuel).
 *
 * Binance'in dust-transfer API'siyle cüzdandaki minNotional altı küçük bakiyeleri BNB'ye
 * çevirir. Aktif/recovering grid'i olan semboller dönüşümün DIŞINDA tutulur (çalışan
 * envantere dokunulmasın). BNB ve stable zaten dust listesine girmez.
 */
import { getActiveGrids, getRecoveringGrids } from '../db/grid';
import { logEvent } from '../db/trade-log';
import { BinanceClient } from '../exchange/binance';

function tradingEnabled(env: Env): boolean {
  return String(env.TRADING_ENABLED) === 'true';
}

export interface DustConvertResult {
  ok: boolean;
  converted: number;
  bnbReceived: string;
  assets: string[];
  message?: string;
}

export async function runDustConvert(env: Env): Promise<DustConvertResult> {
  if (!tradingEnabled(env)) {
    await logEvent(env.DB, 'DUST_CONVERT', { reason: 'not_live_mode', live: false });
    return { ok: false, converted: 0, bnbReceived: '0', assets: [], message: 'not_live_mode' };
  }

  const client = new BinanceClient(env);
  const [list, actives, recovering] = await Promise.all([
    client.getDustList().catch(() => null),
    getActiveGrids(env.DB),
    getRecoveringGrids(env.DB),
  ]);

  if (!list || !list.details?.length) {
    await logEvent(env.DB, 'DUST_CONVERT', { converted: 0, reason: 'no_dust' });
    return { ok: true, converted: 0, bnbReceived: '0', assets: [], message: 'no_dust' };
  }

  // Çalışan grid sembollerinin base varlıklarını dönüşüm dışı bırak.
  const busyAssets = new Set<string>(
    [...actives, ...recovering].map((g) => g.symbol.replace(/USDT$/, '')),
  );
  const ignore = new Set(['LUNC']);
  const assets = list.details.map((d) => d.asset).filter((a) => !busyAssets.has(a) && !ignore.has(a));

  if (assets.length === 0) {
    await logEvent(env.DB, 'DUST_CONVERT', { converted: 0, reason: 'all_busy' });
    return { ok: true, converted: 0, bnbReceived: '0', assets: [], message: 'all_busy' };
  }

  try {
    const res = await client.dustTransfer(assets);
    await logEvent(env.DB, 'DUST_CONVERT', {
      converted: res.transferResult?.length ?? assets.length,
      bnbReceived: res.totalTransfered,
      serviceCharge: res.totalServiceCharge,
      assets,
      live: true,
    });
    return {
      ok: true,
      converted: res.transferResult?.length ?? assets.length,
      bnbReceived: res.totalTransfered ?? '0',
      assets,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logEvent(env.DB, 'DUST_CONVERT_FAILED', { message, assets });
    return { ok: false, converted: 0, bnbReceived: '0', assets, message };
  }
}
