import { describe, it, expect } from 'vitest';
import { bucketLabelToMs, msToBucketLabel, groupAndDownsample, SeriesPoint, floorToBucket } from '../src/server/portfolioHistory';

describe('portfolio history bucketing', () => {
  it('parses common bucket labels', () => {
    expect(bucketLabelToMs('1m')).toBe(60_000);
    expect(bucketLabelToMs('5m')).toBe(5 * 60_000);
    expect(bucketLabelToMs('1h')).toBe(3_600_000);
    expect(bucketLabelToMs('1d')).toBe(86_400_000);
    expect(msToBucketLabel(60_000)).toBe('1m');
    expect(msToBucketLabel(3_600_000)).toBe('1h');
    expect(msToBucketLabel(86_400_000)).toBe('1d');
  });

  it('keeps latest sample within each bucket window', () => {
    const bucketMs = 60_000; // 1m
    const base = floorToBucket(Date.now(), bucketMs); // align to minute boundary
    const pts: SeriesPoint[] = [
      { t: base + 1_000, equity: 100, realized: 0, unrealized: 0 },
      { t: base + 50_000, equity: 101, realized: 0, unrealized: 1 }, // same minute as first, later
      { t: base + 61_000, equity: 102, realized: 0, unrealized: 2 }
    ];
    const grouped = groupAndDownsample(pts, bucketMs);
    expect(grouped.length).toBe(2);
    expect(grouped[0].equity).toBe(101);
    expect(grouped[1].equity).toBe(102);
  });
});
