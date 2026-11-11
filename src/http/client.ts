import { setTimeout as delay } from 'node:timers/promises';

import type { RetryPolicy, CircuitBreaker } from '../config/schema';

export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface HttpClientOptions {
  retry: RetryPolicy;
  timeoutMs: number;
  hostOverrides?: Record<string, { retry?: RetryPolicy; timeoutMs?: number; circuitBreaker?: CircuitBreaker }>;
}

export interface RequestOptions extends RequestInit {
  timeoutMs?: number;
  parseJson?: boolean;
  rawResponse?: boolean;
}

export type HttpClient = <T>(url: string, options?: RequestOptions) => Promise<T>;

function computeBackoff({ minDelayMs, maxDelayMs, factor }: RetryPolicy, attempt: number) {
  const exponential = minDelayMs * Math.pow(factor, attempt);
  return Math.min(Math.max(minDelayMs, exponential), maxDelayMs);
}

export function createHttpClient(opts: HttpClientOptions): HttpClient {
  const { retry, timeoutMs, hostOverrides } = opts;
  const circuit = new Map<string, { failures: number; openUntil?: number }>();
  const getPolicyForHost = (host: string, options: HttpClientOptions) => {
    const ov = options.hostOverrides?.[host];
    return {
      retry: ov?.retry ?? retry,
      timeoutMs: ov?.timeoutMs ?? timeoutMs,
      breaker: ov?.circuitBreaker as CircuitBreaker | undefined
    } as const;
  };
  return async function request<T>(url: string, options: RequestOptions = {}): Promise<T> {
    const { parseJson, rawResponse, timeoutMs: requestTimeout, ...restOptions } = options;
    const shouldParseJson = rawResponse ? false : parseJson ?? true;
    const mergedHeaders = new Headers(restOptions.headers);

    let host = '';
    try { host = new URL(url).host; } catch {}
    const pol = getPolicyForHost(host, { retry, timeoutMs, hostOverrides } as any);
    const maxAttempts = pol.retry.retries + 1;
    let attempt = 0;
    let lastError: unknown;

    while (attempt < maxAttempts) {
      // Circuit breaker: short-circuit when open
      const now = Date.now();
      if (pol.breaker) {
        const st = circuit.get(host);
        if (st?.openUntil && st.openUntil > now) {
          // eslint-disable-next-line no-console
          console.warn('[circuit-open]', { host, openForMs: st.openUntil - now });
          throw new Error('CircuitOpen');
        }
      }

      const controller = new AbortController();
      const timeout = requestTimeout ?? pol.timeoutMs;
      const requestInit: RequestInit = {
        ...restOptions,
        signal: controller.signal,
        headers: mergedHeaders
      };

      if (attempt > 0 && requestInit.body && typeof requestInit.body !== 'string') {
        throw new Error('Retrying non-repeatable request bodies is not supported');
      }

      try {
        const timeoutHandle = setTimeout(() => controller.abort(), timeout);
        const response = await fetch(url, requestInit);
        clearTimeout(timeoutHandle);

        if (!response.ok) {
          const text = await response.text();
          throw new HttpError(`Request failed with status ${response.status} at ${url}`,
            response.status,
            text
          );
        }

        if (rawResponse) {
          return response as unknown as T;
        }

        if (!shouldParseJson) {
          return (await response.text()) as unknown as T;
        }

        const contentType = response.headers.get('content-type') ?? '';
        if (contentType.includes('application/json')) {
          return (await response.json()) as T;
        }

        const text = await response.text();
        try {
          return JSON.parse(text) as T;
        } catch {
          throw new HttpError('Expected JSON response but received different content', response.status, text);
        }
      } catch (error) {
        lastError = error;
        const err = error as Error;
        const isAbortError = err.name === 'AbortError';
        const isRetryableHttpError =
          error instanceof HttpError && (error.status >= 500 || error.status === 429 || error.status === 408);
        const isNetworkError = err.name === 'FetchError' || err.message.includes('fetch failed');

        if (attempt < maxAttempts - 1 && (isAbortError || isRetryableHttpError || isNetworkError)) {
          let waitMs = computeBackoff(pol.retry, attempt);
          // Respect provider rate limits more conservatively on 429
          if (error instanceof HttpError && error.status === 429) {
            waitMs = Math.max(waitMs, 1100);
          }
          // Lightweight retry log with provider attribution for debugging long stalls
          try {
            const u = new URL(url);
            const host = u.host;
            const provider = host.includes('polymarket')
              ? 'Polymarket'
              : host.includes('openrouter')
              ? 'OpenRouter'
              : 'HTTP';
            const status = error instanceof HttpError ? error.status : (isAbortError ? 'timeout' : 'error');
            // eslint-disable-next-line no-console
            console.warn('[retry]', { provider, host, status, attempt: attempt + 1, maxAttempts, waitMs });
          } catch {}
          await delay(waitMs);
          attempt += 1;
          continue;
        }

        if (error instanceof HttpError) {
          try {
            const u = new URL(url);
            const host = u.host;
            const provider = host.includes('polymarket')
              ? 'Polymarket'
              : host.includes('openrouter')
              ? 'OpenRouter'
              : 'HTTP';
            // Suppress noisy logs for expected 404s on Polymarket CLOB endpoints
            const isPolymarketBookOrFee = provider === 'Polymarket' && (u.pathname === '/book' || u.pathname === '/fee-rate');
            const isExpected404 = isPolymarketBookOrFee && error.status === 404;
            if (!isExpected404) {
              // eslint-disable-next-line no-console
              console.warn('[http-error]', { provider, host, status: error.status, url });
            }
          } catch {}
          throw error;
        }

        if (isAbortError) {
          try {
            const u = new URL(url);
            const host = u.host;
            // eslint-disable-next-line no-console
            console.warn('[timeout]', { host, timeout });
          } catch {}
          throw new Error(`Request to ${url} timed out after ${timeout}ms`);
        }

        // Circuit breaker failure accounting
        if (pol.breaker) {
          const st = circuit.get(host) ?? { failures: 0 };
          st.failures += 1;
          if (st.failures >= (pol.breaker.failureThreshold ?? 3)) {
            const openMinutes = pol.breaker.openMinutes ?? 1;
            st.openUntil = Date.now() + openMinutes * 60 * 1000;
            st.failures = 0;
            // eslint-disable-next-line no-console
            console.warn('[circuit-trip]', { host, openMinutes });
          }
          circuit.set(host, st);
        }
        throw err;
      }
      // Success path: reset circuit breaker for host
      if (pol.breaker) {
        const st = circuit.get(host);
        if (st) circuit.set(host, { failures: 0 });
      }
    }

    throw lastError instanceof Error ? lastError : new Error('Unknown HTTP error');
  };
}
