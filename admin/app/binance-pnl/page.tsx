'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AuthGuard } from '@/components/AuthGuard';
import { Nav } from '@/components/Nav';
import { apiFetch, type BinanceRangePnlData } from '@/lib/api';
import { formatUsdt } from '@/lib/format';

type PnlBucket = 'hour' | 'day';

export default function BinancePnlPage() {
  const defaults = useMemo(() => defaultRange(), []);
  const [rangeFrom, setRangeFrom] = useState(defaults.fromLocal);
  const [rangeTo, setRangeTo] = useState(defaults.toLocal);
  const [bucket, setBucket] = useState<PnlBucket>('hour');
  const [data, setData] = useState<BinanceRangePnlData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const loadBinancePnlRange = useCallback(
    async (opts: { fromLocal: string; toLocal: string; bucket: PnlBucket }) => {
      const startMs = new Date(opts.fromLocal).getTime();
      const endMs = new Date(opts.toLocal).getTime();
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
        throw new Error('Geçersiz tarih aralığı');
      }
      if (startMs >= endMs) {
        throw new Error('Başlangıç zamanı bitişten küçük olmalı');
      }

      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Istanbul';
      const params = new URLSearchParams({
        startMs: String(startMs),
        endMs: String(endMs),
        bucket: opts.bucket,
        timezone,
      });

      setLoading(true);
      try {
        const report = await apiFetch<BinanceRangePnlData>(`/admin/api/pnl/binance-range?${params.toString()}`);
        setData(report);
        setError('');
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Binance PnL alınamadı');
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const applyFilter = useCallback(async () => {
    if (!rangeFrom || !rangeTo) {
      setError('Tarih aralığını seçin');
      return;
    }
    await loadBinancePnlRange({ fromLocal: rangeFrom, toLocal: rangeTo, bucket });
  }, [bucket, loadBinancePnlRange, rangeFrom, rangeTo]);

  useEffect(() => {
    loadBinancePnlRange({
      fromLocal: defaults.fromLocal,
      toLocal: defaults.toLocal,
      bucket: 'hour',
    }).catch(() => {});
  }, [defaults.fromLocal, defaults.toLocal, loadBinancePnlRange]);

  return (
    <AuthGuard>
      <Nav />
      <main className="mx-auto max-w-6xl px-4 py-6">
        <div className="mb-4">
          <h1 className="text-xl font-semibold">Binance PnL (tarih aralığı)</h1>
          <p className="mt-1 text-sm text-slate-400">
            Zaman aralığını seçip Binance doğrulamalı PnL raporunu ayrı ekranda inceleyin.
          </p>
        </div>

        <section className="rounded-lg border border-slate-800 bg-slate-900 p-4">
          <div className="mb-4 flex flex-wrap items-end gap-3">
            <label className="text-xs text-slate-400">
              Başlangıç
              <input
                type="datetime-local"
                value={rangeFrom}
                onChange={(e) => setRangeFrom(e.target.value)}
                className="mt-1 block rounded border border-slate-700 bg-slate-950 px-2 py-1 text-slate-200"
              />
            </label>
            <label className="text-xs text-slate-400">
              Bitiş
              <input
                type="datetime-local"
                value={rangeTo}
                onChange={(e) => setRangeTo(e.target.value)}
                className="mt-1 block rounded border border-slate-700 bg-slate-950 px-2 py-1 text-slate-200"
              />
            </label>
            <label className="text-xs text-slate-400">
              Kırılım
              <select
                value={bucket}
                onChange={(e) => setBucket(e.target.value === 'day' ? 'day' : 'hour')}
                className="mt-1 block rounded border border-slate-700 bg-slate-950 px-2 py-1 text-slate-200"
              >
                <option value="hour">Saatlik</option>
                <option value="day">Günlük</option>
              </select>
            </label>
            <button
              type="button"
              onClick={() => applyFilter()}
              disabled={loading}
              className="rounded-md border border-slate-600 bg-slate-800 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-50"
            >
              {loading ? 'Yükleniyor…' : 'Uygula'}
            </button>
          </div>

          {data && (
            <p className="mb-4 text-xs text-slate-500">
              Saat dilimi: {data.range.timezone}
              {data.range.truncated ? ' · sonuçlar kısaltıldı (500 kapanış)' : ''}
            </p>
          )}

          {error && <p className="mb-3 text-sm text-red-400">{error}</p>}

          {!data && loading && <LoadingPlaceholder />}

          {data && (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
                <PnlCard
                  label="Toplam PnL (USDT)"
                  value={formatPnl(data.summary.totalPnlUsdt)}
                  tone={pnlTone(data.summary.totalPnlUsdt)}
                />
                <PnlCard label="Kapanış sayısı" value={String(data.summary.tradeCount)} tone="neutral" />
                <PnlCard label="Toplam harcanan" value={formatUsdt(data.summary.totalSpentUsdt)} tone="muted" />
                <PnlCard label="Toplam gelir" value={formatUsdt(data.summary.totalProceedsUsdt)} tone="muted" />
                <PnlCard
                  label="Doğrulama"
                  value={`${data.summary.verifiedCount} Binance`}
                  tone="neutral"
                  sub={`fallback ${data.summary.fallbackCount}`}
                />
              </div>

              {data.buckets.length > 0 ? (
                <div className="overflow-x-auto rounded-lg border border-slate-800">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-950 text-slate-400">
                      <tr>
                        <th className="px-2 py-2">{data.range.bucket === 'day' ? 'Gün' : 'Saat'}</th>
                        <th className="px-2 py-2">İşlem</th>
                        <th className="px-2 py-2">Harcanan</th>
                        <th className="px-2 py-2">Gelir</th>
                        <th className="px-2 py-2">PnL</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.buckets.map((row) => (
                        <tr key={row.bucket} className="border-t border-slate-800">
                          <td className="px-2 py-1 font-mono text-slate-300">{row.bucket}</td>
                          <td className="px-2 py-1">{row.trades}</td>
                          <td className="px-2 py-1">{formatUsdt(row.spentUsdt)}</td>
                          <td className="px-2 py-1">{formatUsdt(row.proceedsUsdt)}</td>
                          <td className={`px-2 py-1 font-mono ${pnlToneClass(row.pnlUsdt)}`}>
                            {formatPnl(row.pnlUsdt)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-sm text-slate-500">Bu aralıkta kapanan işlem bulunamadı.</p>
              )}

              {data.closes.length > 0 && (
                <div className="overflow-x-auto rounded-lg border border-slate-800">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-950 text-slate-400">
                      <tr>
                        <th className="px-2 py-2">Kapanış</th>
                        <th className="px-2 py-2">Sembol</th>
                        <th className="px-2 py-2">Kaynak</th>
                        <th className="px-2 py-2">Harcanan</th>
                        <th className="px-2 py-2">Gelir</th>
                        <th className="px-2 py-2">PnL</th>
                        <th className="px-2 py-2">Doğrulama</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.closes.slice(0, 50).map((close) => (
                        <tr key={close.id} className="border-t border-slate-800">
                          <td className="px-2 py-1 text-slate-400">{close.closedAtLocal}</td>
                          <td className="px-2 py-1 font-mono">{close.symbol}</td>
                          <td className="px-2 py-1 text-slate-500">{close.source ?? '—'}</td>
                          <td className="px-2 py-1">{formatUsdt(close.spentUsdt)}</td>
                          <td className="px-2 py-1">{formatUsdt(close.proceedsUsdt)}</td>
                          <td className={`px-2 py-1 font-mono ${pnlToneClass(close.pnlUsdt)}`}>
                            {formatPnl(close.pnlUsdt)}
                          </td>
                          <td
                            className={`px-2 py-1 ${
                              close.verification === 'binance' ? 'text-emerald-400' : 'text-amber-400'
                            }`}
                            title={close.note ?? ''}
                          >
                            {close.verification}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </section>
      </main>
    </AuthGuard>
  );
}

function defaultRange(): { fromLocal: string; toLocal: string } {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return {
    fromLocal: toLocalDateTimeInput(start),
    toLocal: toLocalDateTimeInput(now),
  };
}

function toLocalDateTimeInput(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${d}T${hh}:${mm}`;
}

function formatPnl(value: string): string {
  const n = Number(value);
  if (Number.isNaN(n)) return value;
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(4)}`;
}

function pnlTone(value: string): 'up' | 'down' | 'neutral' | 'muted' {
  const n = Number(value);
  if (Number.isNaN(n) || n === 0) return 'neutral';
  return n > 0 ? 'up' : 'down';
}

function pnlToneClass(value: string): string {
  const tone = pnlTone(value);
  if (tone === 'up') return 'text-emerald-400';
  if (tone === 'down') return 'text-red-400';
  return 'text-slate-200';
}

function pnlClass(tone: 'up' | 'down' | 'neutral' | 'muted'): string {
  if (tone === 'up') return 'text-emerald-400';
  if (tone === 'down') return 'text-red-400';
  if (tone === 'muted') return 'text-slate-400';
  return 'text-slate-200';
}

function PnlCard({
  label,
  value,
  tone,
  sub,
}: {
  label: string;
  value: string;
  tone: 'up' | 'down' | 'neutral' | 'muted';
  sub?: string;
}) {
  return (
    <div>
      <p className="text-xs text-slate-400">{label}</p>
      <p className={`text-xl font-semibold ${pnlClass(tone)}`}>{value}</p>
      {sub && <p className="text-xs text-slate-500">{sub}</p>}
    </div>
  );
}

function LoadingPlaceholder() {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, idx) => (
          <div key={idx} className="rounded border border-slate-800 bg-slate-950 p-3">
            <div className="h-3 w-24 animate-pulse rounded bg-slate-800" />
            <div className="mt-2 h-5 w-20 animate-pulse rounded bg-slate-800" />
          </div>
        ))}
      </div>
      <div className="h-40 animate-pulse rounded border border-slate-800 bg-slate-950" />
    </div>
  );
}
