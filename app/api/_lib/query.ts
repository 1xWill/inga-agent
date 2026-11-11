import type { NextRequest } from 'next/server';

type Searchable = Pick<Request, 'url'> | NextRequest | { url: string };

const truthyValues = new Set(['1', 'true', 'yes']);

export function getSearchParams(input: Searchable): URLSearchParams {
  return new URL(input.url).searchParams;
}

export function parseLimit(
  params: URLSearchParams,
  defaultValue: number,
  opts: { min?: number; max?: number } = {}
): number {
  const raw = params.get('limit');
  const parsed = raw !== null ? Number(raw) : NaN;
  const min = typeof opts.min === 'number' ? opts.min : 0;
  const max = typeof opts.max === 'number' ? opts.max : undefined;
  let value = Number.isFinite(parsed) ? Math.floor(parsed) : Math.floor(defaultValue);
  if (!Number.isFinite(value)) value = defaultValue;
  if (value < min) value = min;
  if (typeof max === 'number' && value > max) value = max;
  return value;
}

export function parseAgentId(params: URLSearchParams): string | undefined {
  const id = params.get('agentId');
  return id && id.length > 0 ? id : undefined;
}

export function parseBooleanFlag(params: URLSearchParams, key: string): boolean {
  const raw = params.get(key);
  return raw ? truthyValues.has(raw.toLowerCase()) : false;
}
