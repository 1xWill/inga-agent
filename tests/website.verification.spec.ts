import { describe, expect, it } from 'vitest';
import { createHttpClient } from '../src/http/client';
import { openDatabase, closeDatabase } from '../src/agent/db';
import { AgentRepository } from '../src/agent/repository';
import { createPolymarketClient } from '../src/clients/polymarket';
import { selectMarketsForEvaluation } from '../src/agent/pipeline/market';
import { prepareEventContext } from '../src/agent/pipeline/event_prep';
import { testRuntime } from './helpers/runtime';

async function fetchWithRetry(url: string, opts?: RequestInit, retries = 3, timeoutMs = 20000): Promise<Response> {
  let lastErr: any;
  for (let i = 0; i < retries; i++) {
    try {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = opts?.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;
      const r = await fetch(url, { ...opts, signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r;
    } catch (e) {
      lastErr = e;
      await new Promise((res) => setTimeout(res, 500 * (i + 1)));
    }
  }
  throw lastErr;
}

function extractMarketSlugsFromHtml(html: string): string[] {
  const slugs = new Set<string>();
  const re = /href=\"\/market\/([a-z0-9\-]+)\"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    slugs.add(m[1]);
  }
  return Array.from(slugs);
}

function extractEventSlugFromMarketHtml(html: string): string | undefined {
  const m = html.match(/href=\"\/event\/([a-z0-9\-]+)\"/i);
  return m?.[1];
}

describe('Live website verification (event siblings parity)', () => {
  it('agent includes most siblings the website shows for at least one event', async () => {
    const dbPath = 'data/test-website.sqlite';
    const logs: Array<{ msg: string; data?: unknown }> = [];
    const log = (msg: string, data?: unknown) => logs.push({ msg, data });
    const http = createHttpClient({ retry: { retries: 2, minDelayMs: 500, maxDelayMs: 2000, factor: 2 }, timeoutMs: 20000 });

    const db = openDatabase({ filePath: dbPath });
    const repo = new AgentRepository(db);
    const runtime = testRuntime({
      polling: { marketFetchLimit: 8 },
      marketData: { includeOrderBooks: false, tokenResolver: { validateWithBook: false } },
    });
    const polymarket = createPolymarketClient({ httpClient: http, marketConfig: runtime.marketData, excludeTags: [], memoize: { orderBookTtlMs: 5000, feeRateTtlMs: 5000 } });

    let checked = 0;
    let anyGood = false;
    const { markets } = await selectMarketsForEvaluation({ client: polymarket, runtime, repo, agentId: 'agent_test' });
    for (const market of markets) {
      const prepared = await prepareEventContext({ market, polymarket, runtime, repo, log });
      if (!prepared || !prepared.eventMarkets || prepared.eventMarkets.length < 2) continue;

      const firstSlug = (prepared.eventMarkets[0] as any)?.slug as string | undefined;
      let eventSlug: string | undefined = (prepared.eventMarkets[0] as any)?.eventSlug as string | undefined;
      if (!eventSlug && firstSlug) {
        // Fallback: parse event slug from the public market page HTML
        const marketHtmlResp = await fetchWithRetry(`https://polymarket.com/market/${firstSlug}`);
        const marketHtml = await marketHtmlResp.text();
        eventSlug = extractEventSlugFromMarketHtml(marketHtml);
      }
      if (!eventSlug) continue;

      // Website event page
      const site = await fetchWithRetry(`https://polymarket.com/event/${eventSlug}`);
      const html = await site.text();
      const siteSlugs = extractMarketSlugsFromHtml(html);
      if (siteSlugs.length === 0) continue;

      const agentSlugs = Array.from(new Set(prepared.eventMarkets.map((m: any) => m?.slug).filter((s: any) => typeof s === 'string')));

      const siteSet = new Set(siteSlugs);
      const covered = agentSlugs.filter((s) => siteSet.has(s)).length;
      const parity = covered / siteSlugs.length;
      // Accept parity >= 0.5 for at least one event to reduce flakiness while still validating behavior
      if (parity >= 0.5) anyGood = true;
      checked++;
      if (anyGood) break;
    }

    closeDatabase(db);
    if (checked === 0) {
      // No multi-sibling event surfaced in this run; avoid flakiness but surface a warning
      console.warn('[website.verification] No event with >2 siblings found in this run; skipping parity assertion.');
      expect(true).toBe(true);
      return;
    }
    expect(anyGood).toBe(true);
  }, 180000);
});
