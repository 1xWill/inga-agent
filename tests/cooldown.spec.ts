import { describe, expect, it } from 'vitest';

import { openDatabase, initializeSchema, closeDatabase } from '../src/agent/db';
import { AgentRepository } from '../src/agent/repository';
import { shouldSkipMarket } from '../src/agent/cooldown';

describe('Cooldown logic', () => {
  it('skips markets traded within cooldown window', async () => {
    const db = openDatabase({ inMemory: true });
    initializeSchema(db);
    const repo = new AgentRepository(db);

    // seed a fill 1 hour ago
    const runId = repo.startRun('agent', new Date());
    const evalId = repo.recordMarketEvaluation({
      runId,
      agentId: 'agent',
      marketId: 'm',
      title: 't',
      outcomes: [],
      currentPrices: {},
      quickResearchSummary: '',
      trade: true,
      evaluationRationale: '',
      timestamp: new Date()
    });
    const tradeId = repo.recordTradeInstruction({
      evaluationId: evalId,
      agentId: 'agent',
      marketId: 'm',
      optionId: 'yes',
      direction: 'buy',
      notional: 10,
      reason: 'seed',
      createdAt: new Date()
    });

    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    repo.recordFill({
      tradeInstructionId: tradeId,
      agentId: 'agent',
      marketId: 'm',
      optionId: 'yes',
      direction: 'buy',
      quantity: 10,
      fillPrice: 1,
      notional: 10,
      pnl: 0,
      createdAt: oneHourAgo
    });

    const now = new Date();
    await expect(shouldSkipMarket(repo, 'agent', 'm', 240, {}, now)).resolves.toBe(true);
    await expect(shouldSkipMarket(repo, 'agent', 'm', 0, {}, now)).resolves.toBe(false);
    await expect(shouldSkipMarket(repo, 'agent', 'm', -1, {}, now)).resolves.toBe(false);

    closeDatabase(db);
  });

  it('skips markets with active evaluation/planner cooldowns and respects disable flag', async () => {
    const db = openDatabase({ inMemory: true });
    initializeSchema(db);
    const repo = new AgentRepository(db);

    // Upsert a cooldown that expires in 2 hours
    const expires = new Date(Date.now() + 2 * 3600 * 1000);
    repo.upsertMarketCooldown({ agentId: 'agent', marketId: 'm2', reason: 'planner:rejected', expiresAt: expires });

    await expect(shouldSkipMarket(repo, 'agent', 'm2', 360)).resolves.toBe(true);
    // Disabled evaluation cooldown should ignore suppression
    await expect(shouldSkipMarket(repo, 'agent', 'm2', 360, { skipDecisionCooldown: true })).resolves.toBe(false);

    // Clear and verify no skip
    repo.clearMarketCooldowns('agent', 'm2');
    await expect(shouldSkipMarket(repo, 'agent', 'm2', 360)).resolves.toBe(false);

    closeDatabase(db);
  });
});
