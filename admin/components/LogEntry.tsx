'use client';

import { useState } from 'react';
import { formatDateTimeIstanbul } from '@/lib/datetime';
import { formatLog, pnlColor, type LogTone } from '@/lib/log-format';

const TONE_STYLES: Record<LogTone, string> = {
  success: 'bg-emerald-900/50 text-emerald-300 border-emerald-800',
  warning: 'bg-amber-900/40 text-amber-300 border-amber-800',
  error: 'bg-red-900/40 text-red-300 border-red-800',
  info: 'bg-sky-900/40 text-sky-300 border-sky-800',
  muted: 'bg-slate-800/80 text-slate-400 border-slate-700',
  neutral: 'bg-slate-800 text-slate-300 border-slate-700',
};

export interface LogEntryProps {
  id: number;
  event_type: string;
  created_at: string;
  payload: unknown;
  compact?: boolean;
}

export function LogEntry({ id, event_type, created_at, payload, compact }: LogEntryProps) {
  const [rawOpen, setRawOpen] = useState(false);
  const f = formatLog(event_type, payload);
  const hasPayload = payload != null && typeof payload === 'object' && Object.keys(payload as object).length > 0;

  return (
    <li className="rounded-lg border border-slate-800 bg-slate-900 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded border px-2 py-0.5 text-xs font-medium ${TONE_STYLES[f.tone]}`}
        >
          {f.label}
        </span>
        <span className="font-mono text-xs text-slate-500">{event_type}</span>
        <time
          dateTime={created_at}
          title={`Kayıt (UTC): ${created_at}`}
          className="ml-auto text-xs text-slate-500"
        >
          {formatDateTimeIstanbul(created_at)}
        </time>
        {!compact && <span className="text-xs text-slate-600">#{id}</span>}
      </div>

      <p className="mt-2 text-slate-100">{f.summary}</p>

      {f.details.length > 0 && (
        <dl
          className={`mt-2 grid gap-x-4 gap-y-1 text-xs ${compact ? 'grid-cols-2 sm:grid-cols-3' : 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4'}`}
        >
          {f.details.map((d) => (
            <div key={d.label}>
              <dt className="text-slate-500">{d.label}</dt>
              <dd
                className={`font-mono text-slate-300 ${d.label === 'PnL' ? pnlColor(d.value.replace(' USDT', '')) : ''}`}
              >
                {d.value}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {hasPayload && (
        <button
          type="button"
          onClick={() => setRawOpen((v) => !v)}
          className="mt-2 text-xs text-slate-500 hover:text-slate-300"
        >
          {rawOpen ? 'Ham JSON gizle' : 'Ham JSON'}
        </button>
      )}
      {rawOpen && (
        <pre className="mt-1 max-h-48 overflow-auto rounded bg-slate-950 p-2 text-xs text-slate-500">
          {JSON.stringify(payload, null, 2)}
        </pre>
      )}
    </li>
  );
}
