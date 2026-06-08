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
    title: 'Dip Reversal Sniper (bağımsız strateji)',
    desc: 'Yüksek dalgalı düşüşte capitulation dip + bounce onayı ile al, native trailing ile sat.',
    fields: [
      { key: 'dip_reversal_enabled', label: 'Dip Reversal aktif (true/false) — CANLI gerçek emir' },
      { key: 'dip_reversal_buy_quote_usdt', label: 'İşlem başına alım (USDT)' },
      { key: 'dip_reversal_max_concurrent', label: 'Eşzamanlı max pozisyon' },
      { key: 'dip_reversal_min_capitulation_drop_pct', label: 'Min capitulation düşüşü % (flash windowDrop)' },
      { key: 'dip_reversal_flash_window_min', label: 'Flash pencere (dk, 5m kapanış)' },
      { key: 'dip_reversal_min_ws_decline_pct', label: 'Min WS tick düşüşü % (dip oldu mu)' },
      { key: 'dip_reversal_min_recovery_from_low_pct', label: 'Min diptan toparlanma % (bounce)' },
      { key: 'dip_reversal_min_reversal_score', label: 'Min reversal skoru' },
      { key: 'dip_reversal_max_sec_since_trough', label: 'Dipten max geçen süre (sn)' },
      { key: 'dip_reversal_require_mid_slope', label: 'Yükselen mid eğimi şart (true/false)' },
      { key: 'dip_reversal_trailing_activation_pct', label: 'Trailing aktivasyon % (stopPrice = avgCost*(1+%))' },
      { key: 'dip_reversal_trailing_callback_pct', label: 'Trailing callback % (trailingDelta)' },
      { key: 'dip_reversal_hard_stop_pct', label: 'Hard-stop zarar % (bag koruması)' },
      { key: 'dip_reversal_max_hold_min', label: 'Zaman-stop: max tutma (dk, kârda değilse çık; 0=kapalı)' },
      { key: 'dip_reversal_post_exit_cooldown_min', label: 'Çıkış sonrası bekleme (dk)' },
      { key: 'dip_reversal_regime_filter', label: 'İzinli rejimler (CSV, örn. panic,chop; boş=hepsi)' },
      { key: 'dip_reversal_adapt_enabled', label: 'Rejim adaptasyonu aktif (true/false, varsayılan false)' },
      { key: 'dip_reversal_adapt_downtrend_mode', label: 'Grind modu: tighten veya block (yalnız grind)' },
      { key: 'dip_reversal_adapt_ema_min_sep_pct', label: 'EMA min ayrışma % (altında flat say)' },
      { key: 'dip_reversal_adapt_calm_atr_max', label: 'Sakin/grind ATR üst sınırı %' },
      { key: 'dip_reversal_adapt_volatile_atr_min', label: 'Volatil ATR alt sınırı %' },
      { key: 'dip_reversal_adapt_downtrend_breadth_max', label: 'Risk-off breadth üst sınırı % (0-100)' },
      { key: 'dip_reversal_adapt_calm_drop_mult', label: 'Calm: capitulation çarpanı' },
      { key: 'dip_reversal_adapt_dtvol_drop_mult', label: 'Volatil düşüş: drop çarpanı' },
      { key: 'dip_reversal_adapt_dtvol_reversal_mult', label: 'Volatil düşüş: reversal çarpanı' },
      { key: 'dip_reversal_adapt_dtvol_recovery_mult', label: 'Volatil düşüş: recovery çarpanı' },
      { key: 'dip_reversal_adapt_dtgrind_drop_mult', label: 'Grind: drop çarpanı' },
      { key: 'dip_reversal_adapt_dtgrind_reversal_mult', label: 'Grind: reversal çarpanı' },
      { key: 'dip_reversal_adapt_dtgrind_recovery_mult', label: 'Grind: recovery çarpanı' },
    ],
  },
  {
    title: 'Genel',
    fields: [
      { key: 'live_gate', label: 'Gerçek emir izni (true = CANLI, false = PAPER)' },
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
