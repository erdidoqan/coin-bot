'use client';

import { useState } from 'react';
import { AuthGuard } from '@/components/AuthGuard';
import { Nav } from '@/components/Nav';
import { apiFetch } from '@/lib/api';
import { formatDateTimeIstanbul } from '@/lib/datetime';

const JOBS = [
  { id: 'grid-scout', label: 'Grid scout (watchlist yenile — volatilite/flash filtresi)' },
  { id: 'grid-sweep', label: 'Öksüz bag süpür (break-even satış)' },
  {
    id: 'grid-recover-active',
    label: 'Aktif gridleri kurtarmaya çek',
    confirm:
      'Tüm ACTIVE gridler iptal edilir; envanter break-even+marj LIMIT satışla RECOVERING olur. Devam?',
  },
] as const;

export default function ActionsPage() {
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function runJob(job: (typeof JOBS)[number]) {
    if ('confirm' in job && job.confirm && !window.confirm(job.confirm)) return;

    setLoading(true);
    setMsg('');
    setError('');
    try {
      const r = await apiFetch<{ ok: boolean; job: string; at: string }>(
        '/admin/api/actions/trigger',
        { method: 'POST', body: JSON.stringify({ job: job.id }) },
      );
      setMsg(`${r.job} tamamlandı — ${formatDateTimeIstanbul(r.at)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Hata');
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthGuard>
      <Nav />
      <main className="mx-auto max-w-lg px-4 py-6">
        <h1 className="mb-2 text-xl font-semibold">Manuel aksiyonlar</h1>
        <p className="mb-4 text-xs text-slate-400">
          Grid operasyonları. Kurtarma satırlarından tek tek USDT’ye çevirmek için ana paneli
          kullanın.
        </p>
        <div className="flex flex-col gap-2">
          {JOBS.map((j) => (
            <button
              key={j.id}
              type="button"
              disabled={loading}
              onClick={() => runJob(j)}
              className="rounded-lg border border-slate-700 bg-slate-900 px-4 py-3 text-left text-sm hover:border-emerald-600 disabled:opacity-50"
            >
              {j.label}
            </button>
          ))}
        </div>
        {msg && <p className="mt-4 text-sm text-emerald-400">{msg}</p>}
        {error && <p className="mt-4 text-sm text-red-400">{error}</p>}
      </main>
    </AuthGuard>
  );
}
