'use client';

import { useCallback, useEffect, useState } from 'react';
import { AuthGuard } from '@/components/AuthGuard';
import { Nav } from '@/components/Nav';
import { LogEntry } from '@/components/LogEntry';
import {
  apiFetch,
  type GridDashboard,
  type GridCandidateRow,
  type GridMarketGate,
  type GridLadderLevel,
  type GridStatusReport,
  type GridRecoveryRow,
  type OrphanReport,
  type OrphanBalanceRow,
} from '@/lib/api';
import { formatDateTimeIstanbul, parseDbTimestamp } from '@/lib/datetime';
import { blockerHint, blockerLabel } from '@/lib/grid-blockers';

function num(v: number | null | undefined, d = 2): string {
  return v == null || Number.isNaN(v) ? '—' : v.toFixed(d);
}
function pnlTone(v: string | number): string {
  const n = Number(v);
  if (Number.isNaN(n) || n === 0) return 'text-slate-200';
  return n > 0 ? 'text-emerald-400' : 'text-red-400';
}
function signed(v: string | number, d = 4): string {
  const n = Number(v);
  if (Number.isNaN(n)) return String(v);
  return `${n > 0 ? '+' : ''}${n.toFixed(d)}`;
}
// Fiyat büyüklüğüne göre ondalık sayısı (float gürültüsünü temizler).
function priceDecimals(ref: number | null | undefined): number {
  const p = Math.abs(ref ?? 0);
  if (p >= 1000) return 2;
  if (p >= 100) return 3;
  if (p >= 1) return 4;
  if (p >= 0.1) return 4;
  if (p >= 0.01) return 5;
  return 6;
}
function fmtPrice(v: number | null | undefined, dec: number): string {
  return v == null || Number.isNaN(v) ? '—' : v.toFixed(dec);
}
function fmtQty(v: number): string {
  if (!(v > 0)) return '0';
  if (v >= 100) return v.toFixed(2);
  if (v >= 1) return v.toFixed(4);
  return v.toFixed(6);
}

export default function DashboardPage() {
  const [data, setData] = useState<GridDashboard | null>(null);
  const [candidates, setCandidates] = useState<GridCandidateRow[] | null>(null);
  const [marketGate, setMarketGate] = useState<GridMarketGate | null>(null);
  const [orphans, setOrphans] = useState<OrphanReport | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState('');
  const [convertingId, setConvertingId] = useState<number | null>(null);
  const [cancelingId, setCancelingId] = useState<number | null>(null);
  const [forceBusy, setForceBusy] = useState(false);

  const load = useCallback(async () => {
    // Çekirdek dashboard (hızlı) — adaylar + öksüzler ayrı/progressive.
    const d = await apiFetch<GridDashboard>('/admin/api/grid-dashboard');
    setData(d);
    setError('');
    // Adaylar (yavaş: REST kline fallback) arka planda yüklenir, çekirdeği bloklamaz.
    apiFetch<{ candidates: GridCandidateRow[]; marketGate: GridMarketGate }>(
      '/admin/api/grid-candidates',
    )
      .then((c) => {
        setCandidates(c.candidates);
        setMarketGate(c.marketGate);
      })
      .catch(() => {});
    // Öksüz bakiyeler (myTrades çağrıları) ayrı yüklenir.
    apiFetch<OrphanReport>('/admin/api/grid-orphans')
      .then((o) => setOrphans(o))
      .catch(() => {});
  }, []);

  const runAction = useCallback(
    async (job: 'grid-sweep' | 'dust-convert', label: string) => {
      setActionBusy(job);
      setActionMsg('');
      try {
        await apiFetch('/admin/api/actions/trigger', {
          method: 'POST',
          body: JSON.stringify({ job }),
        });
        setActionMsg(`${label} tetiklendi — birkaç saniye sonra güncelleniyor…`);
        setTimeout(() => {
          load().catch(() => {});
          setActionBusy(null);
        }, 6000);
      } catch (e) {
        setActionMsg(e instanceof Error ? e.message : 'Hata');
        setActionBusy(null);
      }
    },
    [load],
  );

  const cancelGrid = useCallback(
    async (g: GridStatusReport) => {
      if (g.gridId == null) return;
      const sym = (g.symbol ?? '').replace('USDT', '');
      if (
        !window.confirm(
          `${sym}: Grid iptal edilsin mi?\n\nBinance'teki açık emirler iptal edilir, grid durur. Cüzdandaki coin satılmaz.`,
        )
      ) {
        return;
      }
      setCancelingId(g.gridId);
      setError('');
      try {
        const res = await apiFetch<{
          ok: boolean;
          message: string;
          ordersCanceled?: number;
        }>('/admin/api/grid-cancel', {
          method: 'POST',
          body: JSON.stringify({ gridId: g.gridId }),
        });
        if (!res.ok) {
          setError(res.message || 'İptal başarısız');
          return;
        }
        const n = res.ordersCanceled ?? 0;
        setActionMsg(
          `${sym} iptal edildi · ${n > 0 ? `${n} emir iptal` : 'emir yok / kurtarma emri iptal'}`,
        );
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'İptal hatası');
      } finally {
        setCancelingId(null);
      }
    },
    [load],
  );

  const convertRecovery = useCallback(
    async (row: GridRecoveryRow) => {
      const sym = row.symbol.replace('USDT', '');
      if (
        !window.confirm(
          `${sym}: ${row.qty} adet market satışla USDT'ye çevrilsin mi?\n\nGerekirse zararına satılır; sonuç "Bugün realize" tablosuna yazılır.`,
        )
      ) {
        return;
      }
      setConvertingId(row.gridId);
      setError('');
      try {
        const res = await apiFetch<{
          ok: boolean;
          message: string;
          pnl?: string;
          proceeds?: string;
        }>('/admin/api/grid-recovery-convert', {
          method: 'POST',
          body: JSON.stringify({ gridId: row.gridId }),
        });
        if (!res.ok) {
          setError(res.message || 'Dönüşüm başarısız');
          return;
        }
        const pnl = res.pnl ?? '0';
        setActionMsg(
          `${sym} USDT'ye çevrildi · PnL ${signed(pnl)} USDT${res.proceeds ? ` · gelir ${res.proceeds}` : ''}`,
        );
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Dönüşüm hatası');
      } finally {
        setConvertingId(null);
      }
    },
    [load],
  );

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
    load().catch((e) => setError(e instanceof Error ? e.message : 'Hata'));
    const t = setInterval(() => load().catch(() => {}), 15_000);
    return () => clearInterval(t);
  }, [load]);

  const live = data?.tradingEnabled === 'true' && data?.liveGate;
  const grids = data?.grids ?? [];
  const recovering = data?.recovering ?? [];
  const forceActive =
    marketGate?.forceActive ?? data?.marketDownturnForceActive ?? false;
  const autoDownturnActive =
    Boolean(marketGate?.active) && !marketGate?.reasons.includes('force_active');

  const toggleForceDownturn = useCallback(async () => {
    const next = !forceActive;
    setForceBusy(true);
    setActionMsg('');
    setError('');
    try {
      await apiFetch('/admin/api/config', {
        method: 'PUT',
        body: JSON.stringify({
          updates: { grid_market_downturn_force_active: next ? 'true' : 'false' },
        }),
      });
      setActionMsg(
        next
          ? 'Manuel piyasa düşüş kilidi açıldı — yeni grid kurulmaz.'
          : 'Manuel kilidi kapatıldı — otomatik eşikler geçerli.',
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kilidi kaydedemedim');
    } finally {
      setForceBusy(false);
    }
  }, [forceActive, load]);

  return (
    <AuthGuard>
      <Nav />
      <main className="mx-auto max-w-6xl px-4 py-4 sm:py-6">
        {error && <p className="mb-4 text-red-400">{error}</p>}
        {actionMsg && <p className="mb-4 text-xs text-amber-300">{actionMsg}</p>}
        {!data && !error && <p className="text-slate-400">Yükleniyor…</p>}
        {data && (
          <div className="space-y-5">
            {/* Üst kartlar */}
            <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-6">
              <Card title="Mod">
                <span className="rounded bg-indigo-600 px-2 py-0.5 text-sm">GRID</span>
              </Card>
              <Card title="Emir modu">
                <span className={live ? 'text-red-400' : 'text-emerald-400'}>
                  {live ? 'CANLI' : 'PAPER'}
                </span>
              </Card>
              <Card title="Aktif grid">
                <span className="font-mono">
                  {grids.length}/{data.maxConcurrent}
                </span>
              </Card>
              <Card title="Realize (bugün)">
                <span className={pnlTone(data.totals.realizedPnlToday)}>
                  {signed(data.totals.realizedPnlToday)} USDT
                </span>
                <span className="ml-1 text-[11px] text-slate-500">
                  ({data.totals.cyclesToday})
                </span>
              </Card>
              <Card title="Toplam cycle">{data.totals.cyclesAllTime}</Card>
              <Card title="Kurtarma">
                <span className="font-mono">{data.totals.recoveringCount}</span>
              </Card>
            </div>

            <div className="flex items-center justify-between">
              <h2 className="text-lg font-medium">Aktif Pozisyonlar ({grids.length})</h2>
              <button
                type="button"
                onClick={() => refresh()}
                disabled={refreshing}
                className="rounded-md border border-slate-600 bg-slate-800 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-50"
              >
                {refreshing ? '…' : 'Güncelle'}
              </button>
            </div>

            {grids.length > 0 ? (
              <div className="grid gap-4 lg:grid-cols-2">
                {grids.map((g) => (
                  <GridCard
                    key={g.gridId ?? g.symbol}
                    g={g}
                    cancelBusy={cancelingId === g.gridId}
                    onCancel={cancelGrid}
                  />
                ))}
              </div>
            ) : (
              <section className="rounded border border-amber-800/50 bg-amber-950/30 px-3 py-3 text-sm text-amber-200">
                Aktif grid yok — sistem uygun (ranging) aday bekliyor. Aşağıdaki adaylardan biri
                koşulları sağlayınca grid otomatik kurulur (körü körüne girilmez).
              </section>
            )}

            {recovering.length > 0 && (
              <section>
                <h2 className="mb-2 text-lg font-medium">
                  Kurtarma pozisyonları (bekleyen çıkış) ({recovering.length})
                </h2>
                <p className="mb-3 text-xs text-slate-400">
                  Aralık altına düşen gridler zararına satılmaz; break-even + fee + marj ile
                  LIMIT_MAKER satış beklenir. Slot serbest — yeni grid açılabilir. Beklemek
                  istemezsen satırdan <strong className="text-red-300">USDT’ye çevir</strong> ile
                  market satış yapılır (zarar realize tablosuna kırmızı yazılır).
                </p>
                <div className="overflow-x-auto rounded-lg border border-slate-800">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-900 text-slate-400">
                      <tr>
                        <th className="px-2 py-2">Sembol</th>
                        <th className="px-2 py-2">Miktar</th>
                        <th className="px-2 py-2">Cüzdan</th>
                        <th className="px-2 py-2">USDT</th>
                        <th className="px-2 py-2">Ort. maliyet</th>
                        <th className="px-2 py-2">Hedef satış</th>
                        <th className="px-2 py-2">Güncel</th>
                        <th className="px-2 py-2 min-w-[10rem]">Hedefe ilerleme</th>
                        <th className="px-2 py-2">Bekleme</th>
                        <th className="px-2 py-2">İşlem</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recovering.map((r) => (
                        <RecoveryRow
                          key={r.gridId}
                          r={r}
                          busy={convertingId === r.gridId}
                          onConvert={convertRecovery}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {/* Öksüz bakiyeler — takipsiz cüzdan envanteri */}
            <OrphanSection
              report={orphans}
              actionBusy={actionBusy}
              actionMsg={actionMsg}
              onSweep={() => runAction('grid-sweep', 'Süpürme (sat/recovery)')}
              onDust={() => runAction('dust-convert', 'Dust → BNB')}
            />

            <section className="rounded-lg border border-slate-800 bg-slate-900/50 px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <h2 className="text-sm font-medium text-slate-200">
                    Piyasa düşüş kilidi (manuel)
                  </h2>
                  <p className="mt-1 text-xs text-slate-500">
                    Açıkken eşiklere bakılmadan yeni grid kurulmaz. Kapalıyken yalnızca otomatik
                    panic/breadth/BTC kuralları devreye girer.
                  </p>
                  {marketGate && (
                    <p className="mt-2 text-xs text-slate-400">
                      Otomatik kapı:{' '}
                      <span className={autoDownturnActive ? 'text-red-300' : 'text-slate-300'}>
                        {autoDownturnActive ? 'aktif' : 'pasif'}
                      </span>
                      {autoDownturnActive && marketGate.reasons.length > 0 && (
                        <span className="text-slate-500">
                          {' '}
                          ({marketGate.reasons.join(', ')} · breadth {marketGate.breadthPct}%
                          {marketGate.btc24hChangePct != null
                            ? ` · BTC 24s ${marketGate.btc24hChangePct.toFixed(2)}%`
                            : ''}
                          )
                        </span>
                      )}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span
                    className={`text-xs font-medium ${forceActive ? 'text-red-300' : 'text-slate-400'}`}
                  >
                    {forceBusy ? '…' : forceActive ? 'Kilitli' : 'Serbest'}
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={forceActive}
                    aria-label="Manuel piyasa düşüş kilidi"
                    disabled={forceBusy}
                    onClick={() => void toggleForceDownturn()}
                    className={`relative h-7 w-12 rounded-full transition-colors disabled:opacity-50 ${
                      forceActive ? 'bg-red-600' : 'bg-slate-600'
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 block h-6 w-6 rounded-full bg-white shadow transition-transform ${
                        forceActive ? 'translate-x-5' : 'translate-x-0.5'
                      }`}
                    />
                  </button>
                </div>
              </div>
            </section>

            {/* Aday readiness — "Giriş hazır" tablosu */}
            <section>
              <h2 className="mb-2 text-lg font-medium">Aday Uygunluk (grid readiness)</h2>
              <p className="mb-3 text-xs text-slate-400">
                Liste: 15 dk scout (hacim + risk filtresi). Son 1 saatte sürekli düşen coinler listeye
                alınmaz. <strong className="text-slate-300">Hazır</strong> = tüm kontroller yeşil.{' '}
                <strong className="text-slate-300">Engel</strong> sütununda neden girilmediği Türkçe yazar.
              </p>
              {marketGate?.active && (
                <div className="mb-3 rounded-lg border border-red-800/60 bg-red-950/40 px-3 py-2 text-xs text-red-200">
                  Piyasa düşüş modu aktif — yeni grid kurulmaz (açık gridler süpürülür).
                  {marketGate.reasons.includes('force_active') && (
                    <span className="ml-1 font-medium text-red-100">[manuel kilidi]</span>
                  )}
                  {marketGate.reasons.length > 0 && (
                    <span className="ml-1 text-red-300/90">
                      ({marketGate.reasons.join(', ')} · breadth {marketGate.breadthPct}%
                      {marketGate.btc24hChangePct != null
                        ? ` · BTC 24s ${marketGate.btc24hChangePct.toFixed(2)}%`
                        : ''}
                      )
                    </span>
                  )}
                </div>
              )}
              <div className="overflow-x-auto rounded-lg border border-slate-800">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-900 text-slate-400">
                    <tr>
                      <th className="px-2 py-2">Sembol</th>
                      <th className="px-2 py-2 min-w-[8rem]">Hazırlık</th>
                      <th className="px-2 py-2">Flash</th>
                      <th className="px-2 py-2">Path×</th>
                      <th className="px-2 py-2">Düşüş%</th>
                      <th className="px-2 py-2">Skor</th>
                      <th className="px-2 py-2">EffRatio</th>
                      <th className="px-2 py-2">Aralık%</th>
                      <th className="px-2 py-2">ATR%</th>
                      <th className="px-2 py-2">Spread%</th>
                      <th className="px-2 py-2" title="Geçen kontrol / toplam">
                        Kapı
                      </th>
                      <th className="min-w-[9rem] px-2 py-2">Neden hazır değil?</th>
                    </tr>
                  </thead>
                  <tbody>
                    {candidates == null ? (
                      <tr>
                        <td colSpan={12} className="px-3 py-4 text-slate-500">
                          Adaylar yükleniyor…
                        </td>
                      </tr>
                    ) : candidates.length === 0 ? (
                      <tr>
                        <td colSpan={12} className="px-3 py-4 text-slate-500">
                          Aday yok — Gözcü (15dk) çalışınca dolar
                        </td>
                      </tr>
                    ) : (
                      candidates.map((c) => (
                        <CandidateRow key={c.symbol} c={c} marketGate={marketGate} />
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            {/* Bugün realize (TR 00:00'dan beri, cycle + kurtarma) */}
            <section>
              <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-lg font-medium">Bugün realize (cycle + kurtarma)</h2>
                <span className="text-sm text-slate-400">
                  {data.totals.cyclesToday} işlem ·{' '}
                  <span className={pnlTone(data.totals.realizedPnlToday)}>
                    {signed(data.totals.realizedPnlToday)} USDT
                  </span>
                </span>
              </div>
              {data.recentCycles.length === 0 ? (
                <p className="text-sm text-slate-500">Bugün (TR saati) realize işlem yok</p>
              ) : (
                <div className="max-h-96 overflow-auto rounded-lg border border-slate-800">
                  <table className="w-full text-left text-xs">
                    <thead className="sticky top-0 bg-slate-900 text-slate-400">
                      <tr>
                        <th className="px-2 py-2">Zaman</th>
                        <th className="px-2 py-2">Sembol</th>
                        <th className="px-2 py-2">Tür</th>
                        <th className="px-2 py-2">PnL (USDT)</th>
                        <th className="px-2 py-2">Max düşüş</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.recentCycles.map((c, i) => (
                        <tr key={i} className="border-t border-slate-800">
                          <td className="px-2 py-1 text-slate-500">
                            {formatDateTimeIstanbul(c.at)}
                          </td>
                          <td className="px-2 py-1 font-mono">{c.symbol}</td>
                          <td className="px-2 py-1">
                            {c.kind === 'recovery' ? (
                              c.source === 'manual_convert' ? (
                                <span className="rounded bg-red-900/40 px-1 py-0.5 text-[10px] text-red-300">
                                  manuel çıkış
                                </span>
                              ) : (
                                <span className="rounded bg-amber-900/40 px-1 py-0.5 text-[10px] text-amber-300">
                                  kurtarma
                                </span>
                              )
                            ) : (
                              <span className="text-slate-500">cycle</span>
                            )}
                          </td>
                          <td className={`px-2 py-1 font-mono ${pnlTone(c.pnl)}`}>{signed(c.pnl)}</td>
                          <td className="px-2 py-1 font-mono text-slate-400">
                            {c.maxAdversePct != null ? `${c.maxAdversePct}%` : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* Loglar */}
            <section>
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-lg font-medium">Son olaylar</h2>
                <a href="/admin/logs/" className="text-sm text-emerald-400 hover:underline">
                  Tüm loglar →
                </a>
              </div>
              <ul className="space-y-2">
                {data.recentLogs.length === 0 ? (
                  <li className="text-sm text-slate-500">Henüz kayıt yok</li>
                ) : (
                  data.recentLogs.map((l) => <LogEntry key={l.id} {...l} compact />)
                )}
              </ul>
            </section>
          </div>
        )}
      </main>
    </AuthGuard>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900 p-2.5 sm:p-3 lg:p-4">
      <p className="mb-1 text-[11px] leading-tight text-slate-400 sm:text-xs">{title}</p>
      <div className="text-sm leading-tight sm:text-base lg:text-lg">{children}</div>
    </div>
  );
}

function formatWait(ms: number): string {
  if (!(ms > 0)) return '0dk';
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 60) return `${totalMin}dk`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h < 24) return `${h}sa ${m}dk`;
  const d = Math.floor(h / 24);
  return `${d}g ${h % 24}sa`;
}

// Hedef satışa ne kadar yaklaşıldığını gösteren dolan bar (uzaklık küçüldükçe dolar).
function RecoveryProgress({ distancePct }: { distancePct: number | null }) {
  const MAX_GAP = 8; // %8+ uzaklık = boş bar
  const ready = distancePct != null && distancePct <= 0;
  const fill =
    distancePct == null
      ? 0
      : ready
        ? 100
        : Math.max(0, Math.min(100, (1 - distancePct / MAX_GAP) * 100));
  const barColor = ready
    ? 'bg-emerald-500'
    : fill >= 75
      ? 'bg-emerald-500'
      : fill >= 40
        ? 'bg-amber-400'
        : 'bg-red-500';
  const label =
    distancePct == null ? '—' : ready ? 'satışa hazır' : `%${num(distancePct, 2)} uzak`;
  return (
    <div className="min-w-[9rem]">
      <div className="mb-0.5 flex justify-between text-[10px] text-slate-400">
        <span className={ready ? 'text-emerald-300' : ''}>{label}</span>
        <span className="tabular-nums text-slate-500">{Math.round(fill)}%</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800">
        <div
          className={`h-full rounded-full transition-all ${barColor}`}
          style={{ width: `${fill}%` }}
        />
      </div>
    </div>
  );
}

function RecoveryRow({
  r,
  onConvert,
  busy,
}: {
  r: GridRecoveryRow;
  onConvert: (r: GridRecoveryRow) => void;
  busy: boolean;
}) {
  const dec = priceDecimals(Number(r.targetPrice) || r.lastPrice);
  const waitMs = Date.now() - parseDbTimestamp(r.waitingSince).getTime();
  const loss = r.unrealizedPct != null && r.unrealizedPct < 0;
  return (
    <tr className="border-t border-slate-800 bg-amber-950/20">
      <td className="px-2 py-2 font-mono">{r.symbol.replace('USDT', '')}</td>
      <td className="px-2 py-2 font-mono tabular-nums" title="Bu grid recovery_qty">
        {r.qty}
      </td>
      <td className="px-2 py-2 text-[10px] leading-snug text-slate-400">
        <div className="font-mono tabular-nums" title="Spot cüzdan toplam">
          {fmtQty(r.walletTotal)} top.
        </div>
        <div className="font-mono tabular-nums">
          {fmtQty(r.walletFree)} serbest · {fmtQty(r.walletLocked)} kilit
        </div>
        {r.excessFree > 0.0001 && (
          <div className="text-amber-300/90" title="Grid kayıtları dışında kalan serbest">
            +{fmtQty(r.excessFree)} fazla
          </div>
        )}
      </td>
      <td className="px-2 py-2">
        <div className="font-mono tabular-nums text-slate-200" title="Miktar × ort. maliyet">
          {r.costUsdt != null ? `${r.costUsdt.toFixed(2)}` : '—'}
        </div>
        {r.valueUsdt != null && (
          <div
            className={`text-[10px] tabular-nums ${
              r.costUsdt != null && r.valueUsdt < r.costUsdt ? 'text-red-400/90' : 'text-slate-500'
            }`}
            title="Miktar × güncel fiyat"
          >
            ≈ {r.valueUsdt.toFixed(2)} güncel
          </div>
        )}
      </td>
      <td className="px-2 py-2 font-mono tabular-nums">{fmtPrice(Number(r.avgCost), dec)}</td>
      <td className="px-2 py-2 font-mono tabular-nums text-emerald-300">
        {fmtPrice(Number(r.targetPrice), dec)}
      </td>
      <td className="px-2 py-2 font-mono tabular-nums">{fmtPrice(r.lastPrice, dec)}</td>
      <td className="px-2 py-2">
        <RecoveryProgress distancePct={r.distancePct} />
      </td>
      <td className="px-2 py-2 text-slate-400" title={formatDateTimeIstanbul(r.waitingSince)}>
        {formatWait(waitMs)}
      </td>
      <td className="px-2 py-2">
        <button
          type="button"
          onClick={() => onConvert(r)}
          disabled={busy}
          title={loss ? 'Zararına market satış yapılır' : 'Market satışla kapatılır'}
          className="rounded-md border border-red-700/70 bg-red-900/30 px-2 py-1 text-[11px] text-red-200 hover:bg-red-900/60 disabled:opacity-50"
        >
          {busy ? '…' : 'USDT’ye çevir'}
        </button>
      </td>
    </tr>
  );
}

function flashBadge(level: GridCandidateRow['flashLevel']): { label: string; className: string } {
  if (level == null) return { label: '—', className: 'text-slate-500' };
  switch (level) {
    case 'none':
      return { label: 'OK', className: 'text-emerald-400' };
    case 'warn':
      return { label: 'UYARI', className: 'text-amber-400' };
    case 'pause':
      return { label: 'DURAKLAT', className: 'text-red-400' };
    case 'recovery':
      return { label: 'KURTARMA', className: 'text-orange-400' };
    default:
      return { label: level, className: 'text-slate-400' };
  }
}

function CandidateRow({
  c,
  marketGate,
}: {
  c: GridCandidateRow;
  marketGate: GridMarketGate | null;
}) {
  const flash = flashBadge(c.flashLevel);
  const marketBlocked = Boolean(marketGate?.active);
  const rowSetup = c.setupEligible && !marketBlocked;
  const recoveringBlocks =
    c.isRecovering && c.ready && !c.isActive && !c.setupEligible;
  const rowClass = c.flashCooldown
    ? 'bg-slate-900/80 opacity-70'
    : c.isActive
      ? 'bg-indigo-950/40'
      : rowSetup
        ? 'bg-emerald-950/30'
        : '';
  return (
    <tr className={`border-t border-slate-800 ${rowClass}`}>
      <td className="px-2 py-2 font-mono">
        {c.symbol.replace('USDT', '')}
        {c.postExitRelax && (
          <span
            className="ml-1 rounded bg-amber-900/50 px-1 py-0.5 text-[10px] text-amber-200"
            title={
              c.recentStopReason
                ? `Son grid çıkışı: ${c.recentStopReason} — gevşetilmiş readiness`
                : 'Yakın grid çıkışı — gevşetilmiş readiness'
            }
          >
            Çıkış↓
          </span>
        )}
        {c.isActive && (
          <span className="ml-1 rounded bg-indigo-800/60 px-1 py-0.5 text-[10px] text-indigo-200">
            Aktif
          </span>
        )}
        {c.isRecovering && c.recoveringGridId != null && (
          <span
            className="ml-1 rounded bg-amber-900/50 px-1 py-0.5 text-[10px] text-amber-200"
            title="Aynı sembolde kurtarma grid'i açık; yeni grid ayrı grid_id ile kurulabilir"
          >
            Kurtarmada #{c.recoveringGridId}
          </span>
        )}
        {c.flashCooldown && (
          <span className="ml-1 rounded bg-slate-700/80 px-1 py-0.5 text-[10px] text-slate-300">
            Cooldown
          </span>
        )}
      </td>
      <td className="px-2 py-2 min-w-[8rem]">
        <ReadinessBar passed={c.gatesPassed} total={c.gatesTotal} ready={c.ready && !marketBlocked} />
      </td>
      <td className={`px-2 py-2 text-[10px] font-medium ${flash.className}`}>{flash.label}</td>
      <td
        className={`px-2 py-2 font-mono tabular-nums ${
          c.pathRangeRatio != null && c.pathRangeRatio > 8 ? 'text-red-400' : 'text-slate-400'
        }`}
        title="Testere göstergesi: yüksek = çok zigzag"
      >
        {num(c.pathRangeRatio, 1)}
      </td>
      <td className="px-2 py-2 font-mono tabular-nums text-slate-400">{num(c.windowDropPct, 2)}</td>
      <td className="px-2 py-2 font-mono tabular-nums text-slate-300">{num(c.score, 1)}</td>
      <td
        className={`px-2 py-2 font-mono tabular-nums ${
          c.efficiencyRatio != null && c.efficiencyRatio <= 0.35 ? 'text-emerald-400' : 'text-amber-400'
        }`}
      >
        {num(c.efficiencyRatio, 3)}
      </td>
      <td className="px-2 py-2 font-mono tabular-nums text-slate-300">{num(c.rangeWidthPct, 2)}</td>
      <td className="px-2 py-2 font-mono tabular-nums text-slate-300">{num(c.atrPct, 2)}</td>
      <td className="px-2 py-2 font-mono tabular-nums text-slate-400">{num(c.spreadPct, 3)}</td>
      <td className="px-2 py-2 font-mono tabular-nums text-slate-400">
        {c.gatesPassed}/{c.gatesTotal}
      </td>
      <td
        className="max-w-[11rem] px-2 py-2 text-[10px] leading-snug text-amber-300/95"
        title={
          rowSetup
            ? ''
            : marketBlocked && c.primaryBlocker
              ? blockerHint(c.primaryBlocker)
              : recoveringBlocks
                ? blockerHint('recovering_blocks_setup')
                : blockerHint(c.primaryBlocker)
        }
      >
        {rowSetup
          ? '—'
          : marketBlocked && c.primaryBlocker
            ? blockerLabel(c.primaryBlocker)
            : recoveringBlocks
              ? blockerLabel('recovering_blocks_setup')
              : blockerLabel(c.primaryBlocker)}
      </td>
    </tr>
  );
}

function GridStat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md bg-slate-800/60 px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="font-mono text-xs text-slate-200">{children}</div>
    </div>
  );
}

function RangePositionBar({
  lower,
  upper,
  price,
  dec,
}: {
  lower: number | null;
  upper: number | null;
  price: number | null;
  dec: number;
}) {
  const pct =
    lower != null && upper != null && price != null && upper > lower
      ? Math.min(100, Math.max(0, ((price - lower) / (upper - lower)) * 100))
      : null;
  return (
    <div className="mb-3">
      <div className="relative h-2 w-full rounded-full bg-gradient-to-r from-emerald-900/50 via-slate-700 to-red-900/50">
        {pct != null && (
          <div
            className="absolute top-1/2 h-3.5 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-slate-100 shadow"
            style={{ left: `${pct}%` }}
            title={`Aralıkta %${pct.toFixed(0)}`}
          />
        )}
      </div>
      <div className="mt-1 flex justify-between font-mono text-[10px] text-slate-500">
        <span>{fmtPrice(lower, dec)}</span>
        <span className="text-slate-300">{fmtPrice(price, dec)}</span>
        <span>{fmtPrice(upper, dec)}</span>
      </div>
    </div>
  );
}

function GridCard({
  g,
  cancelBusy,
  onCancel,
}: {
  g: GridStatusReport;
  cancelBusy: boolean;
  onCancel: (g: GridStatusReport) => void;
}) {
  const dec = priceDecimals(g.upper ?? g.lastPrice);
  const base = (g.symbol ?? '').replace(/USDT$/, '');
  const inRange = g.rangeStatus === 'in';
  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-lg font-semibold">{g.symbol}</span>
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
              inRange
                ? 'bg-emerald-900/50 text-emerald-300'
                : 'bg-amber-900/50 text-amber-300'
            }`}
          >
            {inRange ? 'Aralıkta' : 'Aralık dışı'}
          </span>
          {g.flashDrop && (
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                g.flashDrop.level === 'recovery'
                  ? 'bg-red-900/50 text-red-300'
                  : g.flashDrop.level === 'pause'
                    ? 'bg-orange-900/50 text-orange-300'
                    : 'bg-amber-900/50 text-amber-200'
              }`}
            >
              Flash:{' '}
              {g.flashDrop.level === 'recovery'
                ? 'KURTARMA'
                : g.flashDrop.level === 'pause'
                  ? 'DURAKLAT'
                  : 'UYARI'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {g.gridId != null && (
            <button
              type="button"
              disabled={cancelBusy}
              onClick={() => onCancel(g)}
              className="rounded border border-red-800/80 bg-red-950/50 px-2 py-1 text-[10px] font-medium text-red-200 hover:bg-red-900/60 disabled:opacity-50"
              title="Açık emirleri iptal et ve gridi durdur (coin satılmaz)"
            >
              {cancelBusy ? '…' : 'İptal'}
            </button>
          )}
          <span className="font-mono text-lg">{fmtPrice(g.lastPrice, dec)}</span>
        </div>
      </div>

      <RangePositionBar lower={g.lower} upper={g.upper} price={g.lastPrice} dec={dec} />

      {g.flashDrop && (
        <p className="mb-2 text-[10px] text-slate-400">
          Flash guard · anchor {fmtPrice(g.flashDrop.anchorPrice, dec)} · drawdown{' '}
          {signed(-g.flashDrop.dropPct, 2)}% · pencere {signed(-g.flashDrop.windowDropPct, 2)}%
          {g.flashDrop.recentFillCount > 0 && ` · ${g.flashDrop.recentFillCount} dolu alış (pencere)`}
        </p>
      )}

      <div className="mb-3 grid grid-cols-3 gap-1.5">
        <GridStat label="Açık emir">
          <span className="text-emerald-300">{g.openBuys} alış</span>
          <span className="text-slate-600"> / </span>
          <span className="text-red-300">{g.openSells} satış</span>
        </GridStat>
        <GridStat label="Grid / Adım">
          {g.gridCount} · %{num(g.spacingPct, 2)}
        </GridStat>
        <GridStat label="Envanter">
          {g.inventoryQty > 0 ? (
            <span className="block leading-snug">
              <span className="font-mono">
                {fmtQty(g.inventoryQty)} {base}
              </span>
              <span className="mt-0.5 block text-[10px] font-normal text-slate-500">
                ${num(g.inventoryCostUsdt)} maliyet
                {g.inventoryAvgCost != null && (
                  <>
                    {' '}
                    · ort. {fmtPrice(g.inventoryAvgCost, dec)}
                  </>
                )}
                {g.inventoryUnrealizedPct != null && (
                  <span className={pnlTone(g.inventoryUnrealizedPct)}>
                    {' '}
                    · {signed(g.inventoryUnrealizedPct, 2)}%
                  </span>
                )}
              </span>
            </span>
          ) : (
            <span className="text-slate-500">—</span>
          )}
        </GridStat>
        <GridStat label="Realize">
          <span className={pnlTone(g.realizedPnl ?? '0')}>
            {signed(g.realizedPnl ?? '0', 4)}
          </span>
        </GridStat>
        <GridStat label="Cycle">{g.cycles ?? 0}</GridStat>
        <GridStat label="Aralık">
          {fmtPrice(g.lower, dec)}–{fmtPrice(g.upper, dec)}
        </GridStat>
      </div>

      <p className="mb-2 text-[10px] text-slate-500">
        {g.ladderMode === 'breakeven_dip'
          ? `Tek alış hedefi (flat: yakın, bag: dip); fiyat ${g.dipBuyDeferSteps ?? 1} basamak üste inince limit · çıkış ort+%${g.floorExitMarginPct ?? 0.5}.`
          : 'Kesik çizgili etiketler planlanan seviyeler; satış emirleri alış dolduktan sonra üst seviyede açılır.'}
      </p>
      <Ladder
        ladder={g.ladder}
        lastPrice={g.lastPrice}
        dec={dec}
        floorMarginPct={g.floorExitMarginPct ?? 0.5}
        floorTargetPrice={g.floorExitTargetPrice ?? null}
      />
    </section>
  );
}

function ReadinessBar({ passed, total, ready }: { passed: number; total: number; ready: boolean }) {
  const pct = total > 0 ? Math.round((passed / total) * 100) : 0;
  const bar = ready
    ? 'bg-emerald-500'
    : pct >= 70
      ? 'bg-amber-400'
      : pct >= 40
        ? 'bg-sky-500'
        : 'bg-slate-600';
  return (
    <div title={`${passed}/${total} kapı`}>
      <div className="mb-0.5 flex justify-between text-[10px] tabular-nums text-slate-500">
        <span>{ready ? 'Hazır' : `%${pct}`}</span>
        <span>
          {passed}/{total}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded bg-slate-800">
        <div className={`h-full rounded ${bar}`} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
    </div>
  );
}

function PriceMarker({ price, dec }: { price: number; dec: number }) {
  return (
    <div className="relative my-0.5 flex items-center gap-2">
      <span className="absolute -left-[3px] h-2 w-2 rounded-full bg-sky-400 ring-2 ring-sky-400/30" />
      <div className="ml-4 flex flex-1 items-center gap-2">
        <div className="h-px flex-1 bg-sky-500/50" />
        <span className="rounded bg-sky-500/20 px-1.5 py-0.5 font-mono text-[10px] text-sky-300">
          fiyat {fmtPrice(price, dec)}
        </span>
        <div className="h-px flex-1 bg-sky-500/50" />
      </div>
    </div>
  );
}

function Ladder({
  ladder,
  lastPrice,
  dec,
  floorMarginPct,
  floorTargetPrice,
}: {
  ladder: GridLadderLevel[];
  lastPrice: number | null;
  dec: number;
  floorMarginPct: number;
  floorTargetPrice: number | null;
}) {
  const sorted = [...ladder].sort((a, b) => b.price - a.price);
  const rows: React.ReactNode[] = [];
  let markerPlaced = false;

  sorted.forEach((lvl) => {
    if (!markerPlaced && lastPrice != null && lastPrice >= lvl.price) {
      rows.push(<PriceMarker key="price-marker" price={lastPrice} dec={dec} />);
      markerPlaced = true;
    }
    const dotClass = lvl.open
      ? lvl.side === 'BUY'
        ? 'bg-emerald-400'
        : 'bg-red-400'
      : lvl.planned
        ? lvl.side === 'SELL'
          ? 'bg-red-400/40 ring-1 ring-red-500/50'
          : 'bg-emerald-400/40 ring-1 ring-emerald-500/50'
        : 'bg-slate-700';
    const rowKey = lvl.kind === 'floor' ? `floor-${lvl.orderPrice ?? lvl.price}` : String(lvl.levelIndex);
    rows.push(
      <div key={rowKey} className="relative flex items-center gap-2 py-0.5">
        <span className={`absolute -left-[2px] h-1.5 w-1.5 rounded-full ${dotClass}`} />
        <span
          className={`ml-4 w-24 font-mono text-xs ${
            lvl.open ? 'text-slate-200' : lvl.planned ? 'text-slate-400' : 'text-slate-600'
          }`}
        >
          {fmtPrice(lvl.kind === 'floor' ? (lvl.orderPrice ?? lvl.price) : lvl.price, dec)}
        </span>
        {lvl.open && lvl.side === 'BUY' && (
          <span className="rounded bg-emerald-900/50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300">
            ALIŞ
          </span>
        )}
        {lvl.open && lvl.side === 'SELL' && lvl.kind === 'floor' && (
          <span
            className="rounded bg-red-900/50 px-1.5 py-0.5 text-[10px] font-medium text-red-300"
            title={
              floorTargetPrice != null &&
              (lvl.orderPrice ?? lvl.price) + 1e-12 < floorTargetPrice
                ? `Hedef ort+%${floorMarginPct} ${fmtPrice(floorTargetPrice, dec)} — LIMIT piyasa üstü ${fmtPrice(lvl.orderPrice ?? lvl.price, dec)}`
                : `Ağırlıklı ortalama +%${floorMarginPct} çıkış`
            }
          >
            {floorTargetPrice != null &&
            (lvl.orderPrice ?? lvl.price) + 1e-12 < floorTargetPrice
              ? `SATIŞ (piyasa+ · hedef ${fmtPrice(floorTargetPrice, dec)})`
              : `SATIŞ (ort+%${floorMarginPct})`}
          </span>
        )}
        {lvl.open && lvl.side === 'SELL' && lvl.kind !== 'floor' && (
          <span className="rounded bg-red-900/50 px-1.5 py-0.5 text-[10px] font-medium text-red-300">
            SATIŞ
          </span>
        )}
        {!lvl.open && lvl.planned && lvl.side === 'SELL' && (
          <span
            className="rounded border border-dashed border-red-700/60 bg-red-950/30 px-1.5 py-0.5 text-[10px] font-medium text-red-300/80"
            title="Alış dolduktan sonra bu seviyede LIMIT satış açılır"
          >
            SATIŞ (dolumda)
          </span>
        )}
        {!lvl.open && lvl.planned && lvl.side === 'BUY' && lvl.kind === 'waiting' && (
          <span
            className="rounded border border-dashed border-amber-700/60 bg-amber-950/30 px-1.5 py-0.5 text-[10px] font-medium text-amber-200/90"
            title={
              lvl.deferTriggerPrice != null
                ? `Fiyat ≤ ${fmtPrice(lvl.deferTriggerPrice, dec)} olunca ~50 USDT limit alış konur`
                : 'Tetik fiyatına inince limit alış konur'
            }
          >
            ALIŞ (bekle)
          </span>
        )}
        {!lvl.open && lvl.planned && lvl.side === 'BUY' && lvl.kind !== 'waiting' && (
          <span
            className="rounded border border-dashed border-emerald-700/60 bg-emerald-950/30 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300/80"
            title="Fiyat bu seviyeye inince alış emri beklenir"
          >
            ALIŞ (plan)
          </span>
        )}
      </div>,
    );
  });

  if (!markerPlaced && lastPrice != null) {
    rows.push(<PriceMarker key="price-marker" price={lastPrice} dec={dec} />);
  }

  return (
    <div className="relative pl-2">
      <div className="absolute bottom-1 left-[1px] top-1 w-px bg-slate-800" />
      {rows}
    </div>
  );
}

const ORPHAN_BADGE: Record<OrphanBalanceRow['recommend'], { label: string; cls: string }> = {
  sell: { label: 'kârda → sat', cls: 'bg-emerald-900/50 text-emerald-300' },
  recovery: { label: 'zararda → recovery', cls: 'bg-amber-900/50 text-amber-300' },
  dust: { label: 'toz → BNB', cls: 'bg-slate-700/60 text-slate-300' },
  no_pair: { label: 'USDT paritesi yok', cls: 'bg-slate-700/60 text-slate-400' },
};

const ORPHAN_EXCESS_BADGE = {
  label: 'grid dışı fazla',
  cls: 'bg-violet-900/50 text-violet-300',
};

function OrphanRow({ r }: { r: OrphanBalanceRow }) {
  const dec = priceDecimals(r.price);
  const badge = ORPHAN_BADGE[r.recommend];
  return (
    <tr
      className={`border-t border-slate-800 ${r.excessUnderGrid ? 'bg-violet-950/20' : ''}`}
    >
      <td className="px-2 py-2 font-mono">
        {r.asset}
        {r.excessUnderGrid && (
          <span
            className="ml-1 rounded px-1 py-0.5 text-[9px] text-violet-300"
            title={
              r.walletTotal != null
                ? `Cüzdan toplam ${r.walletTotal}; listedeki miktar grid dışı serbest`
                : 'Aktif/kurtarma grid varken takipsiz kalan serbest'
            }
          >
            fazla
          </span>
        )}
      </td>
      <td
        className="px-2 py-2 font-mono tabular-nums text-slate-300"
        title={r.excessUnderGrid ? 'Grid dışı serbest (süpürülebilir)' : 'Serbest bakiye'}
      >
        {r.free}
      </td>
      <td className="px-2 py-2 font-mono tabular-nums">{fmtPrice(r.price, dec)}</td>
      <td className="px-2 py-2 font-mono tabular-nums">
        {r.valueUsdt == null ? '—' : `$${r.valueUsdt.toFixed(2)}`}
      </td>
      <td className="px-2 py-2 font-mono tabular-nums text-slate-400">
        {r.avgCost == null ? '—' : fmtPrice(r.avgCost, dec)}
      </td>
      <td
        className={`px-2 py-2 font-mono tabular-nums ${
          r.unrealizedPct == null ? 'text-slate-500' : pnlTone(r.unrealizedPct)
        }`}
      >
        {r.unrealizedPct == null ? '—' : `${signed(r.unrealizedPct, 2)}%`}
      </td>
      <td className="px-2 py-2">
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${badge.cls}`}>
          {badge.label}
        </span>
        {r.excessUnderGrid && (
          <span
            className={`ml-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${ORPHAN_EXCESS_BADGE.cls}`}
          >
            {ORPHAN_EXCESS_BADGE.label}
          </span>
        )}
      </td>
    </tr>
  );
}

function OrphanSection({
  report,
  actionBusy,
  actionMsg,
  onSweep,
  onDust,
}: {
  report: OrphanReport | null;
  actionBusy: string | null;
  actionMsg: string;
  onSweep: () => void;
  onDust: () => void;
}) {
  const rows = report?.rows ?? [];
  return (
    <section>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-medium">
          Öksüz Bakiyeler{report ? ` (${rows.length})` : ''}
        </h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onSweep}
            disabled={actionBusy != null}
            className="rounded-md border border-emerald-700 bg-emerald-900/40 px-3 py-1.5 text-xs text-emerald-200 hover:bg-emerald-900/70 disabled:opacity-50"
          >
            {actionBusy === 'grid-sweep' ? '…' : 'Süpür (sat / recovery)'}
          </button>
          <button
            type="button"
            onClick={onDust}
            disabled={actionBusy != null}
            className="rounded-md border border-amber-700 bg-amber-900/40 px-3 py-1.5 text-xs text-amber-200 hover:bg-amber-900/70 disabled:opacity-50"
          >
            {actionBusy === 'dust-convert' ? '…' : 'Dust → BNB'}
          </button>
        </div>
      </div>
      <p className="mb-2 text-xs text-slate-400">
        BNB/stable dışı takipsiz bakiyeler. Grid olmayan sembollerin tamamı + meşgul sembolde{' '}
        <strong className="text-violet-300">grid dışı fazla</strong> serbest miktar (recovery_qty /
        aktif envanter düşüldükten sonra). Eşik üstü (≥ ${report?.thresholdUsdt ?? 5}) → süpürmede
        kârda satılır, zararda recovery. Toz → BNB.
      </p>
      {actionMsg && <p className="mb-2 text-xs text-amber-300">{actionMsg}</p>}

      {report && (
        <div className="mb-2 flex flex-wrap gap-3 text-xs text-slate-400">
          <span>
            İşlem yapılabilir:{' '}
            <span className="font-mono text-slate-200">
              {report.actionableCount} (${report.actionableValueUsdt.toFixed(2)})
            </span>
          </span>
          <span>
            Toz:{' '}
            <span className="font-mono text-slate-200">
              {report.dustCount} (${report.dustValueUsdt.toFixed(2)})
            </span>
          </span>
          <span>
            Toplam:{' '}
            <span className="font-mono text-slate-200">${report.totalValueUsdt.toFixed(2)}</span>
          </span>
        </div>
      )}

      {report == null ? (
        <p className="text-sm text-slate-500">Öksüz bakiyeler yükleniyor…</p>
      ) : rows.length === 0 ? (
        <section className="rounded border border-emerald-800/40 bg-emerald-950/20 px-3 py-3 text-sm text-emerald-200">
          Takipsiz bakiye yok — cüzdan temiz.
        </section>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-800">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-900 text-slate-400">
              <tr>
                <th className="px-2 py-2">Varlık</th>
                <th className="px-2 py-2">Miktar</th>
                <th className="px-2 py-2">Fiyat</th>
                <th className="px-2 py-2">Değer</th>
                <th className="px-2 py-2">Ort. maliyet</th>
                <th className="px-2 py-2">PnL%</th>
                <th className="px-2 py-2">Öneri</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <OrphanRow key={r.asset} r={r} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
