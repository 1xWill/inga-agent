import { describe, it, expect } from 'vitest';

import type { MarketSummary } from '../src/clients/polymarket';
import type { RuntimeConfig } from '../src/config/schema';
import { testRuntime } from './helpers/runtime';
import { planTrade } from '../src/agent/pipeline/planner';
import { openDatabase, initializeSchema, closeDatabase } from '../src/agent/db';
import { AgentRepository } from '../src/agent/repository';
import { PortfolioManager } from '../src/agent/portfolio';

function cfg(): RuntimeConfig {
  return testRuntime({
    tradeEvaluation: {
      decisionSchema: { fields: ['x'] },
      targetSelection: { minConfidence: 0.5, maxTargets: 3 },
      gating: { maxSpreadPct: 0.01, minTopBookNotional: 999999, liquidityLevels: 1 }
    }
  });
}

describe('Planner rejection reasons', () => {
  it('persists rejection reason when gates block a plan', () => {
    const db = openDatabase({ inMemory: true });
    initializeSchema(db);
    const repo = new AgentRepository(db);
    const portfolio = new PortfolioManager(repo, { agentId: 'agent', initialBalance: 1000, baseCurrency: 'USDC' });

    const market: MarketSummary = {
      id: 'm1',
      question: 'Q',
      outcomes: [ { id: 'o1', name: 'A', price: 0.5, bestBid: 0.4, bestAsk: 0.6, askLevels: [{ price: 0.6, quantity: 1 }] } ]
    };
    const runtime = cfg();
    const result = planTrade({ evaluationId: 42, agentId: 'agent', market, runtime, portfolio, decision: { outcomeId: 'o1', maxPayPrice: 1.0 } });
    expect(result.instruction).toBeUndefined();
    expect(result.rejectedReason).toBeTruthy();

    const id = repo.recordPlanDecision({ evaluationId: 42, agentId: 'agent', marketId: 'm1', outcomeId: 'o1', status: 'rejected', reason: result.rejectedReason, createdAt: new Date() });
    expect(id).toBeGreaterThan(0);

    closeDatabase(db);
  });
});

