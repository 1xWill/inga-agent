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
    tradeEvaluation: { gating: { maxSpreadPct: 0.9, minTopBookNotional: 0, liquidityLevels: 1 } },
    execution: { priceRefresh: { enabled: false, maxAgeMinutes: 0.5 } },
    // Use a large perTradeMax so exposure caps (perRun/perMarket) are the binding limits in these tests.
    risk: { perTradeMax: 10_000, perRunMaxPct: 0.5, perMarketMaxPct: 0.3 },
    portfolio: { initialBalance: 1000, baseCurrency: 'USDC' }
  });
}

describe('Planner exposure caps', () => {
  it('respects perRunMaxPct', () => {
    const db = openDatabase({ inMemory: true });
    initializeSchema(db);
    const repo = new AgentRepository(db);
    const portfolio = new PortfolioManager(repo, { agentId: 'agent', initialBalance: 1000, baseCurrency: 'USDC' });

    // Create an existing position to consume exposure
    repo.upsertPosition({ agentId: 'agent', marketId: 'mX', optionId: 'o', direction: 'buy', quantity: 1, averagePrice: 400, status: 'open' });

    const runtime = mkRuntime();
    // Deep book so depth is not the limiting factor; risk cap should clamp.
    const market: MarketSummary = {
      id: 'm1',
      question: 'Q',
      outcomes: [
        {
          id: 'o1',
          name: 'A',
          price: 0.5,
          bestBid: 0.49,
          bestAsk: 0.51,
          askLevels: [{ price: 0.51, quantity: 10_000 }],
        },
      ],
    };
    const { instruction, rejectedReason } = planTrade({
      evaluationId: 1,
      agentId: 'agent',
      market,
      runtime,
      portfolio,
      decision: { outcomeId: 'o1', maxPayPrice: 1.0, spendPct: 0.9 },
    });
    // Existing exposure cost = 400; equity = 1000 + 400 = 1400.
    // perRunMaxPct = 0.5 → capAbs = 700 → headroom = 300.
    // Default spend wants 900; planner should clamp to 300 (not reject).
    expect(rejectedReason).toBeUndefined();
    expect(instruction).toBeDefined();
    expect(instruction?.notional).toBeCloseTo(300, 5);
    closeDatabase(db);
  });

  it('respects perMarketMaxPct as a per-outcome cap', () => {
    const db = openDatabase({ inMemory: true });
    initializeSchema(db);
    const repo = new AgentRepository(db);
    const portfolio = new PortfolioManager(repo, { agentId: 'agent', initialBalance: 1000, baseCurrency: 'USDC' });

    // Existing exposure on outcome o1 in market m1
    repo.upsertPosition({ agentId: 'agent', marketId: 'm1', optionId: 'o1', direction: 'buy', quantity: 1, averagePrice: 250, status: 'open' });

    const runtime = mkRuntime();
    // Deep book so depth is not the limiting factor; per-market cap should clamp.
    const market: MarketSummary = {
      id: 'm1',
      question: 'Q',
      outcomes: [
        {
          id: 'o1',
          name: 'A',
          price: 0.5,
          bestBid: 0.49,
          bestAsk: 0.51,
          askLevels: [{ price: 0.51, quantity: 10_000 }],
        },
      ],
    };
    const { instruction, rejectedReason } = planTrade({
      evaluationId: 1,
      agentId: 'agent',
      market,
      runtime,
      portfolio,
      decision: { outcomeId: 'o1', maxPayPrice: 1.0, spendPct: 0.9 },
    });
    // Existing exposure on outcome o1 (m1) = 250; equity = 1000 + 250 = 1250.
    // perRunMaxPct = 0.5  → capAbs_run = 625 → run headroom = 375.
    // perMarketMaxPct = 0.3 → capAbs_outcome = 375 → outcome headroom = 125.
    // Default spend wants 900; planner should clamp to 125 (not reject).
    expect(rejectedReason).toBeUndefined();
    expect(instruction).toBeDefined();
    expect(instruction?.notional).toBeCloseTo(125, 5);
    closeDatabase(db);
  });
});
