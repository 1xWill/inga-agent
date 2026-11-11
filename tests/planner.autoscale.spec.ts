import { describe, it, expect } from 'vitest';

import type { MarketSummary } from '../src/clients/polymarket';
import type { RuntimeConfig } from '../src/config/schema';
import { testRuntime } from './helpers/runtime';
import { planTrade } from '../src/agent/pipeline/planner';
import { AgentRepository } from '../src/agent/repository';
import { initializeSchema, openDatabase, closeDatabase } from '../src/agent/db';
import { PortfolioManager } from '../src/agent/portfolio';

function mkRuntime(): RuntimeConfig {
  return testRuntime({
    tradeEvaluation: { gating: { maxSpreadPct: 0.5, minTopBookNotional: 10, liquidityLevels: 1, requireFullNotionalAtDepth: false } },
    execution: {
      priceRefresh: { enabled: false, maxAgeMinutes: 0.5 },
      slippageModel: { type: 'depth_aware', levels: 1 },
      sizing: { mode: 'auto_scale_to_depth', minNotional: 50, maxDepthLevels: 3 }
    },
    risk: { perTradeMax: 1000, perRunMaxPct: 1, perMarketMaxPct: 1 },
    portfolio: { initialBalance: 200, baseCurrency: 'USDC' }
  });
}

describe('Planner autoscale-to-depth', () => {
  it('accepts scaled notional when available depth < desired but >= minNotional', () => {
    const db = openDatabase({ inMemory: true });
    initializeSchema(db);
    const repo = new AgentRepository(db);
    const portfolio = new PortfolioManager(repo, { agentId: 'agent', initialBalance: 200, baseCurrency: 'USDC' });

    const runtime = mkRuntime();
    // desired notional: 100 (50% of 200)
    // available across 3 levels: 80 -> should scale to 80 and accept
    const market: MarketSummary = {
      id: 'm1',
      question: 'Q',
      outcomes: [{ id: 'o1', name: 'Yes', price: 0.4, bestBid: 0.39, bestAsk: 0.41, askLevels: [
        { price: 0.41, quantity: 50 }, // 20.5
        { price: 0.42, quantity: 100 }, // 42
        { price: 0.43, quantity: 40 } // 17.2
      ] } as any]
    };

    const { instruction, rejectedReason } = planTrade({ evaluationId: 1, agentId: 'agent', market, runtime, portfolio, decision: { outcomeId: 'o1', maxPayPrice: 1.0, spendPct: 0.5 } });
    expect(rejectedReason).toBeUndefined();
    expect(instruction).toBeDefined();
    expect((instruction as any).notional).toBeCloseTo(79.7, 1); // ~80 within rounding
    closeDatabase(db);
  });

  it('rejects when available depth < minNotional', () => {
    const db = openDatabase({ inMemory: true });
    initializeSchema(db);
    const repo = new AgentRepository(db);
    const portfolio = new PortfolioManager(repo, { agentId: 'agent', initialBalance: 200, baseCurrency: 'USDC' });

    const runtime = mkRuntime();
    // available across 3 levels: 40 < minNotional 50 -> reject
    const market: MarketSummary = {
      id: 'm2',
      question: 'Q2',
      outcomes: [{ id: 'o1', name: 'Yes', price: 0.4, bestBid: 0.39, bestAsk: 0.41, askLevels: [
        { price: 0.41, quantity: 50 }, // 20.5
        { price: 0.42, quantity: 0 },
        { price: 0.43, quantity: 45 } // 19.35
      ] } as any]
    };

    const { instruction, rejectedReason } = planTrade({ evaluationId: 2, agentId: 'agent', market, runtime, portfolio, decision: { outcomeId: 'o1', maxPayPrice: 1.0, spendPct: 0.5 } });
    expect(instruction).toBeUndefined();
    expect(rejectedReason).toMatch(/Available notional/);
    closeDatabase(db);
  });
});
