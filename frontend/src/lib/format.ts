/** Formatting helpers (bytes, relative time, compact numbers, durations). Locale defaults to the browser's. */

const locale = (): string | undefined => (typeof navigator !== 'undefined' ? navigator.language : undefined);

/**
 * Locale for phrases (relative times): the interface is written in English, so wording stays English (in the
 * browser's English variant when it has one) instead of mixing "vor 5 Minuten" into English labels.
 */
const phraseLocale = (): string => {
  const l = locale();
  return l && /^en\b/i.test(l) ? l : 'en';
};

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** Binary byte sizes with familiar labels: 1536 → "1.5 KB", 0 → "0 B". */
export function formatBytes(bytes: number, opts: { decimals?: number; locale?: string } = {}): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < BYTE_UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  const decimals = opts.decimals ?? (v >= 100 ? 0 : 1);
  const n = new Intl.NumberFormat(opts.locale ?? locale(), {
    maximumFractionDigits: decimals,
    minimumFractionDigits: 0,
  }).format(v);
  return `${n} ${BYTE_UNITS[i]}`;
}

const DIVISIONS: ReadonlyArray<{ amount: number; unit: Intl.RelativeTimeFormatUnit }> = [
  { amount: 60, unit: 'second' },
  { amount: 60, unit: 'minute' },
  { amount: 24, unit: 'hour' },
  { amount: 7, unit: 'day' },
  { amount: 4.34524, unit: 'week' },
  { amount: 12, unit: 'month' },
  { amount: Number.POSITIVE_INFINITY, unit: 'year' },
];

/** "just now", "5 minutes ago", "yesterday", "in 3 days" … */
export function formatRelativeTime(timeMs: number, now: number = Date.now(), loc?: string): string {
  if (!Number.isFinite(timeMs)) return '—';
  let delta = (timeMs - now) / 1000;
  if (Math.abs(delta) < 45) return 'just now';
  const rtf = new Intl.RelativeTimeFormat(loc ?? phraseLocale(), { numeric: 'auto', style: 'long' });
  for (const d of DIVISIONS) {
    if (Math.abs(delta) < d.amount) return rtf.format(Math.round(delta), d.unit);
    delta /= d.amount;
  }
  return rtf.format(Math.round(delta), 'year');
}

/** 1234 → "1.2K", 1_500_000 → "1.5M". */
export function formatCompact(n: number, loc?: string): string {
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat(loc ?? locale(), { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

export function formatNumber(n: number, loc?: string): string {
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat(loc ?? locale()).format(n);
}

/** Milliseconds → "0:42", "12:05", "1:02:03". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Date + time for tooltips and lists, e.g. "9 Nov 2026, 14:05". */
export function formatDateTime(timeMs: number, loc?: string): string {
  return new Intl.DateTimeFormat(loc ?? locale(), { dateStyle: 'medium', timeStyle: 'short' }).format(timeMs);
}

/** Calendar day label used to group lists: "Today", "Yesterday", or a date. */
export function formatDayLabel(timeMs: number, now: number = Date.now(), loc?: string): string {
  const day = (t: number): number => {
    const d = new Date(t);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const diff = Math.round((day(now) - day(timeMs)) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return new Intl.DateTimeFormat(loc ?? phraseLocale(), { weekday: 'long', day: 'numeric', month: 'long' }).format(timeMs);
}

export function pluralize(n: number, one: string, many: string = `${one}s`): string {
  return `${formatNumber(n)} ${n === 1 ? one : many}`;
}
