import { describe, expect, it } from 'vitest';
import { formatRelativeTime } from '../src/lib/time';

describe('formatRelativeTime', () => {
  const baseMs = Date.UTC(2024, 0, 1, 0, 0, 0);
  const baseIso = new Date(baseMs).toISOString();

  it('returns em dash when timestamp missing', () => {
    expect(formatRelativeTime(baseMs, undefined)).toBe('—');
    expect(formatRelativeTime(baseMs, '—')).toBe('—');
  });

  it('formats seconds within the first minute', () => {
    expect(formatRelativeTime(baseMs + 29_000, baseIso)).toBe('29s ago');
  });

  it('formats minutes within the first hour', () => {
    expect(formatRelativeTime(baseMs + 70_000, baseIso)).toBe('1m ago');
    expect(formatRelativeTime(baseMs + 59 * 60_000, baseIso)).toBe('59m ago');
  });

  it('formats hours within the first day', () => {
    expect(formatRelativeTime(baseMs + 5 * 3_600_000, baseIso)).toBe('5h ago');
  });

  it('formats days for longer differences', () => {
    expect(formatRelativeTime(baseMs + 3 * 86_400_000, baseIso)).toBe('3d ago');
  });
});
