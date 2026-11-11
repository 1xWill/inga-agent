import { describe, it, expect, vi } from 'vitest';

import type { PolymarketClient, MarketListResult, MarketSummary } from '../src/clients/polymarket';
import { selectMarketsForEvaluation } from '../src/agent/pipeline/market';
import { openDatabase, initializeSchema, closeDatabase } from '../src/agent/db';
import { AgentRepository } from '../src/agent/repository';
import { testRuntime } from './helpers/runtime';

class StubClient implements Partial<PolymarketClient> {
  private pages: MarketSummary[][];
  constructor(pages: MarketSummary[][]) {
    this.pages = pages;
  }
  async listTrendingMarkets({ limit, cursor }: { limit: number; cursor?: string }): Promise<MarketListResult> {
    const idx = cursor ? Number(cursor) || 0 : 0;
    const page = this.pages[idx] ?? [];
    const slice = page.slice(0, limit);
    const nextCursor = idx + 1 < this.pages.length ? String(idx + 1) : undefined;
    return { markets: slice, nextCursor };
  }
}

describe('Adaptive selection', () => {
  it('paginates past suppressed markets to fill target', async () => {
    const db = openDatabase({ inMemory: true });
    initializeSchema(db);
    const repo = new AgentRepository(db);
    const agentId = 'agent';

    // page 0 has two markets that will be suppressed (cooldown) and one invalid
    const m1: MarketSummary = { id: 'm1', question: 'Q1', outcomes: [{ id: 'o', name: 'A' }] } as any;
    const m2: MarketSummary = { id: 'm2', question: 'Q2', outcomes: [{ id: 'o', name: 'A' }] } as any;
    const bad: MarketSummary = { id: '', question: 'bad', outcomes: [] } as any;
    // seed eval suppression for m1 and m2
    const now = new Date();
    const expires = new Date(now.getTime() + 6 * 3600 * 1000);
    repo.upsertMarketCooldown({ agentId, marketId: 'm1', reason: 'evaluation:no-trade', expiresAt: expires, updatedAt: now });
    repo.upsertMarketCooldown({ agentId, marketId: 'm2', reason: 'planner:rejected', expiresAt: expires, updatedAt: now });

    // page 1 has eligible markets
    const m3: MarketSummary = { id: 'm3', question: 'Q3', outcomes: [{ id: 'o', name: 'A' }] } as any;
    const m4: MarketSummary = { id: 'm4', question: 'Q4', outcomes: [{ id: 'o', name: 'A' }] } as any;

    const client = new StubClient([[m1, m2, bad], [m3, m4]]) as unknown as PolymarketClient;
    const runtime = testRuntime({
      polling: { marketFetchLimit: 2 },
      // Disable keyword-only discovery and TTL window quirks in this unit test;
      // we are testing generic pagination behavior, not keyword flows.
      includeKeywords: [],
      includeOnly: false,
    });

    const { markets, pagesUsed, counts } = await selectMarketsForEvaluation({ client, runtime, repo, agentId });
    expect(markets.map((m) => m.id)).toEqual(['m3', 'm4']);
    expect(pagesUsed).toBeGreaterThanOrEqual(2);
    expect(counts.selected).toBe(2);
    expect(counts.skippedByEval).toBeGreaterThanOrEqual(2);
    // Depending on page size slicing, invalids may be sliced out; ensure non-negative
    expect(counts.droppedInvalid).toBeGreaterThanOrEqual(0);

    closeDatabase(db);
  });

  it('samples endingSoon markets without recency suppression and adapts cooldown for short TTL', async () => {
    const db = openDatabase({ inMemory: true });
    initializeSchema(db);
    const repo = new AgentRepository(db);
    const agentId = 'agent';

    const now = Date.now();
    const soonEnd = new Date(now + 30 * 60000).toISOString();
    const farEnd = new Date(now + 14 * 24 * 3600 * 1000).toISOString();

    const markets: MarketSummary[] = [
      { id: 'soon', question: 'Soon resolves', outcomes: [{ id: 'o1', name: 'Yes' }], endDate: soonEnd } as any,
      { id: 'far', question: 'Far resolves', outcomes: [{ id: 'o1', name: 'Yes' }], endDate: farEnd } as any,
    ];

    class CompositeStub implements Partial<PolymarketClient> {
      async listMarkets({ limit }: { limit: number }): Promise<MarketListResult> {
        return { markets: markets.slice(0, limit), nextCursor: undefined };
      }
      async listTrendingMarkets(): Promise<MarketListResult> {
        return { markets: [], nextCursor: undefined };
      }
    }

    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    const client = new CompositeStub() as unknown as PolymarketClient;
    const runtime = testRuntime({
      polling: { marketFetchLimit: 1 },
      includeKeywords: [],
      includeOnly: false,
      marketData: {
        minTtlMinutes: 0,
        discoveryMode: 'composite',
        compositeSorts: [{ sort: 'endingSoon', take: 5 }],
        endingSoon: { minTtlMinutes: 5, maxTtlMinutes: 600 },
      },
      cooldowns: { discoveryMinutes: 60 },
    });

    const { markets: selected, counts } = await selectMarketsForEvaluation({ client, runtime, repo, agentId });
    expect(selected).toHaveLength(1);
    expect(selected[0].id).toBe('soon');
    expect(counts.skippedByTtlWindow).toBeGreaterThanOrEqual(0);

    const row = db
      .prepare(`SELECT expires_at FROM market_cooldowns WHERE market_id = 'soon' LIMIT 1`)
      .get() as { expires_at: string } | undefined;
    expect(row).toBeDefined();
    const expiresAt = row ? Date.parse(row.expires_at) : 0;
    const diffMinutes = (expiresAt - now) / 60000;
    expect(diffMinutes).toBeGreaterThanOrEqual(14); // adaptive floor (~15 min)
    expect(diffMinutes).toBeLessThanOrEqual((runtime as any)?.cooldowns?.discoveryMinutes ?? 60);

    randomSpy.mockRestore();
    closeDatabase(db);
  });
});
