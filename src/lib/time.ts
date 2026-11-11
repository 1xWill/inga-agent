export function formatRelativeTime(nowMs: number, iso?: string): string {
  if (!iso || iso === "—") return "—";
  const ref = new Date(iso);
  const seconds = Math.max(0, (nowMs - ref.getTime()) / 1000);
  if (seconds < 60) return `${Math.floor(seconds)}s ago`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.floor(minutes)}m ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.floor(hours)}h ago`;
  const days = hours / 24;
  return `${Math.floor(days)}d ago`;
}

export function formatSmartTime(nowMs: number, iso?: string): string {
  if (!iso || iso === '—') return '—';
  const d = new Date(iso);
  const seconds = Math.max(0, (nowMs - d.getTime()) / 1000);
  if (seconds < 86400) {
    return formatRelativeTime(nowMs, iso);
  }
  // Show local date time like "Oct 28 20:36"
  const short = d.toLocaleString(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  // Safari may include comma; normalize a bit
  return short.replace(',', '');
}
