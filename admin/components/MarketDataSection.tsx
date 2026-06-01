'use client';

import type { MarketDataStatus } from '@/lib/api';

function formatAgeMs(ms: number | null | undefined): string {
  if (ms == null || ms < 0) return '—';
  if (ms < 2000) return `${ms}ms`;
  return `${Math.round(ms / 1000)}s`;
}

export function MarketDataSection({ status }: { status: MarketDataStatus | null | undefined }) {
  if (!status) {
    return (
      <section className="rounded-lg border border-slate-800 bg-slate-900 p-4">
        <p className="text-sm text-slate-500">
          MARKET_DATA binding yok veya henüz uyanmadı. Scout veya sniper cron sonrası dolmalı.
        </p>
      </section>
    );
  }

  const liveOb = status.symbols.filter((s) => !s.stale && s.obAgeMs >= 0 && s.obAgeMs < 2000).length;
  const liveK1 = status.symbols.filter(
    (s) => s.kline1mAgeMs != null && s.kline1mAgeMs < 120_000,
  ).length;
  const wsOpen = status.wsShards.some((sh) => sh.open);
  const lastMsg =
    status.lastMessageAt != null
      ? `${Math.round((Date.now() - status.lastMessageAt) / 1000)} sn önce`
      : 'henüz yok';
  const tickerAge =
    status.tickerUpdatedAt != null ? formatAgeMs(Date.now() - status.tickerUpdatedAt) : '—';

  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900 p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs text-slate-500">
          depth + kline 1/5/15m + bookTicker · {status.symbolCount} sembol · {status.messageCount}{' '}
          mesaj
        </p>
      </div>
      <div className="mb-3 flex flex-wrap gap-4 text-sm">
        <span>
          WS shard:{' '}
          <span className={wsOpen ? 'text-emerald-400' : 'text-red-400'}>
            {status.wsShards.filter((s) => s.open).length}/{status.wsShards.length} açık
          </span>
        </span>
        <span>
          OB &lt;2s:{' '}
          <span className={liveOb > 0 ? 'text-emerald-400' : 'text-amber-400'}>
            {liveOb}/{status.symbolCount}
          </span>
        </span>
        <span>
          1m kline:{' '}
          <span className={liveK1 > 0 ? 'text-emerald-400' : 'text-amber-400'}>
            {liveK1}/{status.symbolCount}
          </span>
        </span>
        <span className="text-slate-400">
          Ticker: {status.tickerCount} · {tickerAge}
        </span>
        <span className="text-slate-400">Son mesaj: {lastMsg}</span>
      </div>
      {status.regime ? (
        <p className="mb-3 text-sm text-slate-300">
          Rejim: <span className="font-medium text-slate-100">{status.regime.regime}</span> · BTC ATR{' '}
          {status.regime.btcAtrPct}% · breadth {status.regime.breadthPct}%
        </p>
      ) : null}
      <div className="overflow-x-auto rounded border border-slate-800">
        <table className="w-full text-left text-xs">
          <thead className="bg-slate-950 text-slate-400">
            <tr>
              <th className="px-2 py-2">Sembol</th>
              <th className="px-2 py-2">Skor</th>
              <th className="px-2 py-2">OB</th>
              <th className="px-2 py-2">1m</th>
              <th className="px-2 py-2">5m</th>
              <th className="px-2 py-2">15m</th>
              <th className="px-2 py-2">Spread</th>
            </tr>
          </thead>
          <tbody>
            {status.symbols.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-3 text-slate-500">
                  Sembol yok — gözcü çalıştırın
                </td>
              </tr>
            ) : (
              status.symbols.slice(0, 80).map((s) => (
                <tr key={s.symbol} className="border-t border-slate-800">
                  <td className="px-2 py-2 font-mono">{s.symbol.replace('USDT', '')}</td>
                  <td className="px-2 py-2 font-mono">{s.liveScore ?? '—'}</td>
                  <td
                    className={`px-2 py-2 font-mono ${s.stale ? 'text-amber-400' : 'text-emerald-400/90'}`}
                  >
                    {formatAgeMs(s.obAgeMs >= 0 ? s.obAgeMs : null)}
                  </td>
                  <td className="px-2 py-2 font-mono">{formatAgeMs(s.kline1mAgeMs)}</td>
                  <td className="px-2 py-2 font-mono">{formatAgeMs(s.kline5mAgeMs)}</td>
                  <td className="px-2 py-2 font-mono">{formatAgeMs(s.kline15mAgeMs)}</td>
                  <td className="px-2 py-2 font-mono">{s.spreadPct.toFixed(3)}%</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
