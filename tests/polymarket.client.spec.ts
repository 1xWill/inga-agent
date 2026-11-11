import { describe, expect, it } from 'vitest';

import { createPolymarketClient } from '../src/clients/polymarket';
import { createHttpClient } from '../src/http/client';

const httpClient = createHttpClient({
  retry: {
    retries: 1,
    minDelayMs: 1,
    maxDelayMs: 5,
    factor: 2
  },
  timeoutMs: 12000
});

describe('PolymarketClient', () => {
  it('retrieves trending markets live', async () => {
    const client = createPolymarketClient({
      httpClient,
      marketConfig: {
        sort: 'trending',
        includeOrderBooks: false,
        includeOutcomePrices: true
      }
    });

    const result = await client.listTrendingMarkets({ limit: 3 });
    expect(Array.isArray(result.markets)).toBe(true);
    expect(result.markets.length).toBeLessThanOrEqual(3);
    if (result.markets.length > 0) {
      expect(result.markets.every((m) => m.question.length > 0)).toBe(true);
      expect(result.markets.every((m) => Array.isArray(m.outcomes) && m.outcomes.length > 0)).toBe(true);
      const ids = new Set(result.markets.map((m) => m.id));
      expect(ids.size).toBe(result.markets.length);
    }
  });
});
