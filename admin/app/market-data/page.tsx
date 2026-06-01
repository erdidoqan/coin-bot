'use client';

import { useCallback, useEffect, useState } from 'react';
import { AuthGuard } from '@/components/AuthGuard';
import { MarketDataSection } from '@/components/MarketDataSection';
import { Nav } from '@/components/Nav';
import { apiFetch, type MarketDataApiResponse } from '@/lib/api';

export default function MarketDataPage() {
  const [data, setData] = useState<MarketDataApiResponse | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const res = await apiFetch<MarketDataApiResponse>('/admin/api/market-data');
    setData(res);
    setError('');
    return res;
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Hata');
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    load().catch((e) => {
      if (!cancelled) setError(e instanceof Error ? e.message : 'Hata');
    });
    const t = setInterval(() => {
      load().catch(() => {});
    }, 15_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [load]);

  return (
    <AuthGuard>
      <Nav />
      <main className="mx-auto max-w-6xl px-4 py-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">Market verisi</h1>
            <p className="text-sm text-slate-400">WebSocket Durable Object — canlı OB, kline, rejim</p>
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={refreshing}
            className="rounded border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-50"
          >
            {refreshing ? 'Yenileniyor…' : 'Yenile'}
          </button>
        </div>

        {error && <p className="mb-4 text-sm text-red-400">{error}</p>}

        {data && !data.available ? (
          <p className="rounded-lg border border-amber-900/50 bg-amber-950/30 p-4 text-sm text-amber-200">
            Worker’da MARKET_DATA binding tanımlı değil.
          </p>
        ) : (
          <MarketDataSection status={data?.status ?? null} />
        )}

        <p className="mt-4 text-xs text-slate-500">Otomatik yenileme: 15 sn</p>
      </main>
    </AuthGuard>
  );
}
