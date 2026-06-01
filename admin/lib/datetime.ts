/** D1 / Worker kayıtları UTC; panelde İstanbul saati gösterilir. */
export const APP_TIMEZONE = 'Europe/Istanbul';

export function parseDbTimestamp(ts: string): Date {
  const trimmed = ts.trim();
  if (!trimmed) return new Date(NaN);
  if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
    const normalized =
      trimmed.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(trimmed) ? trimmed : `${trimmed}Z`;
    return new Date(normalized);
  }
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(trimmed)) {
    return new Date(trimmed.replace(' ', 'T') + 'Z');
  }
  return new Date(trimmed);
}

export function formatDateTimeIstanbul(ts: string, style: 'full' | 'short' = 'full'): string {
  const d = parseDbTimestamp(ts);
  if (Number.isNaN(d.getTime())) return ts;

  if (style === 'short') {
    return new Intl.DateTimeFormat('tr-TR', {
      timeZone: APP_TIMEZONE,
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(d);
  }

  return new Intl.DateTimeFormat('tr-TR', {
    timeZone: APP_TIMEZONE,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(d);
}
