'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { AuthGuard } from '@/components/AuthGuard';
import { Nav } from '@/components/Nav';
import { apiFetch } from '@/lib/api';
import { formatDateTimeIstanbul } from '@/lib/datetime';

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
  change3mPct: number | null;
  change10mPct: number | null;
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
  recent: ActivityView[];
  scannedAt: string;
}

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
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch<DipReport>('/admin/api/dip-reversal');
      setData(res);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'hata');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [load]);

  return (
    <AuthGuard>
      <Nav />
      <main className="mx-auto max-w-6xl px-3 py-4 sm:px-4 sm:py-6">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <h1 className="text-lg font-semibold text-white">Dip Reversal Sniper</h1>
          {data && (
            <span className="text-xs text-slate-500">· {timeAgo(data.scannedAt)} önce</span>
          )}
        </div>

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

            <p className="text-xs leading-relaxed text-slate-400">
              Yüksek dalgalı düşüşte capitulation dip + bounce onayı → tek market alım, Binance native
              trailing ile çıkış, hard-stop koruması. Grid&apos;e sıfır temas. Eşikler:
              capitulation ≥%{data.config.minCapitulationDropPct} ({data.config.flashWindowMin}dk),
              WS düşüş ≥%{data.config.minWsDeclinePct}, toparlanma ≥%
              {data.config.minRecoveryFromLowPct}, reversal ≥{data.config.minReversalScore}, dip ≤
              {data.config.maxSecSinceTrough}sn, midSlope {data.config.requireMidSlope ? 'şart' : 'opsiyonel'} ·
              trailing {data.config.trailingActivationPct}/{data.config.trailingCallbackPct}% ·
              hard-stop %{data.config.hardStopPct} · alım {data.config.buyQuoteUsdt} USDT.
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
                        <th className="px-2 py-2">Trailing</th>
                        <th className="px-2 py-2">Süre</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.positions.map((p) => {
                        const up = p.pnlPct != null && Number(p.pnlPct) >= 0;
                        return (
                          <tr key={p.id} className="border-t border-slate-800">
                            <td className="px-2 py-2 font-medium text-white">{p.symbol}</td>
                            <td className="px-2 py-2 text-slate-300">{p.avgCost}</td>
                            <td className="px-2 py-2 text-slate-300">{p.lastPrice ?? '—'}</td>
                            <td className={`px-2 py-2 ${up ? 'text-emerald-400' : 'text-rose-400'}`}>
                              {pct(p.pnlPct)}
                            </td>
                            <td className={`px-2 py-2 ${up ? 'text-emerald-400' : 'text-rose-400'}`}>
                              {p.pnlUsdt ?? '—'}
                            </td>
                            <td className="px-2 py-2 text-slate-300">{p.marketValueUsdt ?? '—'}</td>
                            <td className="px-2 py-2 text-slate-400">%{p.hardStopPct ?? '—'}</td>
                            <td className="px-2 py-2 text-slate-500">{p.trailingOrderId ?? '—'}</td>
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
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="text-xs text-slate-400">
                    <tr>
                      <th className="px-2 py-2">Sembol</th>
                      <th className="px-2 py-2" title="Capitulation: pencere içi tepe→dip max drawdown %">
                        Düşüş%
                      </th>
                      <th className="px-2 py-2" title="Güncel fiyatın 3 dk önceki 1m kapanışa göre değişimi">
                        3dk
                      </th>
                      <th className="px-2 py-2" title="Güncel fiyatın 10 dk önceki 1m kapanışa göre değişimi">
                        10dk
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
                    {data.candidates.map((c) => (
                      <tr key={c.symbol} className="border-t border-slate-800">
                        <td className="px-2 py-2 font-medium text-white">
                          {c.symbol}
                          {c.mid && <span className="ml-1 text-xs text-slate-500">{c.mid}</span>}
                        </td>
                        <GateCell value={c.windowDropPct} ok={gatePass(c, 'capitulation')} suffix="%" />
                        <ChangeCell value={c.change3mPct} />
                        <ChangeCell value={c.change10mPct} />
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
                    ))}
                    {data.candidates.length === 0 && (
                      <tr>
                        <td colSpan={11} className="px-2 py-4 text-sm text-slate-500">
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
                        <span className="font-mono text-xs text-slate-400">{a.eventType}</span>
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

function gatePass(c: CandidateView, id: string): boolean {
  return c.gates.find((g) => g.id === id)?.pass ?? false;
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
