import { describe, expect, it } from 'vitest';

import type { MarketSummary } from '../src/clients/polymarket';
import type { RuntimeConfig } from '../src/config/schema';
import { testRuntime } from './helpers/runtime';
import { planTrade } from '../src/agent/pipeline/planner';
import { AgentRepository } from '../src/agent/repository';
import { initializeSchema, openDatabase, closeDatabase } from '../src/agent/db';
import { PortfolioManager } from '../src/agent/portfolio';

const runtime: RuntimeConfig = testRuntime({
  execution: {
    priceRefresh: { enabled: true, maxAgeMinutes: 0.5 }
  },
  // remove base risk caps for predictable sizing in tests
  risk: undefined as any
});

describe('Trade planner', () => {
  it('sizes from spendPct and reserves funds', () => {
    const db = openDatabase({ inMemory: true });
    initializeSchema(db);
    const repo = new AgentRepository(db);
    const portfolio = new PortfolioManager(repo, { agentId: 'agent_openai', initialBalance: 1000, baseCurrency: 'USDC' });

    const market: MarketSummary = {
      id: 'm2',
      question: 'Sample',
      outcomes: [
        { id: 'yes', name: 'Yes', price: 0.6, bestBid: 0.59, bestAsk: 0.61, bidLevels: [{ price: 0.59, quantity: 1000 }], askLevels: [{ price: 0.61, quantity: 1000 }] } as any,
        { id: 'no', name: 'No', price: 0.4, bestBid: 0.39, bestAsk: 0.41, bidLevels: [{ price: 0.39, quantity: 1000 }], askLevels: [{ price: 0.41, quantity: 1000 }] } as any
      ]
    };

    const { instruction, reservedAmount } = planTrade({
      evaluationId: 1,
      agentId: 'agent_openai',
      market,
      runtime,
      portfolio,
      decision: { outcomeId: 'no', maxPayPrice: 1.0, spendPct: 0.2 }
    });

    expect(instruction?.notional).toBeCloseTo(200); // 20% of 1000
    expect(reservedAmount).toBeCloseTo(200);
    expect(instruction?.optionId).toBe('no'); // lowest price outcome

    closeDatabase(db);
  });

  it('clamps spendPct sizing to available', () => {
    const db = openDatabase({ inMemory: true });
    initializeSchema(db);
    const repo = new AgentRepository(db);
    const portfolio = new PortfolioManager(repo, { agentId: 'agent_openai', initialBalance: 50, baseCurrency: 'USDC' });

    const market: MarketSummary = {
      id: 'm3',
      question: 'Sample',
      outcomes: [
        { id: 'a', name: 'A', price: 0.5, bestBid: 0.49, bestAsk: 0.51, bidLevels: [{ price: 0.49, quantity: 1000 }], askLevels: [{ price: 0.51, quantity: 1000 }] } as any
      ]
    };

    const { instruction, reservedAmount, rejectedReason } = planTrade({ evaluationId: 1, agentId: 'agent_openai', market, runtime, portfolio, decision: { outcomeId: 'a', maxPayPrice: 1.0, spendPct: 2.0 } });

    if (!instruction) {
      // eslint-disable-next-line no-console
      console.log('planner rejection (debug):', rejectedReason);
    }

    expect(instruction?.notional).toBeCloseTo(50); // clamped to available
    expect(reservedAmount).toBeCloseTo(50);
    closeDatabase(db);
  });
});
