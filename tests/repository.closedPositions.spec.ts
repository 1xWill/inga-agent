import { describe, it, expect } from 'vitest';

import { openDatabase, initializeSchema, closeDatabase } from '../src/agent/db';
import { AgentRepository } from '../src/agent/repository';

describe('Repository closed positions', () => {
  it('persists, updates, lists, and aggregates closed rounds', () => {
    const db = openDatabase({ inMemory: true });
    initializeSchema(db);
    const repo = new AgentRepository(db);

    const agentId = 'agent_live';

    // Insert two closed rounds for the same agent/market/option with distinct closedAt
    repo.recordClosedPositions(agentId, [
      {
        marketId: 'm1',
        optionId: 'o1',
        quantity: 10,
        averagePrice: 0.4,
        exitPrice: 0.5,
        realizedPnl: 1,
        feesPaid: 0.01,
        closedAt: '2025-01-01T00:00:00.000Z',
      },
      {
        marketId: 'm1',
        optionId: 'o1',
        quantity: 5,
        averagePrice: 0.6,
        exitPrice: 0.4,
        realizedPnl: -1,
        feesPaid: 0.02,
        closedAt: '2025-01-02T00:00:00.000Z',
      },
    ]);

    // Idempotent upsert: update the first round's realizedPnl/fees and ensure it overwrites.
    repo.recordClosedPositions(agentId, [
      {
        marketId: 'm1',
        optionId: 'o1',
        quantity: 10,
        averagePrice: 0.4,
        exitPrice: 0.5,
        realizedPnl: 2,
        feesPaid: 0.03,
        closedAt: '2025-01-01T00:00:00.000Z',
      },
    ]);

    const rows = repo.listRecentClosedPositions(10, agentId);
    expect(rows.length).toBe(2);
    // Sorted by closedAt descending
    expect(rows[0].closedAt).toBe('2025-01-02T00:00:00.000Z');
    expect(rows[1].closedAt).toBe('2025-01-01T00:00:00.000Z');

    // Updated realizedPnl/fees for the first round should be visible
    const older = rows[1];
    expect(older.realizedPnl).toBe(2);
    expect(older.feesPaid).toBe(0.03);

    const total = repo.getTotalRealizedPnlFromClosed(agentId);
    // 2 + (-1) = 1
    expect(total).toBeCloseTo(1);

    closeDatabase(db);
  });
});

