import { describe, expect, it } from 'vitest';
import { createHttpClient } from '../src/http/client';
import { createPolymarketClient } from '../src/clients/polymarket';

async function fetchWithRetry(url: string, opts?: RequestInit, retries = 3): Promise<Response> {
  let lastErr: any;
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url, opts);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r;
    } catch (e) {
      lastErr = e;
      await new Promise((res) => setTimeout(res, 500 * (i + 1)));
    }
  }
  throw lastErr;
}

describe('Event siblings via Gamma vs client (generic, non-hardcoded)', () => {
  it('finds siblings for a random event with >=2 markets', async () => {
    const http = createHttpClient({ retry: { retries: 2, minDelayMs: 500, maxDelayMs: 2000, factor: 2 }, timeoutMs: 20000 });
    const client = createPolymarketClient({ httpClient: http });

    // Gamma wide scan: group by event slug and pick one with at least 2 entries
    const scan = await fetchWithRetry('https://gamma-api.polymarket.com/markets?limit=1000&sort=updatedAt&closed=false&active=true&archived=false');
    const all = (await scan.json()) as any[];
    const counts = new Map<string, number>();
    for (const m of all) {
      const slug = m?.events?.[0]?.slug as string | undefined;
      if (slug) counts.set(slug, (counts.get(slug) ?? 0) + 1);
    }
    const candidate = Array.from(counts.entries()).find(([_, c]) => c >= 2);
    if (!candidate) {
      // No qualifying event; skip to avoid flakiness
      expect(true).toBe(true);
      return;
    }
    const [eventSlug, gammaCount] = candidate;

    const siblings = await client.listEventMarketsBySlug(eventSlug);
    expect(siblings.length).toBeGreaterThanOrEqual(2);
    // Client should retrieve a reasonable portion of Gamma siblings
    const parity = siblings.length / gammaCount;
    expect(parity).toBeGreaterThan(0.5);
    // Ensure outcome ids (token ids) are present for on-chain trading
    const anyWithTokenIds = siblings.some((s) => Array.isArray(s.outcomes) && s.outcomes.length >= 2 && typeof s.outcomes[0].id === 'string');
    expect(anyWithTokenIds).toBe(true);
  }, 60000);
});
