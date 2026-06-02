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
  type GridRegimeSummary,
  type GridLadderLevel,
  type GridStatusReport,
  type GridStatusLivePatch,
  type GridRecoveryRow,
  type RecoveryLadderState,
  type RecoveryLadderStep,
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
  const [regimeSummary, setRegimeSummary] = useState<GridRegimeSummary | null>(null);
  const [orphans, setOrphans] = useState<OrphanReport | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState('');
  const [convertingId, setConvertingId] = useState<number | null>(null);
  const [ladderOpenId, setLadderOpenId] = useState<number | null>(null);
  const [ladderBusyId, setLadderBusyId] = useState<number | null>(null);
  const [ladderState, setLadderState] = useState<RecoveryLadderState | null>(null);
  const [ladderLoading, setLadderLoading] = useState(false);
  const [cancelingId, setCancelingId] = useState<number | null>(null);
  const [forceBusy, setForceBusy] = useState(false);

  const applyGridLive = useCallback((patches: GridStatusLivePatch[]) => {
    if (patches.length === 0) return;
    setData((prev) => {
      if (!prev) return prev;
      const byId = new Map(patches.map((p) => [p.gridId, p]));
      return {
        ...prev,
        grids: prev.grids.map((g) => {
          if (g.gridId == null) return g;
          const p = byId.get(g.gridId);
          if (!p || p.lastPrice == null) return g;
          const unrealized =
            g.inventoryAvgCost != null && g.inventoryAvgCost > 0
              ? Number(
                  (((p.lastPrice - g.inventoryAvgCost) / g.inventoryAvgCost) * 100).toFixed(2),
                )
              : g.inventoryUnrealizedPct;
          return {
            ...g,
            lastPrice: p.lastPrice,
            rangeStatus: p.rangeStatus ?? g.rangeStatus,
            inventoryUnrealizedPct: unrealized,
          };
        }),
      };
    });
  }, []);

  const loadCandidates = useCallback(
    async (opts?: { live?: boolean; updateMarketGate?: boolean }) => {
      const q = opts?.live ? '?live=1' : '';
      const c = await apiFetch<{
        candidates: GridCandidateRow[];
        marketGate: GridMarketGate;
        regimeSummary: GridRegimeSummary;
      }>(`/admin/api/grid-candidates${q}`);
      setCandidates(c.candidates);
      // Canlı poll da regime_cache kapısını döner; banner ile tablo senkron kalsın.
      setMarketGate(c.marketGate);
      setRegimeSummary(c.regimeSummary);
    },
    [],
  );

  const load = useCallback(async () => {
    // Çekirdek dashboard (hızlı) — adaylar + öksüzler ayrı/progressive.
    const d = await apiFetch<GridDashboard>('/admin/api/grid-dashboard');
    setData(d);
    setError('');
    void loadCandidates({ updateMarketGate: true }).catch(() => {});
    // Öksüz bakiyeler (myTrades çağrıları) ayrı yüklenir.
    apiFetch<OrphanReport>('/admin/api/grid-orphans')
      .then((o) => setOrphans(o))
      .catch(() => {});
  }, [loadCandidates]);

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

  const loadLadderState = useCallback(async (gridId: number) => {
    setLadderLoading(true);
    setError('');
    try {
      const state = await apiFetch<RecoveryLadderState>(
        `/admin/api/grid-recovery-ladder?gridId=${gridId}`,
      );
      setLadderState(state);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kademeli durum yüklenemedi');
      setLadderOpenId(null);
      setLadderState(null);
    } finally {
      setLadderLoading(false);
    }
  }, []);

  const toggleLadder = useCallback(
    async (row: GridRecoveryRow) => {
      if (ladderOpenId === row.gridId) {
        setLadderOpenId(null);
        setLadderState(null);
        return;
      }
      setLadderOpenId(row.gridId);
      setLadderState(null);
      await loadLadderState(row.gridId);
    },
    [ladderOpenId, loadLadderState],
  );

  const executeLadderStep = useCallback(
    async (step: RecoveryLadderStep) => {
      if (!ladderState) return;
      const sym = ladderState.symbol.replace('USDT', '');
      const warn = !step.suggested && ladderState.movePct != null;
      let msg = `${sym}: "${step.label}" uygulansın mı?`;
      if (warn) {
        msg += `\n\nŞu an anchor'a göre ${signed(ladderState.movePct ?? 0, 2)}% — eşik ${step.thresholdPct > 0 ? '+' : ''}${step.thresholdPct}% henüz geçilmemiş olabilir. Yine de devam?`;
      }
      if (!window.confirm(msg)) return;

      setLadderBusyId(ladderState.gridId);
      setError('');
      try {
        const res = await apiFetch<{
          ok: boolean;
          message: string;
          state?: RecoveryLadderState;
        }>('/admin/api/grid-recovery-ladder', {
          method: 'POST',
          body: JSON.stringify({ gridId: ladderState.gridId, stepId: step.id }),
        });
        if (!res.ok) {
          setError(res.message || 'Adım başarısız');
          return;
        }
        if (res.state) {
          setLadderState(res.state);
        } else {
          setLadderOpenId(null);
          setLadderState(null);
        }
        setActionMsg(`${sym}: kademeli adım "${step.label}" tamamlandı`);
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Kademeli adım hatası');
      } finally {
        setLadderBusyId(null);
      }
    },
    [ladderState, load],
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

  // Aktif pozisyonlar: DO bookTicker mid (~1 sn); emir/ladder/flash tam dashboard (15 sn).
  useEffect(() => {
    const GRID_LIVE_MS = 1_000;
    let cancelled = false;
    let inFlight = false;
    const tickGrids = () => {
      if (cancelled || document.visibilityState === 'hidden' || inFlight) return;
      inFlight = true;
      apiFetch<{ grids: GridStatusLivePatch[] }>('/admin/api/grid-live')
        .then((r) => applyGridLive(r.grids))
        .catch(() => {})
        .finally(() => {
          inFlight = false;
        });
    };
    tickGrids();
    const gridIv = setInterval(tickGrids, GRID_LIVE_MS);
    return () => {
      cancelled = true;
      clearInterval(gridIv);
    };
  }, [applyGridLive]);

  // Aday uygunluk: DO fiyat/spread ~1 sn; tam regime REST ~30 sn (canlıda regime_cache kapısı).
  useEffect(() => {
    const LIVE_MS = 1_000;
    const MARKET_MS = 30_000;
    let cancelled = false;
    const tickLive = () => {
      if (cancelled || document.visibilityState === 'hidden') return;
      loadCandidates({ live: true }).catch(() => {});
    };
    const tickMarket = () => {
      if (cancelled || document.visibilityState === 'hidden') return;
      loadCandidates({ live: false }).catch(() => {});
    };
    tickLive();
    const liveIv = setInterval(tickLive, LIVE_MS);
    const marketIv = setInterval(tickMarket, MARKET_MS);
    return () => {
      cancelled = true;
      clearInterval(liveIv);
      clearInterval(marketIv);
    };
  }, [loadCandidates]);

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
      <main className="mx-auto max-w-6xl px-3 py-4 sm:px-4 sm:py-6">
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
              <div>
                <h2 className="text-lg font-medium">Aktif Pozisyonlar ({grids.length})</h2>
                <p className="mt-0.5 text-[11px] text-slate-500">
                  Fiyat / aralık / unrealized ~1 sn (bookTicker); emirler, ladder, flash ~15 sn
                </p>
              </div>
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
                          busy={
                            convertingId === r.gridId ||
                            ladderBusyId === r.gridId ||
                            (ladderOpenId === r.gridId && ladderLoading)
                          }
                          onConvert={convertRecovery}
                          ladderOpen={ladderOpenId === r.gridId}
                          ladderState={ladderOpenId === r.gridId ? ladderState : null}
                          ladderLoading={ladderOpenId === r.gridId && ladderLoading}
                          onToggleLadder={() => toggleLadder(r)}
                          onExecuteStep={executeLadderStep}
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

            <section className="rounded-lg border border-slate-800 bg-slate-900/50 px-3 py-3 sm:px-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex w-full items-center justify-between gap-3 sm:hidden">
                  <h2 className="text-sm font-medium text-slate-200">Piyasa kilidi</h2>
                  <div className="flex shrink-0 items-center gap-2">
                    <span
                      className={`text-xs font-medium ${forceActive ? 'text-red-300' : 'text-slate-400'}`}
                    >
                      {forceBusy ? '…' : forceActive ? 'Kilitli' : 'Serbest'}
                    </span>
                    <ToggleForceDownturn
                      forceActive={forceActive}
                      forceBusy={forceBusy}
                      onToggle={() => void toggleForceDownturn()}
                    />
                  </div>
                </div>
                <div className="min-w-0 flex-1">
                  <h2 className="hidden text-sm font-medium text-slate-200 sm:block">
                    Piyasa düşüş kilidi (manuel)
                  </h2>
                  <p className="mt-0 text-xs leading-relaxed text-slate-500 sm:mt-1">
                    Açıkken bot yeni grid kurmaz. Kapalıyken chop / otomatik düşüş eşikleri geçerli
                    olabilir.
                  </p>
                  <ul className="mt-2 space-y-1 text-xs text-slate-400">
                    <li className="flex flex-wrap gap-x-1">
                      <span className="text-slate-500">Manuel kilit:</span>
                      <span className={forceActive ? 'text-red-300' : 'text-slate-300'}>
                        {forceActive ? 'aktif' : 'kapalı'}
                      </span>
                    </li>
                    {marketGate && (
                      <li className="flex flex-wrap gap-x-1">
                        <span className="text-slate-500">Otomatik düşüş:</span>
                        <span className={autoDownturnActive ? 'text-red-300' : 'text-slate-300'}>
                          {autoDownturnActive ? 'aktif' : 'pasif'}
                        </span>
                      </li>
                    )}
                    {autoDownturnActive && marketGate && marketGate.reasons.length > 0 && (
                      <li className="text-[11px] leading-snug text-slate-500">
                        {marketGate.reasons.filter((r) => r !== 'force_active').join(', ') ||
                          'eşikler'}
                        {marketGate.breadthPct ? ` · breadth ${marketGate.breadthPct}%` : ''}
                        {marketGate.btc24hChangePct != null
                          ? ` · BTC 24s ${marketGate.btc24hChangePct.toFixed(2)}%`
                          : ''}
                      </li>
                    )}
                  </ul>
                </div>
                <div className="hidden shrink-0 items-center gap-3 sm:flex">
                  <span
                    className={`text-xs font-medium ${forceActive ? 'text-red-300' : 'text-slate-400'}`}
                  >
                    {forceBusy ? '…' : forceActive ? 'Kilitli' : 'Serbest'}
                  </span>
                  <ToggleForceDownturn
                    forceActive={forceActive}
                    forceBusy={forceBusy}
                    onToggle={() => void toggleForceDownturn()}
                  />
                </div>
              </div>
            </section>

            {regimeSummary && <RegimeSummaryBanner s={regimeSummary} />}

            {/* Aday readiness — "Giriş hazır" tablosu */}
            <section>
              <h2 className="mb-2 text-base font-medium sm:text-lg">Aday Uygunluk</h2>
              <p className="mb-2 text-xs leading-relaxed text-slate-400 sm:hidden">
                Scout listesi · <strong className="text-slate-300">Hazır</strong> = tüm kapılar yeşil.
                Canlı fiyat ve 3dk/10dk/30dk/1s getiri %.
              </p>
              <p className="mb-3 hidden text-xs text-slate-400 sm:block">
                Liste: 15 dk scout (hacim + risk filtresi). Son ~40 dk (8×5m) üst üste düşen coinler
                listeye alınmaz. Kısa düşüş eşiği 2% (3×5m). <strong className="text-slate-300">Hazır</strong> = tüm kontroller yeşil.{' '}
                <strong className="text-slate-300">Engel</strong> sütununda neden girilmediği Türkçe yazar.
                Fiyat canlı; 3dk/10dk/30dk/1s getiri % (DO kline). EffRatio/ATR vb. hazırlık skorunda
                arkada kalır. Piyasa kapısı regime_cache;
                tam BTC/breadth ~30 sn.
              </p>
              {(marketGate?.active || regimeSummary?.defensiveActive) && (
                <div className="mb-3 space-y-1.5 rounded-lg border border-red-800/60 bg-red-950/40 px-3 py-2.5 text-xs leading-relaxed text-red-200">
                  {marketGate?.reasons.includes('force_active') ? (
                    <p>
                      <span className="font-medium text-red-100">Manuel kilit açık</span> — yeni grid
                      kurulmaz.
                    </p>
                  ) : (
                    <p>
                      <span className="font-medium text-red-100">Piyasa düşüş / savunma aktif</span> —
                      yeni grid kurulmaz.
                    </p>
                  )}
                  {regimeSummary?.defensiveActive && (
                    <p className="text-red-300/90">
                      Muaf olmayan aktif gridler recovery&apos;ye alınır; hedefin %1 altında MARKET
                      çıkış.
                    </p>
                  )}
                  {marketGate && marketGate.reasons.length > 0 && (
                    <p className="text-[11px] text-red-300/80">
                      {marketGate.reasons.join(', ')} · breadth {marketGate.breadthPct}%
                      {marketGate.btc24hChangePct != null
                        ? ` · BTC 24s ${marketGate.btc24hChangePct.toFixed(2)}%`
                        : ''}
                    </p>
                  )}
                </div>
              )}
              <div className="-mx-0.5 overflow-x-auto rounded-lg border border-slate-800 sm:mx-0">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-900 text-slate-400">
                    <tr>
                      <th className="px-2 py-2">Sembol</th>
                      <th className="px-2 py-2">Fiyat</th>
                      <th className="px-2 py-2 min-w-[8rem]">Hazırlık</th>
                      <th className="px-2 py-2">Flash</th>
                      <th className="px-2 py-2">Path×</th>
                      <th className="px-2 py-2">Düşüş%</th>
                      <th className="px-2 py-2">Skor</th>
                      <th className="px-2 py-2" title="Güncel fiyata göre ~3 dk önceki 1m kapanış">
                        3dk
                      </th>
                      <th className="px-2 py-2" title="~10 dk önceki 1m kapanış">
                        10dk
                      </th>
                      <th className="px-2 py-2" title="~30 dk önceki 1m kapanış">
                        30dk
                      </th>
                      <th className="px-2 py-2" title="~1 saat önceki 5m kapanış (12 bar)">
                        1s
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
  ladderOpen,
  ladderState,
  ladderLoading,
  onToggleLadder,
  onExecuteStep,
}: {
  r: GridRecoveryRow;
  onConvert: (r: GridRecoveryRow) => void;
  busy: boolean;
  ladderOpen: boolean;
  ladderState: RecoveryLadderState | null;
  ladderLoading: boolean;
  onToggleLadder: () => void;
  onExecuteStep: (step: RecoveryLadderStep) => void;
}) {
  const dec = priceDecimals(Number(r.targetPrice) || r.lastPrice);
  const waitMs = Date.now() - parseDbTimestamp(r.waitingSince).getTime();
  const loss = r.unrealizedPct != null && r.unrealizedPct < 0;
  return (
    <>
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
        <div className="flex flex-col gap-1 sm:flex-row sm:flex-wrap">
          <button
            type="button"
            onClick={onToggleLadder}
            disabled={busy && !ladderOpen}
            title="Manuel kademeli al/sat (anchor = ort. maliyet)"
            className={`rounded-md border px-2 py-1 text-[11px] disabled:opacity-50 ${
              ladderOpen
                ? 'border-amber-500/80 bg-amber-900/50 text-amber-100'
                : 'border-amber-700/60 bg-amber-950/40 text-amber-200 hover:bg-amber-900/40'
            }`}
          >
            {ladderOpen ? 'Kapat' : 'Kademeli'}
            {!ladderOpen && r.ladderDoneCount > 0 && (
              <span className="ml-1 text-[10px] text-amber-400/80">
                ({r.ladderDoneCount}/10)
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={() => onConvert(r)}
            disabled={busy}
            title={loss ? 'Zararına market satış yapılır' : 'Market satışla kapatılır'}
            className="rounded-md border border-red-700/70 bg-red-900/30 px-2 py-1 text-[11px] text-red-200 hover:bg-red-900/60 disabled:opacity-50"
          >
            {busy && !ladderOpen ? '…' : 'USDT’ye çevir'}
          </button>
        </div>
        {r.ladderMovePct != null && !ladderOpen && (
          <div className="mt-0.5 text-[10px] tabular-nums text-slate-500" title="Anchor’a göre hareket">
            Δ {signed(r.ladderMovePct, 2)}%
          </div>
        )}
      </td>
    </tr>
    {ladderOpen && (
      <tr className="border-t border-amber-900/30 bg-amber-950/30">
        <td colSpan={10} className="px-2 py-3">
          {ladderLoading && !ladderState ? (
            <p className="text-xs text-slate-400">Kademeli panel yükleniyor…</p>
          ) : ladderState ? (
            <RecoveryLadderPanel
              state={ladderState}
              busy={busy}
              onExecuteStep={onExecuteStep}
            />
          ) : (
            <p className="text-xs text-red-300/90">Panel yüklenemedi.</p>
          )}
        </td>
      </tr>
    )}
    </>
  );
}

function RecoveryLadderPanel({
  state,
  busy,
  onExecuteStep,
}: {
  state: RecoveryLadderState;
  busy: boolean;
  onExecuteStep: (step: RecoveryLadderStep) => void;
}) {
  const dec = priceDecimals(state.anchor || state.lastPrice);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-300">
        <span>
          Anchor: <span className="font-mono tabular-nums">{fmtPrice(state.anchor, dec)}</span>
        </span>
        <span>
          Şu an:{' '}
          <span className="font-mono tabular-nums">
            {state.movePct != null ? `${signed(state.movePct, 2)}%` : '—'}
          </span>
          {state.lastPrice != null && (
            <span className="ml-1 text-slate-500">({fmtPrice(state.lastPrice, dec)})</span>
          )}
        </span>
        {state.positionValueUsdt != null && (
          <span>Pozisyon: ≈ {state.positionValueUsdt.toFixed(2)} USDT</span>
        )}
        <span className="text-slate-500">
          Tamamlanan: {state.doneCount}/10
        </span>
      </div>
      <p className="text-[10px] text-slate-500">
        Eşik geçilince cron otomatik uygular (config açıksa). Buradan erken adım veya eşik öncesi işlem yapabilirsin. Savunma modu ayrı çalışır.
      </p>
      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        {state.steps.map((step) => {
          const done = step.done;
          const suggested = step.suggested && !done;
          return (
            <button
              key={step.id}
              type="button"
              disabled={busy || done}
              onClick={() => onExecuteStep(step)}
              title={
                done
                  ? 'Tamamlandı'
                  : suggested
                    ? 'Eşik geçildi — önerilen adım'
                    : 'Manuel uygula'
              }
              className={`rounded-md border px-2 py-2 text-left text-[11px] disabled:opacity-50 ${
                done
                  ? 'border-slate-700 bg-slate-900/60 text-slate-500 line-through'
                  : suggested
                    ? 'border-emerald-600/60 bg-emerald-950/30 text-emerald-100 hover:bg-emerald-900/40'
                    : 'border-slate-700 bg-slate-900/40 text-slate-200 hover:bg-slate-800/60'
              }`}
            >
              <span className="font-medium">{step.label}</span>
              <span className="ml-2 text-[10px] text-slate-500">
                {done ? 'yapıldı' : suggested ? 'hazır' : 'bekliyor'}
              </span>
            </button>
          );
        })}
      </div>
    </div>
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

const GRID_WAIT_REASON_TR: Record<string, string> = {
  no_ready_candidate: 'Hazır aday yok',
  market_downturn: 'Piyasa düşüş kapısı',
  market_panic: 'Panik rejimi',
  force_active: 'Manuel kilit',
  defensive_mode: 'Savunma modu',
};

function ToggleForceDownturn({
  forceActive,
  forceBusy,
  onToggle,
}: {
  forceActive: boolean;
  forceBusy: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={forceActive}
      aria-label="Manuel piyasa düşüş kilidi"
      disabled={forceBusy}
      onClick={onToggle}
      className={`relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
        forceActive ? 'bg-red-600' : 'bg-slate-600'
      }`}
    >
      <span
        className={`absolute top-0.5 block h-6 w-6 rounded-full bg-white shadow transition-transform ${
          forceActive ? 'translate-x-5' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}

function RegimeSummaryBanner({ s }: { s: GridRegimeSummary }) {
  const tone =
    s.setupEligibleCount >= 1
      ? 'border-emerald-800/50 bg-emerald-950/30'
      : s.isChop
        ? 'border-amber-800/50 bg-amber-950/25'
        : 'border-slate-700 bg-slate-900/60';
  const headlineTone =
    s.setupEligibleCount >= 1
      ? 'text-emerald-200'
      : s.isChop
        ? 'text-amber-100'
        : 'text-slate-200';
  const cacheAge =
    s.regimeCacheUpdatedAt != null ? formatDateTimeIstanbul(s.regimeCacheUpdatedAt) : null;
  const waitAt = s.lastGridWaitAt != null ? formatDateTimeIstanbul(s.lastGridWaitAt) : null;
  const waitReason =
    s.lastGridWaitReason != null
      ? (GRID_WAIT_REASON_TR[s.lastGridWaitReason] ?? s.lastGridWaitReason)
      : null;

  const defensiveShort =
    s.defensiveReasons.length > 0 ? s.defensiveReasons.join(', ') : '—';

  return (
    <section className={`mb-4 rounded-lg border px-3 py-3 sm:px-4 sm:py-3 ${tone}`}>
      <h2 className="text-sm font-medium text-slate-200">Rejim özeti</h2>
      <p className={`mt-2 text-xs leading-relaxed sm:text-sm ${headlineTone}`}>{s.headline}</p>

      {waitAt && (
        <p className="mt-2 text-[11px] leading-snug text-slate-500">
          Son bekleme: <span className="text-slate-400">{waitAt}</span>
          {waitReason && <span> · {waitReason}</span>}
        </p>
      )}
      {cacheAge && (
        <p className="mt-1 text-[11px] text-slate-500">Cache: {cacheAge}</p>
      )}

      <div className="mt-3 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:gap-2">
        <SummaryChip
          label={`Rejim ${s.regime}`}
          ok={!s.isChop && s.regime !== 'panic'}
          hint="chop/panic = zayıf evren"
        />
        <SummaryChip
          label={`Breadth ${s.breadthPct != null ? `${s.breadthPct.toFixed(0)}%` : '—'}`}
          ok={s.breadthAboveChop}
          hint=">%45 chop biter"
        />
        <SummaryChip
          label={`BTC ${s.btc24hChangePct != null ? `${s.btc24hChangePct >= 0 ? '+' : ''}${s.btc24hChangePct.toFixed(1)}%` : '—'}`}
          ok={s.btc24hAboveRecovery}
          hint="24s · >−2,5% toparlanma"
        />
        <SummaryChip
          label={`Hazır ${s.readyCount}/${s.candidateCount}`}
          ok={s.readyCount >= 1}
          hint="Tüm kapılar yeşil"
        />
        <SummaryChip
          label={`Kurulum ${s.setupEligibleCount}/${s.candidateCount}`}
          ok={s.setupEligibleCount >= 1}
          hint="Slot + kapılar uygun"
        />
        <SummaryChip
          label={`3dk +${s.green3mCount}`}
          ok={s.green3mCount >= 3}
          hint={`3dk yeşil ${s.green3mCount}/${s.candidateCount}`}
        />
        <SummaryChip
          label={`10dk +${s.green10mCount}`}
          ok={s.green10mCount >= 3}
          hint={`10dk yeşil ${s.green10mCount}/${s.candidateCount}`}
        />
        <SummaryChip
          label={`Düşüş ${s.fallingNowCount}`}
          ok={s.fallingNowCount <= 2}
          hint="Şimdi düşüyor sayısı"
        />
        {(s.marketGateActive || s.defensiveActive) && (
          <SummaryChip
            label="Grid kapalı"
            ok={false}
            hint="Yeni kurulum engelli"
            className="col-span-2 sm:col-span-1"
          />
        )}
        {s.defensiveActive && (
          <SummaryChip
            label={`Savunma ${defensiveShort}`}
            ok={false}
            hint={`Muaf: ${s.defensiveExemptCount} grid · ${defensiveShort}`}
            className="col-span-2 sm:col-span-1"
          />
        )}
      </div>
    </section>
  );
}

function SummaryChip({
  label,
  ok,
  hint,
  className = '',
}: {
  label: string;
  ok: boolean;
  hint?: string;
  className?: string;
}) {
  return (
    <span
      title={hint}
      className={`block truncate rounded-md border px-2 py-1.5 text-center text-[11px] font-medium sm:inline-block sm:w-auto sm:py-1 ${
        ok
          ? 'border-emerald-800/60 bg-emerald-950/40 text-emerald-300'
          : 'border-slate-700 bg-slate-950/50 text-slate-400'
      } ${className}`}
    >
      {label}
    </span>
  );
}

function marketGateBlockerId(gate: GridMarketGate): string {
  if (gate.reasons.includes('panic')) return 'market_panic';
  if (gate.reasons.includes('force_active')) return 'force_active';
  return 'market_downturn';
}

function PctChangeCell({ pct, title }: { pct: number | null; title?: string }) {
  if (pct == null) {
    return <span className="text-slate-500">—</span>;
  }
  const tone =
    pct > 0 ? 'text-emerald-400' : pct < 0 ? 'text-red-400' : 'text-slate-400';
  const label = `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`;
  return (
    <span className={`font-mono tabular-nums ${tone}`} title={title}>
      {label}
    </span>
  );
}

function CandidatePriceCell({
  price,
  changePct3m,
}: {
  price: number | null;
  changePct3m: number | null;
}) {
  if (price == null || !(price > 0)) {
    return <span className="text-slate-500">—</span>;
  }
  const dec = priceDecimals(price);
  const tone =
    changePct3m != null && changePct3m > 0
      ? 'text-emerald-400'
      : changePct3m != null && changePct3m < 0
        ? 'text-red-400'
        : 'text-slate-300';
  const arrow =
    changePct3m != null && changePct3m > 0
      ? '↑'
      : changePct3m != null && changePct3m < 0
        ? '↓'
        : null;
  return (
    <span
      className={`inline-flex items-center gap-0.5 font-mono tabular-nums ${tone}`}
      title={changePct3m != null ? `Son 3 dk: ${changePct3m > 0 ? '+' : ''}${changePct3m.toFixed(2)}%` : undefined}
    >
      {arrow != null && (
        <span className="text-[11px] font-semibold leading-none" aria-hidden>
          {arrow}
        </span>
      )}
      {fmtPrice(price, dec)}
    </span>
  );
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
  const marketBlockerId = marketGate ? marketGateBlockerId(marketGate) : 'market_downturn';
  const displayBlocker =
    c.primaryBlocker === 'market_panic' ||
    c.primaryBlocker === 'market_downturn' ||
    c.primaryBlocker === 'force_active'
      ? c.primaryBlocker
      : marketBlocked
        ? marketBlockerId
        : c.primaryBlocker;
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
      <td className="px-2 py-2 whitespace-nowrap">
        <CandidatePriceCell price={c.lastPrice} changePct3m={c.priceChangePct3m} />
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
      <td className="px-2 py-2">
        <PctChangeCell pct={c.priceChangePct3m} title="Son ~3 dk getiri" />
      </td>
      <td className="px-2 py-2">
        <PctChangeCell pct={c.priceChangePct10m} title="Son ~10 dk getiri" />
      </td>
      <td className="px-2 py-2">
        <PctChangeCell pct={c.priceChangePct30m} title="Son ~30 dk getiri" />
      </td>
      <td className="px-2 py-2">
        <PctChangeCell pct={c.priceChangePct1h} title="Son ~1 saat getiri (5m)" />
      </td>
      <td
        className="max-w-[11rem] px-2 py-2 text-[10px] leading-snug text-amber-300/95"
        title={
          rowSetup
            ? ''
            : recoveringBlocks
              ? blockerHint('recovering_blocks_setup')
              : blockerHint(displayBlocker)
        }
      >
        {rowSetup
          ? '—'
          : recoveringBlocks
            ? blockerLabel('recovering_blocks_setup')
            : blockerLabel(displayBlocker)}
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
