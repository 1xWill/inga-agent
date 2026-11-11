import { describe, it, expect } from 'vitest';

import { initializeSchema, openDatabase, closeDatabase } from '../src/agent/db';
import { AgentRepository } from '../src/agent/repository';
import { PortfolioManager } from '../src/agent/portfolio';
import type { RuntimeConfig } from '../src/config/schema';
import { testRuntime } from './helpers/runtime';
import { manageExits } from '../src/agent/pipeline/exits';

// Minimal Polymarket client stub
class StubPoly {
  constructor(private readonly bid: number) {}
  async getOrderBook() {
    return { bids: [{ price: this.bid, size: '100' }], asks: [{ price: this.bid + 0.01, size: '100' }] } as any;
  }
}

function runtimeWithExits(): RuntimeConfig {
  return testRuntime({
    exits: {
      minHoldingMinutes: 0,
      minExitTopBookNotional: 0,
      consecutiveTriggers: 1,
      takeProfitPct: 0.2,
      stopLossPct: 0.1
    }
  });
}

describe('Exit manager', () => {
  it('sells on take profit', async () => {
    const db = openDatabase({ inMemory: true });
    initializeSchema(db);
    const repo = new AgentRepository(db);
    const portfolio = new PortfolioManager(repo, { agentId: 'agent', initialBalance: 1000, baseCurrency: 'USDC' });

    // Open a position at price 0.5 for 100 units
    repo.upsertPosition({ agentId: 'agent', marketId: 'm1', optionId: 't1', direction: 'buy', quantity: 100, averagePrice: 0.5, status: 'open' });

    const runtime = runtimeWithExits();
    const stub = new StubPoly(0.62) as any; // > 20% above 0.5

    await manageExits({ agentId: 'agent', runtime, repo, portfolio, polymarket: stub, log: (m, d) => console.log('[test]', m, d ?? '') });
    const open = repo.listOpenPositions('agent');
    expect(open.length).toBe(0);

    closeDatabase(db);
  });

  it('sells on stop loss', async () => {
    const db = openDatabase({ inMemory: true });
    initializeSchema(db);
    const repo = new AgentRepository(db);
    const portfolio = new PortfolioManager(repo, { agentId: 'agent', initialBalance: 1000, baseCurrency: 'USDC' });

    // Open a position at price 0.5 for 100 units
    repo.upsertPosition({ agentId: 'agent', marketId: 'm1', optionId: 't1', direction: 'buy', quantity: 100, averagePrice: 0.5, status: 'open' });

    const runtime = runtimeWithExits();
    const stub = new StubPoly(0.44) as any; // >=10% below 0.5 triggers stop

    await manageExits({ agentId: 'agent', runtime, repo, portfolio, polymarket: stub, log: (m, d) => console.log('[test]', m, d ?? '') });
    const open = repo.listOpenPositions('agent');
    expect(open.length).toBe(0);

    closeDatabase(db);
  });
});
