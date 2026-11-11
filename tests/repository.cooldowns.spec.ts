import { describe, expect, it } from 'vitest';

import { openDatabase, initializeSchema, closeDatabase } from '../src/agent/db';
import { AgentRepository } from '../src/agent/repository';

describe('AgentRepository cooldowns', () => {
  it('upserts, lists active, prunes expired, and clears cooldowns', () => {
    const db = openDatabase({ inMemory: true });
    initializeSchema(db);
    const repo = new AgentRepository(db);

    const now = new Date('2024-01-01T00:00:00Z');
    const soon = new Date('2024-01-01T01:00:00Z');
    const past = new Date('2023-12-31T23:00:00Z');

    // Insert two reasons; one already expired
    repo.upsertMarketCooldown({ agentId: 'a', marketId: 'm', reason: 'evaluation:no-trade', expiresAt: soon, updatedAt: now });
    repo.upsertMarketCooldown({ agentId: 'a', marketId: 'm', reason: 'planner:rejected', expiresAt: past, updatedAt: now });

    // Active reasons only returns non-expired and prunes the expired one
    const active1 = repo.getActiveCooldownReasons('a', 'm', now);
    expect(active1).toEqual(['evaluation:no-trade']);

    // After expiry passes, none remain and the table should be empty for that market
    const later = new Date('2024-01-02T00:00:00Z');
    const active2 = repo.getActiveCooldownReasons('a', 'm', later);
    expect(active2).toEqual([]);

    // Re-insert and then clear by reason
    const far = new Date('2024-01-03T00:00:00Z');
    repo.upsertMarketCooldown({ agentId: 'a', marketId: 'm', reason: 'planner:rejected', expiresAt: far, updatedAt: now });
    expect(repo.getActiveCooldownReasons('a', 'm', now)).toEqual(['planner:rejected']);
    repo.clearMarketCooldowns('a', 'm', 'planner:rejected');
    expect(repo.getActiveCooldownReasons('a', 'm', now)).toEqual([]);

    // Insert two reasons and clear all
    repo.upsertMarketCooldown({ agentId: 'a', marketId: 'm', reason: 'evaluation:no-trade', expiresAt: far, updatedAt: now });
    repo.upsertMarketCooldown({ agentId: 'a', marketId: 'm', reason: 'planner:rejected', expiresAt: far, updatedAt: now });
    expect(repo.getActiveCooldownReasons('a', 'm', now).length).toBe(2);
    repo.clearMarketCooldowns('a', 'm');
    expect(repo.getActiveCooldownReasons('a', 'm', now)).toEqual([]);

    closeDatabase(db);
  });
});
