/** Panel: teknik primaryBlocker → okunur Türkçe (kısa + ipucu). */

const BLOCKERS: Record<string, { label: string; hint: string }> = {
  ranging: {
    label: 'Tek yönlü trend',
    hint: 'Fiyat çok düz gidiyor (salınım değil trend). Grid yatay piyasada çalışır.',
  },
  range_width_min: {
    label: '24s çok dar',
    hint: 'Son ~24 saatte tepe–dip farkı çok küçük; grid için hareket yetmiyor olabilir.',
  },
  range_width_max: {
    label: '24s çok geniş',
    hint: 'Son ~24 saatte çok uçmuş (sert pump/dump). Grid için fazla riskli.',
  },
  volatility: {
    label: 'Hareket az',
    hint: 'Mum başına ortalama oynama düşük; grid dolduracak kadar volatilite yok.',
  },
  spread: {
    label: 'Spread geniş',
    hint: 'Alış–satış farkı büyük; maker grid için uygun değil.',
  },
  price_in_range: {
    label: 'Bandın dışında',
    hint: 'Şu anki fiyat, kapanışların p10–p90 bandının dışında (grid_range_pctl ile genişletilebilir).',
  },
  path_stability: {
    label: 'Testere (zigzag)',
    hint: 'Fiyat çok geri–ileri gidiyor, net mesafe az; whipsaw riski.',
  },
  bar_volatility: {
    label: 'Fitilli mumlar',
    hint: 'Uzun fitiller, çok oynak mumlar; komisyon yer, pozisyon şişebilir.',
  },
  stability_range: {
    label: '24s aralık yüksek',
    hint: 'Son 24 saatte high–low bandı geniş; scout stabilite limitinin üstünde.',
  },
  no_flash_drop: {
    label: 'Ani düşüş',
    hint: 'Son dakikalarda flash guard tetiklenmiş; yeni grid için bekleniyor.',
  },
  downside_momentum: {
    label: 'Şimdi düşüyor',
    hint: 'Son birkaç 5 dk mum üst üste kırmızı veya kısa sürede belirgin düşüş.',
  },
  pct_3m_decline: {
    label: 'Son 3 dk düşüş',
    hint: 'Güncel fiyat, ~3 dk önceki 1m kapanışın altında; skor −1, hazır sayılmaz.',
  },
  entry_band_position: {
    label: 'Band üstünde',
    hint: 'Fiyat auto-range üst yarısında; breakeven_dip için alış çok yukarıda kalır.',
  },
  medium_downside: {
    label: 'Saatlerce düşüş',
    hint: 'Son ~3 saatte (36×5m) net getiri eşiğin altında; düşen bıçakta kurulum yok.',
  },
  hour_decline: {
    label: '~40 dk sürekli düşüş',
    hint: 'Son 8×5m kapanış üst üste kırmızı; watchlist ve aday listesine alınmaz.',
  },
  post_exit_cooldown: {
    label: 'Çıkış sonrası bekleme',
    hint: 'Yakın zamanda floor kârı veya grid stop; aynı coine hemen yeniden girilmez.',
  },
  flash_cooldown: {
    label: 'Flash bekleme',
    hint: 'Bu sembolde yakın zamanda flash kurtarma oldu; süre dolana kadar seçilmez.',
  },
  flash_drop: {
    label: 'Flash düşüş',
    hint: 'Ani düşüş seviyesi grid girişine izin vermiyor.',
  },
  market_panic: {
    label: 'Piyasa panik',
    hint: 'Genel piyasa panic rejiminde; yeni grid kurulmaz.',
  },
  market_downturn: {
    label: 'Piyasa düşüş modu',
    hint: 'Zayıf breadth + BTC düşüşü; yeni grid kurulmaz (açık gridler devam).',
  },
  force_active: {
    label: 'Manuel düşüş kilidi',
    hint: 'grid_market_downturn_force_active=true; eşiklerden bağımsız yeni grid kapalı.',
  },
  defensive_mode: {
    label: 'Savunma modu',
    hint: 'Chop / düşüş / manuel kilit: yeni grid yok; muaf olmayan aktifler recovery.',
  },
  market_downturn_weak_symbol: {
    label: 'Zayıf 24s coin',
    hint: 'Düşüş modunda 24s getirisi eşiğin altında; watchlist’e alınmaz.',
  },
  recovering_blocks_setup: {
    label: 'Kurtarmada (yeni grid kapalı)',
    hint: 'Bu sembolde RECOVERING grid var ve grid_allow_new_grid_while_recovering=false.',
  },
  no_klines: {
    label: 'Veri yok',
    hint: 'Yeterli mum verisi alınamadı (DO/REST).',
  },
};

export function blockerLabel(id: string | null | undefined): string {
  if (!id) return '—';
  return BLOCKERS[id]?.label ?? id;
}

export function blockerHint(id: string | null | undefined): string {
  if (!id) return '';
  const b = BLOCKERS[id];
  if (!b) return id;
  return `${b.label} — ${b.hint}`;
}
