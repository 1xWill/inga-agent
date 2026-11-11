import { describe, it, expect } from 'vitest';

import type { MarketSummary } from '../src/clients/polymarket';
import type { RuntimeConfig } from '../src/config/schema';
import { testRuntime } from './helpers/runtime';
import { planTrade } from '../src/agent/pipeline/planner';
import { AgentRepository } from '../src/agent/repository';
import { initializeSchema, openDatabase, closeDatabase } from '../src/agent/db';
import { PortfolioManager } from '../src/agent/portfolio';

function baseRuntime(): RuntimeConfig {
  return testRuntime({
    tradeEvaluation: { gating: { maxSpreadPct: 0.1, minTopBookNotional: 50, liquidityLevels: 2 } },
    execution: { defaultSpend: { mode: 'percentage_of_available', value: 0.5 }, priceRefresh: { enabled: false, maxAgeMinutes: 0.5 }, slippageModel: { type: 'depth_aware', levels: 2 } },
    risk: { perTradeMax: 1000 },
    portfolio: { initialBalance: 200, baseCurrency: 'USDC' }
  });
}

describe('Planner gating', () => {
  it('rejects when spread exceeds maxSpreadPct', () => {
    const db = openDatabase({ inMemory: true });
    initializeSchema(db);
    const repo = new AgentRepository(db);
    const portfolio = new PortfolioManager(repo, { agentId: 'agent', initialBalance: 200, baseCurrency: 'USDC' });

    const runtime = baseRuntime();
    const market: MarketSummary = {
      id: 'm1',
      question: 'Test',
      outcomes: [
        { id: 'o1', name: 'A', price: 0.5, bestBid: 0.4, bestAsk: 0.6, askLevels: [{ price: 0.6, quantity: 100 }] },
        { id: 'o2', name: 'B', price: 0.5 }
      ]
    };

    const { instruction } = planTrade({ evaluationId: 1, agentId: 'agent', market, runtime, portfolio, decision: { outcomeId: 'o1', maxPayPrice: 1.0 } });
    expect(instruction).toBeUndefined();
    closeDatabase(db);
  });

  it('rejects when top-of-book liquidity is insufficient for desired notional', () => {
    const db = openDatabase({ inMemory: true });
    initializeSchema(db);
    const repo = new AgentRepository(db);
    const portfolio = new PortfolioManager(repo, { agentId: 'agent', initialBalance: 200, baseCurrency: 'USDC' });

    const runtime = baseRuntime();
    // max spread acceptable here
    runtime.tradeEvaluation.gating!.maxSpreadPct = 0.5;
    // 50% of 200 = 100 notional needed; provide only 30 notional in first 2 levels
    const market: MarketSummary = {
      id: 'm2',
      question: 'Test 2',
      outcomes: [
        {
          id: 'o1',
          name: 'A',
          price: 0.3,
          bestBid: 0.29,
          bestAsk: 0.31,
          askLevels: [
            { price: 0.31, quantity: 50 }, // notional ~ 15.5
            { price: 0.32, quantity: 45 } // notional ~ 14.4
          ]
        }
      ]
    };

    const { instruction } = planTrade({ evaluationId: 2, agentId: 'agent', market, runtime, portfolio, decision: { outcomeId: 'o1', maxPayPrice: 1.0 } });
    expect(instruction).toBeUndefined();
    closeDatabase(db);
  });
});
