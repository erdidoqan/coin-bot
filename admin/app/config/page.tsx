'use client';

import { useEffect, useState } from 'react';
import { AuthGuard } from '@/components/AuthGuard';
import { Nav } from '@/components/Nav';
import { apiFetch } from '@/lib/api';

interface Field {
  key: string;
  label: string;
}
interface Group {
  title: string;
  desc?: string;
  fields: Field[];
}

const GROUPS: Group[] = [
  {
    title: 'Strateji & Genel',
    fields: [
      { key: 'grid_enabled', label: 'Grid aktif (true/false)' },
      { key: 'live_gate', label: 'Gerçek emir izni (true = CANLI, false = PAPER)' },
      { key: 'grid_max_concurrent', label: 'Eşzamanlı grid sayısı (slot)' },
      { key: 'grid_investment_usdt', label: 'Grid başına yatırım (USDT)' },
      { key: 'grid_count', label: 'Hedef grid sayısı (fee duvarına göre sınırlanır)' },
      { key: 'grid_symbol', label: 'Pinli sembol (manuel mod / fallback)' },
    ],
  },
  {
    title: 'Aralık (range)',
    fields: [
      { key: 'grid_range_mode', label: 'Aralık modu (auto | manual)' },
      { key: 'grid_range_lookback_days', label: 'Auto aralık geçmişi (gün)' },
      { key: 'grid_range_pctl', label: 'Auto aralık alt percentile (üst = 100 − bu)' },
      { key: 'grid_lower_price', label: 'Manuel alt fiyat (manual mod)' },
      { key: 'grid_upper_price', label: 'Manuel üst fiyat (manual mod)' },
      { key: 'grid_fee_roundtrip_pct', label: 'Roundtrip komisyon (%) — BNB indirimli ~0.15' },
      { key: 'grid_fee_wall_multiple', label: 'Fee duvarı çarpanı (spacing ≥ fee × bu)' },
    ],
  },
  {
    title: 'Aday & Uygunluk (körü körüne girmeyi engeller)',
    desc: 'WS ile izlenen adaylar; aşağıdaki ranging/volatilite kapıları geçilirse grid kurulur.',
    fields: [
      { key: 'grid_use_watchlist', label: 'Watchlist adaylarından seç (true/false)' },
      { key: 'grid_candidate_count', label: 'Aday sayısı (hacme göre top N)' },
      { key: 'grid_scout_risk_filter_enabled', label: 'Scout risk filtresi (volatilite/flash/düşüş)' },
      { key: 'grid_scout_max_abs_change_pct', label: 'Scout max |24s değişim| % (0=kapalı)' },
      { key: 'grid_scout_pool_multiplier', label: 'Scout hacim havuzu (N × aday sayısı)' },
      { key: 'grid_exclude_symbols', label: 'Hariç tutulan semboller (CSV, örn. BNBUSDT)' },
      { key: 'grid_max_efficiency_ratio', label: 'Max Efficiency Ratio (düşük = ranging; örn. 0.35)' },
      { key: 'grid_min_range_width_pct', label: 'Min aralık genişliği (%)' },
      { key: 'grid_max_range_width_pct', label: 'Max aralık genişliği (%)' },
      { key: 'grid_min_atr_pct', label: 'Min ATR% (volatilite)' },
      { key: 'grid_readiness_max_spread_pct', label: 'Max spread (%)' },
      { key: 'grid_readiness_lookback', label: 'Readiness kline lookback (5m bar sayısı)' },
      {
        key: 'grid_readiness_downside_bars',
        label: 'Momentum: üst üste kırmızı 5m kapanış sayısı (0=kapalı, öneri 3)',
      },
      { key: 'grid_readiness_short_return_bars', label: 'Momentum: kısa net getiri penceresi (5m bar)' },
      {
        key: 'grid_readiness_post_exit_relax_enabled',
        label: 'Çıkış sonrası readiness gevşetme (true/false)',
      },
      {
        key: 'grid_readiness_post_exit_relax_days',
        label: 'Gevşetme: son kaç gün içinde STOPPED grid',
      },
      {
        key: 'grid_readiness_post_exit_momentum_warn_pct',
        label: 'Gevşek mod: kısa düşüş eşiği % (üst üste kırmızı sayılmaz)',
      },
      {
        key: 'grid_readiness_momentum_warn_pct',
        label: 'Momentum: kısa düşüş eşiği % (flash uyarısından ayrı)',
      },
      {
        key: 'grid_allow_new_grid_while_recovering',
        label: 'Recovering varken aynı sembolde yeni grid (true/false)',
      },
      {
        key: 'grid_readiness_max_path_range_ratio',
        label: 'Max path/range (testere; 0=kapalı, örn. 8)',
      },
      {
        key: 'grid_readiness_max_bar_range_path_ratio',
        label: 'Max bar path/span (fitil; 0=kapalı, örn. 14)',
      },
      {
        key: 'grid_readiness_max_stability_range_pct',
        label: 'Max 24s aralık % (stabilite penceresi, örn. 22)',
      },
      {
        key: 'grid_readiness_stability_bars',
        label: 'Stabilite penceresi (5m bar, 288=24s)',
      },
      {
        key: 'grid_readiness_hour_decline_enabled',
        label: '1s sürekli düşüş filtresi (true/false)',
      },
      {
        key: 'grid_readiness_hour_decline_bars',
        label: 'Sürekli düşüş penceresi (5m bar, 12=1 saat)',
      },
      {
        key: 'grid_readiness_max_entry_band_pct',
        label: 'Max giriş band konumu % (üstten alış engeli, örn. 65)',
      },
      {
        key: 'grid_readiness_medium_return_bars',
        label: 'Orta vadeli düşüş penceresi (5m bar, örn. 36)',
      },
      {
        key: 'grid_readiness_medium_return_warn_pct',
        label: 'Orta vadeli düşüş eşiği % (örn. 2.5)',
      },
      {
        key: 'grid_readiness_post_exit_cooldown_enabled',
        label: 'Floor/stop sonrası bekleme (true/false)',
      },
      {
        key: 'grid_readiness_post_exit_cooldown_min',
        label: 'Floor/stop bekleme süresi (dk)',
      },
    ],
  },
  {
    title: 'Piyasa düşüş modu',
    desc: 'Makro kilidi — yeni grid kurulumu. Manuel kilidi ana panelden de açıp kapatabilirsin.',
    fields: [
      { key: 'grid_market_downturn_enabled', label: 'Düşüş modu etkin (true/false)' },
      {
        key: 'grid_market_downturn_force_active',
        label: 'Manuel kilidi (true = her zaman yeni grid kapalı)',
      },
      { key: 'grid_market_downturn_breadth_max_pct', label: 'Zayıf breadth üst sınır %' },
      { key: 'grid_market_downturn_btc_24h_pct', label: 'BTC 24s eşik % (örn. -2.5)' },
      { key: 'grid_market_downturn_btc_15m_return_pct', label: 'BTC 15m getiri eşik %' },
      { key: 'grid_market_downturn_scout_min_change_pct', label: 'Scout min 24s % (düşüş modunda)' },
      { key: 'grid_market_downturn_block_panic', label: 'Panic rejiminde kilitle (true/false)' },
      { key: 'grid_market_downturn_allow_manual', label: 'Manuel pinli sembolü muaf tut (true/false)' },
    ],
  },
  {
    title: 'Risk & Çıkış',
    fields: [
      { key: 'grid_stop_below_pct', label: 'Alt sınır stop-out (%) — kurtarma moduna geç' },
      { key: 'grid_recovery_margin_pct', label: 'Kurtarma hedef kâr marjı (%) — fee üstüne eklenir' },
      { key: 'grid_stop_above_pct', label: 'Üst sınır stop / kâr-al (%)' },
      { key: 'grid_range_reset_enabled', label: 'Range-reset: stop sonrası yeniden kur (true/false)' },
      { key: 'grid_recenter_enabled', label: 'Re-center aktif: fiyata göre yeniden ortala (true/false)' },
      { key: 'grid_recenter_drift_pct', label: 'Re-center drift eşiği (%) — yarı-aralığın bu oranı kadar sapınca' },
      {
        key: 'grid_readiness_teardown_enabled',
        label: 'Readiness teardown: watchlist dışı / trending / ciddi blocker (true/false)',
      },
      { key: 'grid_max_inventory_usdt', label: 'Envanter (bag) tavanı (USDT)' },
      {
        key: 'grid_ladder_mode',
        label: 'Merdiven modu: breakeven_dip (tek alış + ort çıkış) | classic',
      },
      { key: 'grid_floor_exit_margin_pct', label: 'Ortalama çıkış satış marjı (%) — breakeven_dip' },
      {
        key: 'grid_dip_buy_defer_steps',
        label: 'Alış erteleme (basamak): 0=hemen limit, 1=fiyat 1 basamak üste inince koy',
      },
      { key: 'grid_max_consecutive_buys', label: 'Classic mod: max eşzamanlı açık alış' },
      { key: 'grid_flash_drop_enabled', label: 'Flash drop guard (true/false)' },
      { key: 'grid_flash_drop_warn_pct', label: 'Flash uyarı eşiği (%) — yeni alış/heal/recenter durur' },
      { key: 'grid_flash_drop_pause_pct', label: 'Flash duraklat (%) — açık alışlar iptal' },
      { key: 'grid_flash_drop_recovery_pct', label: 'Flash kurtarma (%) — recovery modu' },
      { key: 'grid_flash_drop_window_min', label: 'Flash kline penceresi (dk)' },
      { key: 'grid_flash_drop_max_fills', label: 'Flash max dolu alış (fill storm)' },
      { key: 'grid_flash_drop_fill_window_min', label: 'Flash fill storm penceresi (dk)' },
      { key: 'grid_flash_drop_overfill_mult', label: 'Flash overfill çarpanı (maliyet > yatırım × bu)' },
      { key: 'grid_flash_drop_scout_block_panic', label: 'Panic rejiminde yeni grid yok (true/false)' },
      { key: 'grid_flash_drop_symbol_cooldown_min', label: 'Flash sonrası sembol cooldown (dk)' },
    ],
  },
  {
    title: 'Alım koruması (readiness guard)',
    fields: [
      { key: 'grid_buy_guard_enabled', label: 'Alım guard aktif (true/false) — manuel modda kapalı' },
      { key: 'grid_buy_cancel_open_on_not_ready', label: 'Açık BUY: readiness kötüyse iptal (P0)' },
      { key: 'grid_buy_block_new_on_not_ready', label: 'Yeni BUY: readiness kötüyse koyma (P1)' },
      {
        key: 'grid_buy_cancel_anchor_drawdown_pct',
        label: 'Anchor drawdown (%) — açık/yeni alış iptal; 0=kapalı',
      },
      { key: 'grid_buy_log_assessment', label: 'Alım olaylarında score/blocker logla' },
      {
        key: 'grid_teardown_on_readiness_blockers',
        label: 'Teardown: ciddi readiness blocker (P3)',
      },
      {
        key: 'grid_teardown_readiness_blockers',
        label: 'Teardown blocker listesi (CSV): downside_momentum,hour_decline,flash_drop',
      },
      { key: 'grid_recenter_requires_ready', label: 'Re-center: flat iken readiness hazır olmalı (P4)' },
    ],
  },
];

const ALL_KEYS = GROUPS.flatMap((g) => g.fields.map((f) => f.key));

export default function ConfigPage() {
  const [values, setValues] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    apiFetch<{ config: Array<{ key: string; value: string }> }>('/admin/api/config')
      .then((r) => {
        const v: Record<string, string> = {};
        for (const row of r.config) v[row.key] = row.value;
        setValues(v);
      })
      .catch((e) => setError(e.message));
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setMsg('');
    setError('');
    try {
      const updates: Record<string, string> = {};
      for (const k of ALL_KEYS) if (values[k] != null) updates[k] = values[k];
      await apiFetch('/admin/api/config', {
        method: 'PUT',
        body: JSON.stringify({ updates }),
      });
      setMsg('Kaydedildi (D1 — redeploy gerekmez)');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Hata');
    }
  }

  return (
    <AuthGuard>
      <Nav />
      <main className="mx-auto max-w-2xl px-4 py-6">
        <h1 className="mb-1 text-xl font-semibold">Grid ayarları</h1>
        <p className="mb-5 text-sm text-slate-400">
          Tek strateji: Spot Grid. Değişiklikler D1&apos;e yazılır, redeploy gerekmez.
        </p>
        <form onSubmit={save} className="space-y-6">
          {GROUPS.map((group) => (
            <section key={group.title} className="rounded-lg border border-slate-800 bg-slate-900/50 p-4">
              <h2 className="mb-1 text-sm font-semibold text-slate-200">{group.title}</h2>
              {group.desc && <p className="mb-3 text-xs text-slate-500">{group.desc}</p>}
              <div className="space-y-3">
                {group.fields.map((f) => (
                  <div key={f.key}>
                    <label className="mb-1 block text-xs text-slate-400">{f.label}</label>
                    <input
                      value={values[f.key] ?? ''}
                      onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                      className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm"
                      placeholder={f.key}
                    />
                  </div>
                ))}
              </div>
            </section>
          ))}
          <button
            type="submit"
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium hover:bg-emerald-500"
          >
            Kaydet
          </button>
        </form>
        {msg && <p className="mt-3 text-sm text-emerald-400">{msg}</p>}
        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
        <p className="mt-6 text-xs text-slate-500">
          Gerçek/paper anahtarı: <span className="font-mono">live_gate</span>. TRADING_ENABLED yalnızca
          wrangler.toml üzerinden değişir.
        </p>
      </main>
    </AuthGuard>
  );
}
