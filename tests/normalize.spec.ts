import { describe, expect, it } from 'vitest';

import { normalizeConfidence } from '../src/lib/normalize';

describe('normalizeConfidence', () => {
  it('normalizes values within 0-100 to 0-1 with two decimals', () => {
    expect(normalizeConfidence(42)).toBe(0.42);
    expect(normalizeConfidence(100)).toBe(1);
  });

  it('clamps out-of-range values before scaling', () => {
    expect(normalizeConfidence(150)).toBe(1);
    expect(normalizeConfidence(-10)).toBe(0);
  });

  it('rejects invalid numbers', () => {
    expect(() => normalizeConfidence(Number.NaN)).toThrow('Confidence must be a finite number');
  });
});
