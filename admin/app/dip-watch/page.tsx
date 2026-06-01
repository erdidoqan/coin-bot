'use client';

import { useCallback, useEffect, useState } from 'react';
import { AuthGuard } from '@/components/AuthGuard';
import { Nav } from '@/components/Nav';
import {
  apiFetch,
  type DipWatchApiResponse,
  type DipWatchHistoryApiResponse,
} from '@/lib/api';

function fmtPct(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(digits)}%`;
}

function fmtPrice(n: number): string {
  if (n >= 1) return n.toFixed(4);
  if (n >= 0.01) return n.toFixed(6);
  return n.toFixed(8);
}

export default function DipWatchPage() {
  const [data, setData] = useState<DipWatchApiResponse | null>(null);
  const [history, setHistory] = useState<DipWatchHistoryApiResponse | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<'live' | 'history'>('live');

  const load = useCallback(async () => {
    const [main, hist] = await Promise.all([
      apiFetch<DipWatchApiResponse>('/admin/api/dip-watch'),
      apiFetch<DipWatchHistoryApiResponse>('/admin/api/dip-watch/history?limit=50'),
    ]);
    setData(main);
    setHistory(hist);
    setError('');
  }, []);

  useEffect(() => {
    let cancelled = false;
    load().catch((e) => {
      if (!cancelled) setError(e instanceof Error ? e.message : 'Hata');
    });
    const t = setInterval(() => {
      load().catch(() => {});
    }, 5_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [load]);

  const watch = async (symbol: string) => {
    setBusy(symbol);
    try {
      const res = await apiFetch<DipWatchApiResponse>('/admin/api/dip-watch/symbols', {
        method: 'POST',
        body: JSON.stringify({ symbol }),
      });
      setData(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Hata');
    } finally {
      setBusy(null);
    }
  };

  const unwatch = async (symbol: string) => {
    setBusy(symbol);
    try {
      const res = await apiFetch<DipWatchApiResponse>(
        `/admin/api/dip-watch/symbols?symbol=${encodeURIComponent(symbol)}`,
        { method: 'DELETE' },
      );
      setData(res);
      const hist = await apiFetch<DipWatchHistoryApiResponse>(
        '/admin/api/dip-watch/history?limit=50',
      );
      setHistory(hist);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Hata');
    } finally {
      setBusy(null);
    }
  };

  const activeSymbols = new Set(data?.active.map((a) => a.symbol) ?? []);

  return (
    <AuthGuard>
      <Nav />
      <main className="mx-auto max-w-6xl px-4 py-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">Dip Watch</h1>
            <p className="text-sm text-slate-400">
              Likit USDT havuzu (24s konuma göre sıralı) — paper PnL (giriş = izleme anı)
            </p>
          </div>
          <div className="flex gap-2 text-sm">
            <button
              type="button"
              onClick={() => setTab('live')}
              className={`rounded border px-3 py-1.5 ${tab === 'live' ? 'border-amber-500/50 bg-amber-500/10 text-amber-200' : 'border-slate-700 text-slate-400'}`}
            >
              Canlı
            </button>
            <button
              type="button"
              onClick={() => setTab('history')}
              className={`rounded border px-3 py-1.5 ${tab === 'history' ? 'border-amber-500/50 bg-amber-500/10 text-amber-200' : 'border-slate-700 text-slate-400'}`}
            >
              Geçmiş
            </button>
          </div>
        </div>

        {error && <p className="mb-4 text-sm text-red-400">{error}</p>}

        {data && !data.summary.marketDataAvailable && (
          <p className="mb-4 rounded-lg border border-amber-900/50 bg-amber-950/30 p-3 text-sm text-amber-200">
            MARKET_DATA binding yok — REST ticker fallback kullanılıyor.
          </p>
        )}

        {data && tab === 'live' && (
          <>
            <p className="mb-3 text-xs text-slate-500">
              İzleme: {data.summary.activeCount}/{data.summary.maxTracked} · Scanner:{' '}
              {data.summary.quality.poolAfter}/{data.summary.quality.poolBefore} (kalite filtresi
              {data.config.quality.enabled ? ' açık' : ' kapalı'}) · Yenileme: 5 sn
            </p>
            {data.config.quality.enabled && (
              <p className="mb-3 text-xs text-slate-600">
                Spread ≤ {data.config.quality.maxSpreadPct}% · derinlik ±
                {data.config.quality.depthBandPct}% ≥{' '}
                {(data.config.quality.minDepthQuoteUsdt / 1000).toFixed(0)}k USDT · listing ≥{' '}
                {data.config.quality.minListingDays}g · vol/mcap ≤{' '}
                {data.config.quality.maxVolMcapRatio} · dolaşım ≥{' '}
                {data.config.quality.minCirculatingSupplyPct}% · FDV/mcap ≤{' '}
                {data.config.quality.maxFdvToMcapRatio}×
              </p>
            )}

            <section className="mb-8">
              <h2 className="mb-2 text-sm font-medium text-slate-300">İzleme listesi — paper PnL</h2>
              <div className="overflow-x-auto rounded-lg border border-slate-800">
                <table className="w-full min-w-[720px] text-left text-sm">
                  <thead className="bg-slate-900/80 text-xs uppercase text-slate-500">
                    <tr>
                      <th className="px-3 py-2">Sembol</th>
                      <th className="px-3 py-2">Giriş</th>
                      <th className="px-3 py-2">Son</th>
                      <th className="px-3 py-2">PnL</th>
                      <th className="px-3 py-2">Max kâr</th>
                      <th className="px-3 py-2">Max zarar</th>
                      <th className="px-3 py-2">Konum</th>
                      <th className="px-3 py-2">Süre</th>
                      <th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {data.active.length === 0 && (
                      <tr>
                        <td colSpan={9} className="px-3 py-4 text-slate-500">
                          Aktif izleme yok — scanner&apos;dan İzle ile ekleyin
                        </td>
                      </tr>
                    )}
                    {data.active.map((row) => (
                      <tr key={row.id} className="border-t border-slate-800/80">
                        <td className="px-3 py-2 font-mono">{row.symbol}</td>
                        <td className="px-3 py-2 font-mono">{fmtPrice(row.entryPrice)}</td>
                        <td className="px-3 py-2 font-mono">{fmtPrice(row.lastPrice)}</td>
                        <td
                          className={`px-3 py-2 ${(row.unrealizedPct ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}
                        >
                          {fmtPct(row.unrealizedPct)}
                        </td>
                        <td className="px-3 py-2 text-emerald-400/90">{fmtPct(row.maxGainPct)}</td>
                        <td className="px-3 py-2 text-red-400/90">{fmtPct(row.maxDrawPct)}</td>
                        <td className="px-3 py-2">
                          {row.positionPct != null ? `${row.positionPct.toFixed(1)}%` : '—'}
                        </td>
                        <td className="px-3 py-2 text-slate-400">{row.heldHours.toFixed(1)} sa</td>
                        <td className="px-3 py-2 text-right">
                          <button
                            type="button"
                            disabled={busy === row.symbol}
                            onClick={() => void unwatch(row.symbol)}
                            className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-50"
                          >
                            Kapat
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section>
              <h2 className="mb-2 text-sm font-medium text-slate-300">
                Scanner — kalite filtreli likit USDT (dipte → tepede)
              </h2>
              <div className="overflow-x-auto rounded-lg border border-slate-800">
                <table className="w-full min-w-[800px] text-left text-sm">
                  <thead className="bg-slate-900/80 text-xs uppercase text-slate-500">
                    <tr>
                      <th className="px-3 py-2">Sembol</th>
                      <th className="px-3 py-2">Konum</th>
                      <th className="px-3 py-2">Spread</th>
                      <th className="px-3 py-2">Vol/MCap</th>
                      <th className="px-3 py-2">Listing</th>
                      <th className="px-3 py-2">Son</th>
                      <th className="px-3 py-2">24s L/H</th>
                      <th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {data.scanner.length === 0 && (
                      <tr>
                        <td colSpan={8} className="px-3 py-4 text-slate-500">
                          Kalite filtresinden sonra aday kalmadı
                        </td>
                      </tr>
                    )}
                    {data.scanner.map((row) => (
                      <tr key={row.symbol} className="border-t border-slate-800/80">
                        <td className="px-3 py-2 font-mono">{row.symbol}</td>
                        <td className="px-3 py-2 text-amber-300">{row.positionPct.toFixed(1)}%</td>
                        <td className="px-3 py-2 font-mono text-xs">
                          {row.spreadPct != null ? `${row.spreadPct.toFixed(3)}%` : '—'}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs">
                          {row.volMcapRatio != null ? row.volMcapRatio.toFixed(2) : '—'}
                        </td>
                        <td className="px-3 py-2 text-xs text-slate-400">
                          {row.listingDays != null ? `${Math.floor(row.listingDays)}g` : '—'}
                        </td>
                        <td className="px-3 py-2 font-mono">{fmtPrice(row.lastPrice)}</td>
                        <td className="px-3 py-2 font-mono text-xs text-slate-400">
                          {fmtPrice(row.low24h)} / {fmtPrice(row.high24h)}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {activeSymbols.has(row.symbol) ? (
                            <span className="text-xs text-slate-500">İzleniyor</span>
                          ) : (
                            <button
                              type="button"
                              disabled={busy === row.symbol}
                              onClick={() => void watch(row.symbol)}
                              className="rounded border border-emerald-800 px-2 py-1 text-xs text-emerald-300 hover:bg-emerald-950 disabled:opacity-50"
                            >
                              İzle
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}

        {history && tab === 'history' && (
          <>
            <div className="mb-4 grid gap-3 sm:grid-cols-4">
              <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-3">
                <p className="text-xs text-slate-500">Kapanan</p>
                <p className="text-lg font-semibold">{history.summary.closedCount}</p>
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-3">
                <p className="text-xs text-slate-500">Kâr / Zarar</p>
                <p className="text-lg font-semibold">
                  <span className="text-emerald-400">{history.summary.winCount}</span>
                  {' / '}
                  <span className="text-red-400">{history.summary.lossCount}</span>
                </p>
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-3">
                <p className="text-xs text-slate-500">Ort. PnL</p>
                <p className="text-lg font-semibold">{fmtPct(history.summary.avgPnlPct)}</p>
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-3">
                <p className="text-xs text-slate-500">Toplam PnL</p>
                <p className="text-lg font-semibold">{fmtPct(history.summary.totalPnlPct)}</p>
              </div>
            </div>

            <div className="overflow-x-auto rounded-lg border border-slate-800">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead className="bg-slate-900/80 text-xs uppercase text-slate-500">
                  <tr>
                    <th className="px-3 py-2">Sembol</th>
                    <th className="px-3 py-2">Giriş</th>
                    <th className="px-3 py-2">Çıkış</th>
                    <th className="px-3 py-2">PnL</th>
                    <th className="px-3 py-2">Max kâr</th>
                    <th className="px-3 py-2">Max zarar</th>
                    <th className="px-3 py-2">Giriş konum</th>
                    <th className="px-3 py-2">Süre</th>
                  </tr>
                </thead>
                <tbody>
                  {history.rows.length === 0 && (
                    <tr>
                      <td colSpan={8} className="px-3 py-4 text-slate-500">
                        Henüz kapanmış kayıt yok
                      </td>
                    </tr>
                  )}
                  {history.rows.map((row) => (
                    <tr key={row.id} className="border-t border-slate-800/80">
                      <td className="px-3 py-2 font-mono">{row.symbol}</td>
                      <td className="px-3 py-2 font-mono text-xs">
                        {fmtPrice(row.entryPrice)}
                        <span className="block text-slate-500">{row.entryAt.slice(0, 16)}</span>
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">
                        {row.exitPrice != null ? fmtPrice(row.exitPrice) : '—'}
                        {row.exitAt && (
                          <span className="block text-slate-500">{row.exitAt.slice(0, 16)}</span>
                        )}
                      </td>
                      <td
                        className={`px-3 py-2 ${(row.realizedPct ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}
                      >
                        {fmtPct(row.realizedPct)}
                      </td>
                      <td className="px-3 py-2">{fmtPct(row.maxGainPct)}</td>
                      <td className="px-3 py-2">{fmtPct(row.maxDrawPct)}</td>
                      <td className="px-3 py-2">
                        {row.entryPositionPct != null
                          ? `${row.entryPositionPct.toFixed(1)}%`
                          : '—'}
                      </td>
                      <td className="px-3 py-2 text-slate-400">
                        {row.heldHours != null ? `${row.heldHours.toFixed(1)} sa` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </main>
    </AuthGuard>
  );
}
