const dateFormat = new Intl.DateTimeFormat('en-AU', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});
const dateTimeFormat = new Intl.DateTimeFormat('en-AU', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/** Accepts the worker's two timestamp shapes: ISO strings and unix seconds. */
function toDate(value: string | number | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDate(value: string | number | null | undefined): string {
  const date = toDate(value);
  return date ? dateFormat.format(date) : 'unknown';
}

export function formatDateTime(value: string | number | null | undefined): string {
  const date = toDate(value);
  return date ? dateTimeFormat.format(date) : 'unknown';
}
