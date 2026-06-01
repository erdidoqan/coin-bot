'use client';

import { useCallback, useEffect, useState } from 'react';
import { AuthGuard } from '@/components/AuthGuard';
import { LogEntry } from '@/components/LogEntry';
import { Nav } from '@/components/Nav';
import { LOG_PRESETS, NOISY_EVENT_TYPES } from '@/lib/log-format';
import { apiFetch } from '@/lib/api';

interface LogRow {
  id: number;
  event_type: string;
  created_at: string;
  payload: unknown;
}

export default function LogsPage() {
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [preset, setPreset] = useState('POSITION_CLOSED');
  const [offset, setOffset] = useState(0);
  const limit = 50;
  const [error, setError] = useState('');

  const load = useCallback(() => {
    const activePreset = LOG_PRESETS.find((p) => p.id === preset) ?? LOG_PRESETS[0];
    const q = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (activePreset.event) q.set('event', activePreset.event);
    if (activePreset.hideNoisy) {
      q.set('exclude', [...NOISY_EVENT_TYPES].join(','));
    }
    apiFetch<{ logs: LogRow[]; total: number }>(`/admin/api/logs?${q}`)
      .then((r) => {
        setLogs(r.logs);
        setTotal(r.total);
      })
      .catch((e) => setError(e.message));
  }, [offset, preset]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <AuthGuard>
      <Nav />
      <main className="mx-auto max-w-6xl px-4 py-6">
        <h1 className="mb-1 text-xl font-semibold">Olay günlüğü</h1>
        <p className="mb-4 text-sm text-slate-400">
          Saatler İstanbul (UTC+3).
        </p>
        <p className="mb-4 text-sm text-slate-400">
          Kayıtlar okunabilir özet olarak gösterilir; teknik detay için &quot;Ham JSON&quot;.
        </p>

        <div className="mb-4 flex flex-wrap gap-2">
          {LOG_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => {
                setPreset(p.id);
                setOffset(0);
              }}
              className={`rounded-full px-3 py-1 text-sm ${
                preset === p.id
                  ? 'bg-emerald-700 text-white'
                  : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-white'
              }`}
            >
              {p.label}
            </button>
          ))}
          <button
            type="button"
            onClick={load}
            className="rounded bg-slate-700 px-3 py-1.5 text-sm hover:bg-slate-600"
          >
            Yenile
          </button>
        </div>

        {error && <p className="text-red-400">{error}</p>}
        <p className="mb-2 text-sm text-slate-400">
          {total} kayıt · sayfa {Math.floor(offset / limit) + 1}
        </p>

        <ul className="space-y-2">
          {logs.length === 0 ? (
            <li className="rounded-lg border border-slate-800 bg-slate-900 p-6 text-center text-slate-500">
              Bu filtrede kayıt yok
            </li>
          ) : (
            logs.map((l) => (
              <LogEntry
                key={l.id}
                id={l.id}
                event_type={l.event_type}
                created_at={l.created_at}
                payload={l.payload}
              />
            ))
          )}
        </ul>

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - limit))}
            className="rounded bg-slate-700 px-3 py-1 text-sm disabled:opacity-40"
          >
            Önceki
          </button>
          <button
            type="button"
            disabled={offset + limit >= total}
            onClick={() => setOffset(offset + limit)}
            className="rounded bg-slate-700 px-3 py-1 text-sm disabled:opacity-40"
          >
            Sonraki
          </button>
        </div>
      </main>
    </AuthGuard>
  );
}
