// Date formatting, matching the Go build exactly (frontend/src/ui.tsx).
//
// Bare toLocaleString() renders "7/31/2026, 11:23:45 AM" — locale-dependent,
// seconds nobody asked for, and an ambiguous numeric month. The explicit
// options give "Jul 31, 2026, 11:23 AM": one shape everywhere, and a month
// abbreviation that cannot be read as a day.
//
// Both take UNIX SECONDS. The platform sends seconds; Date wants milliseconds,
// and getting that wrong silently renders 1970.

export function fmtDate(unix?: number): string {
  if (!unix) return '—'
  return new Date(unix * 1000).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

export function fmtDateTime(unix?: number): string {
  if (!unix) return '—'
  return new Date(unix * 1000).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}
