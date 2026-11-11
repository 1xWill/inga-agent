export type SeriesPoint = { t: number; equity: number; realized: number; unrealized: number };

export const BUCKET_STEPS_MS = [
  60_000, // 1m
  5 * 60_000, // 5m
  15 * 60_000, // 15m
  30 * 60_000, // 30m
  60 * 60_000, // 1h
  2 * 60 * 60_000, // 2h
  4 * 60 * 60_000, // 4h
  12 * 60 * 60_000, // 12h
  24 * 60 * 60_000 // 1d
];

export function bucketLabelToMs(label: string): number {
  const m = label.trim().toLowerCase();
  if (m.endsWith('ms')) return Math.max(1, parseInt(m, 10));
  if (m.endsWith('s')) return Math.max(1000, parseInt(m, 10) * 1000);
  if (m.endsWith('m')) return Math.max(60_000, parseInt(m, 10) * 60_000);
  if (m.endsWith('h')) return Math.max(3_600_000, parseInt(m, 10) * 3_600_000);
  if (m.endsWith('d')) return Math.max(86_400_000, parseInt(m, 10) * 86_400_000);
  return 5 * 60_000; // default 5m
}

export function msToBucketLabel(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

export function floorToBucket(ts: number, bucketMs: number): number {
  return Math.floor(ts / bucketMs) * bucketMs;
}

export function groupAndDownsample(points: SeriesPoint[], bucketMs: number): SeriesPoint[] {
  if (points.length === 0) return points;
  const map = new Map<number, SeriesPoint>();
  for (const p of points) {
    const key = floorToBucket(p.t, bucketMs);
    const prev = map.get(key);
    if (!prev || p.t > prev.t) map.set(key, p);
  }
  return Array.from(map.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v);
}
