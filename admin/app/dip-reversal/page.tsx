'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AuthGuard } from '@/components/AuthGuard';
import { Nav } from '@/components/Nav';
import { apiFetch } from '@/lib/api';
import {
  clearDipPins,
  currentPctFromEntry,
  loadDipPinState,
  mergeDipLiveCandidates,
  saveDipPinState,
  sortDipCandidatesForDisplay,
  toggleDipPin,
  updateDipPinTracks,
  type DipPinTrack,
} from '@/lib/dip-candidate-pins';
import { formatDateTimeIstanbul } from '@/lib/datetime';
import { binanceSpotTradeUrl, formatPrice, formatUsdt, spotSymbolLabel } from '@/lib/format';

interface GateView {
  id: string;
  pass: boolean;
  actual: number | null;
  threshold: string;
}
interface CandidateView {
  symbol: string;
  mid: string | null;
  windowDropPct: number | null;
  change1mPct: number | null;
  change3mPct: number | null;
  change10mPct: number | null;
  change30mPct: number | null;
  flashDrop3mPct: number | null;
  wsDeclinePct: number | null;
  recoveryFromWsLowPct: number | null;
  reversalScore: number;
  secSinceTrough: number | null;
  midSlopeOk: boolean;
  gates: GateView[];
  gatesPassed: number;
  gatesTotal: number;
  excluded: string | null;
  ready: boolean;
  score: number | null;
  primaryBlocker: string | null;
  pinned?: boolean;
}
interface PositionView {
  id: number;
  symbol: string;
  avgCost: string;
  netBaseQty: string;
  spentUsdt: string;
  hardStopPct: string | null;
  trailingOrderId: string | null;
  openedAt: string;
  lastPrice: string | null;
  pnlPct: string | null;
  pnlUsdt: string | null;
  marketValueUsdt: string | null;
}
interface ActivityView {
  eventType: string;
  symbol: string | null;
  createdAt: string;
  detail: Record<string, unknown>;
}
interface ClosedTrade {
  symbol: string;
  pnlUsdt: number;
  pnlPct: number | null;
  proceeds: number | null;
  spent: number | null;
  source: string | null;
  closedAt: string;
}
interface PnlSummary {
  totalPnlUsdt: number;
  tradeCount: number;
  wins: number;
  losses: number;
}
interface AdaptView {
  enabled: boolean;
  mode: string | null;
  trend: string | null;
  emaSepPct: number | null;
  atrPct: number | null;
  breadthPct: number | null;
  riskOff: boolean | null;
  effectiveMinCapitulationDropPct: number | null;
  effectiveMinReversalScore: number | null;
  effectiveMinRecoveryFromLowPct: number | null;
  effectiveBuyQuoteUsdt: string | null;
  manualBuyQuoteUsdt: string;
  blocksEntry: boolean;
  blockReason: 'downtrend_grind' | 'volatile_riskoff_breadth' | null;
  volatileBlockEnabled: boolean;
  volatileBlockBreadthMax: number;
  dataWarning: string | null;
  adaptStale?: boolean;
}
interface DipLivePatch {
  candidates: CandidateView[];
  adapt: AdaptView;
  adaptStale: boolean;
  scannedAt: string;
}
interface DipPositionsPatch {
  capacity: { open: number; max: number };
  positions: PositionView[];
}
interface DipReport {
  enabled: boolean;
  tradingEnabled: boolean;
  capacity: { open: number; max: number };
  config: {
    buyQuoteUsdt: string;
    minCapitulationDropPct: number;
    flashWindowMin: number;
    minWsDeclinePct: number;
    minRecoveryFromLowPct: number;
    minReversalScore: number;
    maxSecSinceTrough: number;
    requireMidSlope: boolean;
    trailingActivationPct: string;
    trailingCallbackPct: string;
    hardStopPct: string;
    postExitCooldownMin: number;
    regimeFilter: string[];
  };
  candidates: CandidateView[];
  positions: PositionView[];
  closedTradesToday: ClosedTrade[];
  pnl: PnlSummary;
  totals: { realizedPnlToday: string; tradesToday: number };
  adapt: AdaptView;
  recent: ActivityView[];
  scannedAt: string;
}

const MODE_TR: Record<string, string> = {
  calm: 'Sakin (gevşet)',
  volatile: 'Volatil (baseline)',
  normal: 'Normal',
  downtrend_volatile: 'Düşüş-volatil (hafif sıkı)',
  downtrend_grind: 'Grind (sıkı)',
};

const BLOCKER_TR: Record<string, string> = {
  capitulation: 'Düşüş yetersiz',
  ws_decline: 'WS düşüş yok',
  recovery: 'Toparlanma yok',
  reversal_score: 'Reversal zayıf',
  trough_recency: 'Dip eski/yok',
  mid_slope: 'Mid düşüyor',
  system_blocked: 'Sistem bloğu',
  no_mid: 'Fiyat yok',
  grid: 'Grid sembolü',
  open_position: 'Açık pozisyon',
  cooldown: 'Cooldown',
};

const ACTIVITY_TR: Record<string, string> = {
  DIP_REVERSAL_ENTRY_BLOCKED: 'Giriş bloklu',
  DIP_REVERSAL_ADAPT_SKIP: 'Adapt grind blok',
  DIP_REVERSAL_REGIME_SKIP: 'Rejim filtresi',
  DIP_REVERSAL_ERROR: 'Hata',
};

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
function pct(s: string | null): string {
  if (s == null) return '—';
  const n = Number(s);
  return Number.isNaN(n) ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

/** Trailing TAKE_PROFIT: fiyat maliyet+aktivasyon% üstüne çıkınca takip satışı devreye girer. */
function trailingStatus(
  avgCost: string,
  lastPrice: string | null,
  activationPct: string,
  callbackPct: string,
  hasTrailingOrder: boolean,
): { label: string; title: string; active: boolean } {
  if (!hasTrailingOrder) {
    return { label: '—', title: 'Trailing emri yok', active: false };
  }
  const avg = Number(avgCost);
  const act = Number(activationPct);
  const cb = Number(callbackPct);
  if (!Number.isFinite(avg) || avg <= 0 || !Number.isFinite(act)) {
    return { label: '—', title: 'Maliyet veya aktivasyon eşiği okunamadı', active: false };
  }
  const activationPrice = avg * (1 + act / 100);
  const target = formatPrice(String(activationPrice));
  const last = lastPrice != null ? Number(lastPrice) : NaN;
  if (!Number.isFinite(last) || last <= 0) {
    return {
      label: `→ ${target}`,
      title: `Aktivasyon hedefi ${target} (maliyet +%${act}). Canlı fiyat bekleniyor.`,
      active: false,
    };
  }
  if (last >= activationPrice) {
    return {
      label: 'Aktif',
      title: `Trailing takipte (fiyat ≥ ${target}). Geri çekilmede ~%${Number.isFinite(cb) ? cb : '?'} callback ile satış.`,
      active: true,
    };
  }
  const remainingPct = ((activationPrice - last) / last) * 100;
  return {
    label: `+${remainingPct.toFixed(2)}%`,
    title: `Aktivasyon için +${remainingPct.toFixed(2)}% yükseliş gerek (hedef ${target}, maliyet +%${act}). Sonra %${cb} callback.`,
    active: false,
  };
}
function timeAgo(iso: string): string {
  const t = Date.parse(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  if (Number.isNaN(t)) return iso;
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}sn`;
  if (s < 3600) return `${Math.round(s / 60)}dk`;
  return `${Math.round(s / 3600)}sa`;
}
function exitLabel(source: string | null): string {
  if (source === 'dip_reversal_hard_stop') return 'hard-stop';
  if (source === 'dip_reversal_time_stop') return 'zaman-stop';
  if (source === 'dip_reversal_trailing_filled') return 'trailing';
  return source ?? '—';
}

export default function DipReversalPage() {
  const [data, setData] = useState<DipReport | null>(null);
  const [candidateScannedAt, setCandidateScannedAt] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [liveErr, setLiveErr] = useState<string | null>(null);
  const [buyingSymbol, setBuyingSymbol] = useState<string | null>(null);
  const [buyMsg, setBuyMsg] = useState<string | null>(null);
  const [pinState, setPinState] = useState(() => loadDipPinState());

  useEffect(() => {
    saveDipPinState(pinState);
  }, [pinState]);

  const manualPins = pinState.order;

  useEffect(() => {
    if (pinState.order.length === 0 || !data?.candidates.length) return;
    const mids = new Map(data.candidates.map((c) => [c.symbol, c.mid]));
    setPinState((prev) => updateDipPinTracks(prev, mids));
  }, [data?.candidates, pinState.order.length]);

  const manualPinSet = useMemo(() => new Set(manualPins), [manualPins]);

  const displayCandidates = useMemo(() => {
    if (!data?.candidates.length) return [];
    return sortDipCandidatesForDisplay(data.candidates, manualPins);
  }, [data?.candidates, manualPins]);

  const toggleManualPin = useCallback((symbol: string, mid: string | null) => {
    setPinState((prev) => toggleDipPin(prev, symbol, mid));
  }, []);

  const clearManualPins = useCallback(() => {
    setPinState(clearDipPins());
  }, []);

  const loadCore = useCallback(async () => {
    try {
      const res = await apiFetch<DipReport>('/admin/api/dip-reversal');
      setData(res);
      setCandidateScannedAt(res.scannedAt);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'hata');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCore().catch(() => {});
    const coreIv = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      loadCore().catch(() => {});
    }, 30_000);
    return () => clearInterval(coreIv);
  }, [loadCore]);

  const handleManualBuy = useCallback(
    async (c: CandidateView) => {
      if (!data?.tradingEnabled) {
        setBuyMsg('TRADING_ENABLED kapalı — gerçek alım yapılmaz.');
        return;
      }
      const label = spotSymbolLabel(c.symbol);
      const quote = data.adapt.manualBuyQuoteUsdt;
      if (
        !window.confirm(
          `${label} — manuel market alım (${quote} USDT) + trailing?\n\nSniper kapıları atlanır; min notional/lot kontrolü geçerli.`,
        )
      ) {
        return;
      }
      setBuyMsg(null);
      setBuyingSymbol(c.symbol);
      try {
        const res = await apiFetch<{ ok: boolean; error?: string; message?: string; symbol?: string }>(
          '/admin/api/dip-reversal/manual-buy',
          { method: 'POST', body: JSON.stringify({ symbol: c.symbol }) },
        );
        if (res.ok) {
          setBuyMsg(`${label} alım tamam — pozisyonlar yenileniyor.`);
          await loadCore();
        } else {
          const errTr: Record<string, string> = {
            trading_disabled: 'TRADING_ENABLED kapalı (dry-run)',
            dip_reversal_disabled: 'Dip reversal kapalı',
            max_concurrent: 'Maksimum açık pozisyon dolu',
            already_open: 'Bu sembolde zaten açık pozisyon var',
            grid_held: 'Sembol grid tarafından tutuluyor',
            symbol_not_found: 'Sembol bulunamadı / watchlist dışı',
            no_mid: 'Canlı fiyat (mid) yok',
            system_blocked: 'Sistem tarafından bloklu sembol',
            entry_failed: 'Emir veya trailing başarısız',
          };
          setBuyMsg(res.message ?? errTr[res.error ?? ''] ?? res.error ?? 'Alım başarısız');
        }
      } catch (e) {
        setBuyMsg(e instanceof Error ? e.message : 'Alım hatası');
      } finally {
        setBuyingSymbol(null);
      }
    },
    [data?.tradingEnabled, data?.adapt.manualBuyQuoteUsdt, loadCore],
  );

  useEffect(() => {
    const LIVE_MS = 3_000;
    let cancelled = false;
    let inFlight = false;
    const tickLive = () => {
      if (cancelled || document.visibilityState === 'hidden' || inFlight) return;
      inFlight = true;
      apiFetch<DipLivePatch>('/admin/api/dip-reversal/live')
        .then((patch) => {
          setLiveErr(null);
          setCandidateScannedAt(patch.scannedAt);
          setData((prev) => {
            if (!prev) return prev;
            const candidates = mergeDipLiveCandidates(prev.candidates, patch.candidates);
            const keepAdapt =
              patch.adapt.dataWarning && prev.adapt.mode != null;
            return {
              ...prev,
              candidates,
              adapt: keepAdapt ? prev.adapt : patch.adapt,
            };
          });
        })
        .catch((e) => {
          setLiveErr(e instanceof Error ? e.message : 'canlı tarama hatası');
        })
        .finally(() => {
          inFlight = false;
        });
    };
    tickLive();
    const liveIv = setInterval(tickLive, LIVE_MS);
    return () => {
      cancelled = true;
      clearInterval(liveIv);
    };
  }, []);

  useEffect(() => {
    const open = data?.capacity.open ?? 0;
    if (open <= 0) return;
    const POS_MS = 5_000;
    let cancelled = false;
    const tickPos = () => {
      if (cancelled || document.visibilityState === 'hidden') return;
      apiFetch<DipPositionsPatch>('/admin/api/dip-reversal/positions-live')
        .then((patch) => {
          setData((prev) =>
            prev
              ? {
                  ...prev,
                  capacity: patch.capacity,
                  positions: patch.positions,
                }
              : prev,
          );
        })
        .catch(() => {});
    };
    tickPos();
    const posIv = setInterval(tickPos, POS_MS);
    return () => {
      cancelled = true;
      clearInterval(posIv);
    };
  }, [data?.capacity.open]);

  return (
    <AuthGuard>
      <Nav />
      <main className="mx-auto max-w-6xl px-3 py-4 sm:px-4 sm:py-6">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <h1 className="text-lg font-semibold text-white">Dip Reversal Sniper</h1>
          {data && (
            <span className="text-xs text-slate-500">
              · adaylar {timeAgo(candidateScannedAt ?? data.scannedAt)} önce
            </span>
          )}
        </div>

        {liveErr && (
          <div className="mb-4 rounded border border-amber-900/80 bg-amber-950/30 px-3 py-2 text-sm text-amber-200">
            Canlı aday taraması: {liveErr} — tam liste 30 sn&apos;de bir yenilenir.
          </div>
        )}

        {buyMsg && (
          <div
            className={`mb-4 rounded border px-3 py-2 text-sm ${
              buyMsg.includes('tamam')
                ? 'border-emerald-900/80 bg-emerald-950/30 text-emerald-200'
                : 'border-amber-900/80 bg-amber-950/30 text-amber-200'
            }`}
          >
            {buyMsg}
          </div>
        )}

        {err && (
          <div className="mb-4 rounded border border-rose-900 bg-rose-950/40 px-3 py-2 text-sm text-rose-300">
            {err}
          </div>
        )}
        {loading && !data && <p className="text-sm text-slate-400">Yükleniyor…</p>}

        {data && (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-6">
              <Card title="Durum">
                <span className={data.enabled ? 'text-emerald-400' : 'text-slate-400'}>
                  {data.enabled ? 'AKTİF' : 'KAPALI'}
                </span>
              </Card>
              <Card title="Emir modu">
                <span className={data.tradingEnabled ? 'text-red-400' : 'text-emerald-400'}>
                  {data.tradingEnabled ? 'CANLI' : 'PAPER'}
                </span>
              </Card>
              <Card title="Pozisyon">
                <span className="font-mono">
                  {data.capacity.open}/{data.capacity.max}
                </span>
              </Card>
              <Card title="Realize (bugün)">
                <span className={pnlTone(data.totals.realizedPnlToday)}>
                  {signed(data.totals.realizedPnlToday)} USDT
                </span>
                <span className="ml-1 text-[11px] text-slate-500">({data.totals.tradesToday})</span>
              </Card>
              <Card title="Realize (toplam)">
                <span className={pnlTone(data.pnl.totalPnlUsdt)}>
                  {signed(data.pnl.totalPnlUsdt)} USDT
                </span>
              </Card>
              <Card title="İşlem">
                <span className="font-mono text-sm">
                  {data.pnl.tradeCount} · {data.pnl.wins}K/{data.pnl.losses}Z
                </span>
              </Card>
            </div>

            {data.adapt.enabled && (
              <section className="rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs text-slate-300">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-slate-200">Rejim adaptasyonu</span>
                  {data.adapt.mode && (
                    <span className="rounded border border-indigo-500/40 bg-indigo-500/10 px-2 py-0.5 text-indigo-300">
                      {MODE_TR[data.adapt.mode] ?? data.adapt.mode}
                    </span>
                  )}
                  {data.adapt.blocksEntry && (
                    <span className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-amber-300">
                      {data.adapt.blockReason === 'volatile_riskoff_breadth'
                        ? `Giriş bloklu (volatile + breadth < ${data.adapt.volatileBlockBreadthMax}%)`
                        : 'Giriş bloklu (grind+block)'}
                    </span>
                  )}
                  {data.adapt.dataWarning && (
                    <span className="rounded border border-rose-500/40 bg-rose-500/10 px-2 py-0.5 text-rose-300">
                      Veri eksik
                    </span>
                  )}
                </div>
                {data.adapt.dataWarning && (
                  <p className="mb-1 text-rose-300/90">{data.adapt.dataWarning}</p>
                )}
                <p className="text-slate-400">
                  BTC trend: {data.adapt.trend ?? '—'} · EMA ayrışma:{' '}
                  {data.adapt.emaSepPct != null ? `${data.adapt.emaSepPct.toFixed(2)}%` : '—'} · ATR:{' '}
                  {data.adapt.atrPct != null ? `${data.adapt.atrPct.toFixed(2)}%` : '—'} · Breadth:{' '}
                  {data.adapt.breadthPct != null ? `${data.adapt.breadthPct.toFixed(0)}%` : '—'}
                  {data.adapt.riskOff ? ' (risk-off)' : ''}
                </p>
                <p className="mt-1 text-slate-500">
                  Etkin eşikler — düşüş ≥{data.adapt.effectiveMinCapitulationDropPct ?? '—'}% · reversal ≥
                  {data.adapt.effectiveMinReversalScore ?? '—'} · toparlanma ≥
                  {data.adapt.effectiveMinRecoveryFromLowPct ?? '—'}%
                  {data.adapt.enabled && data.adapt.effectiveBuyQuoteUsdt != null && (
                    <>
                      {' '}
                      · otomatik alım{' '}
                      <span className="font-mono text-emerald-300/90">
                        {data.adapt.effectiveBuyQuoteUsdt} USDT
                      </span>
                    </>
                  )}
                  {' '}
                  · manuel alım{' '}
                  <span className="font-mono text-amber-300/90">{data.adapt.manualBuyQuoteUsdt} USDT</span>
                </p>
              </section>
            )}

            <p className="text-xs leading-relaxed text-slate-400">
              Yüksek dalgalı düşüşte capitulation dip + bounce onayı → tek market alım, Binance native
              trailing ile çıkış, hard-stop koruması. Grid&apos;e sıfır temas. Eşikler:
              capitulation ≥%{data.config.minCapitulationDropPct} ({data.config.flashWindowMin}dk),
              WS düşüş ≥%{data.config.minWsDeclinePct}, toparlanma ≥%
              {data.config.minRecoveryFromLowPct}, reversal ≥{data.config.minReversalScore}, dip ≤
              {data.config.maxSecSinceTrough}sn, midSlope {data.config.requireMidSlope ? 'şart' : 'opsiyonel'} ·
              trailing {data.config.trailingActivationPct}/{data.config.trailingCallbackPct}% ·
              hard-stop %{data.config.hardStopPct} · otomatik alım rejime göre (adapt) · manuel{' '}
              {data.adapt.manualBuyQuoteUsdt} USDT.
            </p>

            <Section title={`Alınan coinler (${data.positions.length})`}>
              {data.positions.length === 0 ? (
                <p className="px-3 py-4 text-sm text-slate-500">Henüz alım yok.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="text-xs text-slate-400">
                      <tr>
                        <th className="px-2 py-2">Sembol</th>
                        <th className="px-2 py-2">Maliyet</th>
                        <th className="px-2 py-2">Fiyat</th>
                        <th className="px-2 py-2">PnL%</th>
                        <th className="px-2 py-2">PnL $</th>
                        <th className="px-2 py-2">Değer $</th>
                        <th className="px-2 py-2">Hard-stop</th>
                        <th
                          className="px-2 py-2"
                          title="Trailing aktivasyonuna kalan yükseliş % (hedef: maliyet + aktivasyon%)"
                        >
                          Trailing
                        </th>
                        <th className="px-2 py-2">Süre</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.positions.map((p) => {
                        const up = p.pnlPct != null && Number(p.pnlPct) >= 0;
                        const trail = trailingStatus(
                          p.avgCost,
                          p.lastPrice,
                          data.config.trailingActivationPct,
                          data.config.trailingCallbackPct,
                          Boolean(p.trailingOrderId),
                        );
                        return (
                          <tr key={p.id} className="border-t border-slate-800">
                            <td className="px-2 py-2 font-medium">
                              <SymbolTradeLink symbol={p.symbol} />
                            </td>
                            <td className="px-2 py-2 font-mono text-slate-300">
                              {formatPrice(p.avgCost)}
                            </td>
                            <td className="px-2 py-2 font-mono text-slate-300">
                              {p.lastPrice ? formatPrice(p.lastPrice) : '—'}
                            </td>
                            <td className={`px-2 py-2 ${up ? 'text-emerald-400' : 'text-rose-400'}`}>
                              {pct(p.pnlPct)}
                            </td>
                            <td className={`px-2 py-2 ${up ? 'text-emerald-400' : 'text-rose-400'}`}>
                              {p.pnlUsdt != null ? signed(p.pnlUsdt, 2) : '—'}
                            </td>
                            <td className="px-2 py-2 font-mono text-slate-300">
                              {p.marketValueUsdt != null ? formatUsdt(p.marketValueUsdt) : '—'}
                            </td>
                            <td className="px-2 py-2 text-slate-400">%{p.hardStopPct ?? '—'}</td>
                            <td
                              className={`px-2 py-2 font-mono text-xs ${
                                trail.active
                                  ? 'text-emerald-400'
                                  : trail.label.startsWith('+')
                                    ? 'text-amber-300'
                                    : 'text-slate-500'
                              }`}
                              title={trail.title}
                            >
                              {trail.label}
                            </td>
                            <td className="px-2 py-2 text-slate-500">{timeAgo(p.openedAt)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Section>

            <Section
              title={`Aday Uygunluk (${data.candidates.filter((c) => c.ready).length} hazır / ${data.candidates.length})`}
            >
              <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 px-3 text-[11px] text-slate-500">
                <p>
                  Canlı (~3sn): WS/rev anlık; kline sütunları üst ~30 + hazır aday + açık pozisyon (tam liste 30sn).
                  <span className="text-slate-400">
                    {' '}
                    📌 sabitle · ▶ manuel market alım (sabitlenmiş satır). Giriş fiyatı + Max↓/↑ izlenir.
                  </span>
                </p>
                {manualPins.length > 0 && (
                  <button
                    type="button"
                    onClick={clearManualPins}
                    className="text-amber-400/90 hover:text-amber-300"
                  >
                    Sabitlemeleri kaldır ({manualPins.length})
                  </button>
                )}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="text-xs text-slate-400">
                    <tr>
                      <th className="w-8 px-1 py-2" title="Üste sabitle">
                        📌
                      </th>
                      <th className="w-9 px-1 py-2" title="Manuel market alım (dip reversal)">
                        Al
                      </th>
                      <th className="px-2 py-2">Sembol</th>
                      <th className="px-2 py-2" title="📌 anındaki mid (giriş referansı)">
                        Giriş
                      </th>
                      <th className="px-2 py-2" title="Girişten sonra en düşük %">
                        Max↓
                      </th>
                      <th className="px-2 py-2" title="Girişten sonra en yüksek %">
                        Max↑
                      </th>
                      <th className="px-2 py-2" title="Şu an girişe göre %">
                        Şimdi
                      </th>
                      <th
                        className="px-2 py-2"
                        title="Son 3 dk: 1m tepe → şimdi ani düşüş %"
                      >
                        Flash3m
                      </th>
                      <th
                        className="px-2 py-2"
                        title={`${data.config.flashWindowMin} dk 5m mum: sıralı tepe→dip max drawdown (capitulation kapısı)`}
                      >
                        Flash{data.config.flashWindowMin}dk
                      </th>
                      <th className="px-2 py-2" title="Güncel fiyatın 1 dk önceki 1m kapanışa göre değişimi">
                        1dk
                      </th>
                      <th className="px-2 py-2" title="Güncel fiyatın 3 dk önceki 1m kapanışa göre değişimi">
                        3dk
                      </th>
                      <th className="px-2 py-2" title="Güncel fiyatın 10 dk önceki 1m kapanışa göre değişimi">
                        10dk
                      </th>
                      <th className="px-2 py-2" title="Güncel fiyatın 30 dk önceki 1m kapanışa göre değişimi">
                        30dk
                      </th>
                      <th className="px-2 py-2" title="WS tick düşüşü %">WS%</th>
                      <th className="px-2 py-2" title="Diptan toparlanma %">Topar%</th>
                      <th className="px-2 py-2" title="Reversal skoru">RevSk</th>
                      <th className="px-2 py-2" title="Dipten geçen sn">Dip sn</th>
                      <th className="px-2 py-2" title="Yükselen mid eğimi">Slope</th>
                      <th className="px-2 py-2">Kapı</th>
                      <th className="min-w-[8rem] px-2 py-2">Durum</th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayCandidates.map((c) => {
                      const isManualPin = manualPinSet.has(c.symbol);
                      const track: DipPinTrack | undefined = pinState.tracks[c.symbol];
                      const nowPct =
                        track != null ? currentPctFromEntry(track, c.mid) : null;
                      return (
                      <tr
                        key={c.symbol}
                        className={`border-t border-slate-800 ${
                          isManualPin
                            ? 'bg-amber-950/35'
                            : c.pinned
                              ? 'bg-sky-950/40'
                              : ''
                        }`}
                      >
                        <td className="px-1 py-2 text-center">
                          <button
                            type="button"
                            onClick={() => toggleManualPin(c.symbol, c.mid)}
                            className={`rounded p-0.5 text-base leading-none transition ${
                              isManualPin
                                ? 'text-amber-300 hover:text-amber-200'
                                : 'text-slate-600 hover:text-amber-400/80'
                            }`}
                            title={isManualPin ? 'Sabitlemeyi kaldır' : 'Üste sabitle'}
                            aria-label={isManualPin ? `${c.symbol} sabitlemesini kaldır` : `${c.symbol} üste sabitle`}
                          >
                            {isManualPin ? '★' : '☆'}
                          </button>
                        </td>
                        <td className="px-1 py-2 text-center">
                          {isManualPin ? (
                            <button
                              type="button"
                              disabled={
                                buyingSymbol != null ||
                                !data.tradingEnabled ||
                                c.pinned ||
                                c.excluded === 'grid' ||
                                c.excluded === 'open_position' ||
                                c.excluded === 'system_blocked' ||
                                !c.mid
                              }
                              onClick={() => void handleManualBuy(c)}
                              className="rounded bg-emerald-600/80 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
                              title={
                                !data.tradingEnabled
                                  ? 'TRADING_ENABLED kapalı'
                                  : c.pinned || c.excluded === 'open_position'
                                    ? 'Zaten açık pozisyon'
                                    : `Manuel market alım ${data.adapt.manualBuyQuoteUsdt} USDT`
                              }
                            >
                              {buyingSymbol === c.symbol ? '…' : '▶'}
                            </button>
                          ) : (
                            <span className="text-slate-700">·</span>
                          )}
                        </td>
                        <td className="px-2 py-2 font-medium">
                          <SymbolTradeLink symbol={c.symbol} />
                          {isManualPin && (
                            <span className="ml-1.5 rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-200/90">
                              Sabit
                            </span>
                          )}
                          {c.pinned && !isManualPin && (
                            <span className="ml-1.5 rounded bg-sky-500/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-300">
                              Pozisyon
                            </span>
                          )}
                          {c.mid && (
                            <span className="ml-1 font-mono text-xs text-slate-500">
                              {formatPrice(c.mid)}
                            </span>
                          )}
                        </td>
                        <PinTrackCells
                          isManualPin={isManualPin}
                          track={track}
                          nowPct={nowPct}
                        />
                        <FlashDropCell value={c.flashDrop3mPct} />
                        <GateCell value={c.windowDropPct} ok={gatePass(c, 'capitulation')} suffix="%" />
                        <ChangeCell value={c.change1mPct} />
                        <ChangeCell value={c.change3mPct} />
                        <ChangeCell value={c.change10mPct} />
                        <ChangeCell value={c.change30mPct} />
                        <GateCell value={c.wsDeclinePct} ok={gatePass(c, 'ws_decline')} suffix="%" />
                        <GateCell
                          value={c.recoveryFromWsLowPct}
                          ok={gatePass(c, 'recovery')}
                          suffix="%"
                          digits={3}
                        />
                        <GateCell value={c.reversalScore} ok={gatePass(c, 'reversal_score')} digits={2} />
                        <GateCell
                          value={c.secSinceTrough}
                          ok={gatePass(c, 'trough_recency')}
                          digits={0}
                        />
                        <td className="px-2 py-2">
                          <span className={c.midSlopeOk ? 'text-emerald-400' : 'text-slate-500'}>
                            {c.midSlopeOk ? '↑' : '↓'}
                          </span>
                        </td>
                        <td className="px-2 py-2 text-slate-300">
                          {c.gatesPassed}/{c.gatesTotal}
                        </td>
                        <td className="px-2 py-2">
                          {c.ready ? (
                            <span className="rounded bg-emerald-500/15 px-2 py-0.5 text-xs font-semibold text-emerald-300">
                              HAZIR{c.score != null ? ` · ${c.score.toFixed(1)}` : ''}
                            </span>
                          ) : (
                            <span className="text-xs text-amber-400/80">
                              {BLOCKER_TR[c.primaryBlocker ?? ''] ?? c.primaryBlocker ?? '—'}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                    })}
                    {displayCandidates.length === 0 && (
                      <tr>
                        <td colSpan={20} className="px-2 py-4 text-sm text-slate-500">
                          Watchlist boş veya WS verisi yok.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </Section>

            <section>
              <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-lg font-medium">Bugün realize (dip reversal)</h2>
                <span className="text-sm text-slate-400">
                  {data.totals.tradesToday} işlem ·{' '}
                  <span className={pnlTone(data.totals.realizedPnlToday)}>
                    {signed(data.totals.realizedPnlToday)} USDT
                  </span>
                </span>
              </div>
              {data.closedTradesToday.length === 0 ? (
                <p className="text-sm text-slate-500">Bugün (TR saati) realize işlem yok</p>
              ) : (
                <div className="max-h-96 overflow-auto rounded-lg border border-slate-800">
                  <table className="w-full text-left text-xs">
                    <thead className="sticky top-0 bg-slate-900 text-slate-400">
                      <tr>
                        <th className="px-2 py-2">Zaman</th>
                        <th className="px-2 py-2">Sembol</th>
                        <th className="px-2 py-2">Çıkış</th>
                        <th className="px-2 py-2">PnL (USDT)</th>
                        <th className="px-2 py-2">PnL%</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.closedTradesToday.map((t, i) => (
                        <tr key={i} className="border-t border-slate-800">
                          <td className="px-2 py-1 text-slate-500">
                            {formatDateTimeIstanbul(t.closedAt)}
                          </td>
                          <td className="px-2 py-1 font-mono">{t.symbol}</td>
                          <td className="px-2 py-1 text-slate-500">{exitLabel(t.source)}</td>
                          <td className={`px-2 py-1 font-mono ${pnlTone(t.pnlUsdt)}`}>
                            {signed(t.pnlUsdt, 2)}
                          </td>
                          <td className={`px-2 py-1 font-mono ${pnlTone(t.pnlPct ?? 0)}`}>
                            {t.pnlPct == null ? '—' : `${signed(t.pnlPct, 2)}%`}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <Section title="Son aktivite">
              {data.recent.length === 0 ? (
                <p className="px-3 py-4 text-sm text-slate-500">Henüz dip_reversal olayı yok.</p>
              ) : (
                <ul className="divide-y divide-slate-800 text-sm">
                  {data.recent.map((a, i) => (
                    <li key={i} className="flex items-center justify-between px-3 py-2">
                      <span className="text-slate-300">
                        <span className="font-mono text-xs text-slate-400">
                          {ACTIVITY_TR[a.eventType] ?? a.eventType}
                        </span>
                        {a.symbol && <span className="ml-2 text-white">{a.symbol}</span>}
                      </span>
                      <span className="text-xs text-slate-500">{timeAgo(a.createdAt)} önce</span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </div>
        )}
      </main>
    </AuthGuard>
  );
}

function PinTrackCells({
  isManualPin,
  track,
  nowPct,
}: {
  isManualPin: boolean;
  track: DipPinTrack | undefined;
  nowPct: number | null;
}) {
  if (!isManualPin) {
    return (
      <>
        <td className="px-2 py-2 text-slate-700">—</td>
        <td className="px-2 py-2 text-slate-700">—</td>
        <td className="px-2 py-2 text-slate-700">—</td>
        <td className="px-2 py-2 text-slate-700">—</td>
      </>
    );
  }
  if (!track) {
    return (
      <>
        <td colSpan={4} className="px-2 py-2 text-xs text-amber-400/70">
          Giriş fiyatı bekleniyor (mid yok)
        </td>
      </>
    );
  }
  return (
    <>
      <td className="px-2 py-2 font-mono text-xs text-slate-300">{formatPrice(String(track.entryMid))}</td>
      <td className="px-2 py-2 font-mono text-xs text-rose-400">
        {track.maxDropPct <= 0 ? `${track.maxDropPct.toFixed(2)}%` : '0.00%'}
      </td>
      <td className="px-2 py-2 font-mono text-xs text-emerald-400">
        {track.maxRisePct >= 0 ? `+${track.maxRisePct.toFixed(2)}%` : '0.00%'}
      </td>
      <td
        className={`px-2 py-2 font-mono text-xs ${
          nowPct == null
            ? 'text-slate-600'
            : nowPct >= 0
              ? 'text-emerald-400'
              : 'text-rose-400'
        }`}
      >
        {nowPct == null ? '—' : `${nowPct >= 0 ? '+' : ''}${nowPct.toFixed(2)}%`}
      </td>
    </>
  );
}

function SymbolTradeLink({ symbol }: { symbol: string }) {
  return (
    <a
      href={binanceSpotTradeUrl(symbol)}
      target="_blank"
      rel="noopener noreferrer"
      className="text-white hover:text-sky-300 hover:underline"
      title={`Binance spot: ${symbol}`}
    >
      {spotSymbolLabel(symbol)}
    </a>
  );
}

function gatePass(c: CandidateView, id: string): boolean {
  return c.gates.find((g) => g.id === id)?.pass ?? false;
}

function FlashDropCell({ value }: { value: number | null }) {
  if (value == null) return <td className="px-2 py-2 text-slate-600">—</td>;
  const hot = value >= 0.8;
  return (
    <td
      className={`px-2 py-2 font-mono text-xs tabular-nums ${
        hot ? 'font-semibold text-rose-400' : 'text-slate-300'
      }`}
    >
      {value.toFixed(2)}%
    </td>
  );
}

function ChangeCell({ value }: { value: number | null }) {
  if (value == null) return <td className="px-2 py-2 text-slate-600">—</td>;
  const up = value >= 0;
  return (
    <td className={`px-2 py-2 ${up ? 'text-emerald-400' : 'text-rose-400'}`}>
      {`${up ? '+' : ''}${value.toFixed(2)}%`}
    </td>
  );
}

function GateCell({
  value,
  ok,
  suffix = '',
  digits = 2,
}: {
  value: number | null;
  ok: boolean;
  suffix?: string;
  digits?: number;
}) {
  return (
    <td className={`px-2 py-2 ${value == null ? 'text-slate-600' : ok ? 'text-emerald-400' : 'text-slate-400'}`}>
      {value == null ? '—' : `${value.toFixed(digits)}${suffix}`}
    </td>
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

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900/40">
      <h2 className="border-b border-slate-800 px-3 py-2 text-sm font-semibold text-slate-200">
        {title}
      </h2>
      {children}
    </section>
  );
}
