import { describe, it, expect } from 'vitest';

import { openDatabase, initializeSchema, closeDatabase } from '../src/agent/db';
import { AgentRepository } from '../src/agent/repository';
import { PortfolioManager } from '../src/agent/portfolio';
import type { RuntimeConfig } from '../src/config/schema';
import { testRuntime } from './helpers/runtime';
import { runMonitorTick } from '../src/agent/pipeline/monitor';

function mkRuntime(): RuntimeConfig {
  return testRuntime({
    tradeEvaluation: {
      gating: { maxSpreadPct: 1, minTopBookNotional: 0, liquidityLevels: 1 },
    },
    execution: {
      defaultSpend: { mode: 'percentage_of_available', value: 0.9 },
      priceRefresh: { enabled: false, maxAgeMinutes: 0.5 },
    },
    exits: {
      minHoldingMinutes: 0,
      priceFloor: 0,
      priceCeiling: 1,
      minExitTopBookNotional: 0,
    },
    risk: { perTradeMax: 10_000, perRunMaxPct: 1, perMarketMaxPct: 0.3 },
    portfolio: { initialBalance: 1000, baseCurrency: 'USDC' },
  });
}

describe('Monitor risk trimming for perMarketMaxPct', () => {
  it('sells down exposure when a market exceeds the configured cap', async () => {
    const db = openDatabase({ inMemory: true });
    initializeSchema(db);
    const repo = new AgentRepository(db);
    const agentId = 'agent';
    const runtime = mkRuntime();

    // Seed a single over-exposed position on market m1
    // Equity = 1000 (cash) + 800 (position) = 1800
    // perMarketMaxPct = 0.3 -> capAbs = 540; exposure = 800 > 540 (over = 260)
    repo.upsertPosition({
      agentId,
      marketId: 'm1',
      // Use a numeric-like token id to exercise the normal orderbook path
      optionId: '123',
      direction: 'buy',
      quantity: 1000,
      averagePrice: 0.8,
      status: 'open',
    });

    const portfolio = new PortfolioManager(repo, {
      agentId,
      initialBalance: 1000,
      baseCurrency: 'USDC',
    });

    const polymarket = {
      // Provide a simple book with ample depth so depth is not the limiting factor
      getOrderBook: async () => ({
        bids: [{ price: 0.75, quantity: 1000 }],
        asks: [{ price: 0.8, quantity: 1000 }],
      }),
    } as any;

    const openrouter = {
      complete: async () => ({ content: '{}' }),
    } as any;

    // Capture pre-trim equity and cap based on the initial snapshot
    const snapshotBefore = portfolio.snapshot();
    const positionsBefore = repo.listOpenPositions(agentId);
    const positionsCostBefore = positionsBefore.reduce(
      (acc, p) => acc + p.averagePrice * p.quantity,
      0,
    );
    const equityBefore =
      snapshotBefore.cashBalance +
      snapshotBefore.reservedBalance +
      positionsCostBefore;
    const capAbsBefore = (runtime.risk!.perMarketMaxPct as number) * equityBefore;

    await runMonitorTick({
      agentId,
      runtime,
      repo,
      portfolio,
      polymarket,
      openrouter,
    });

    const trades = repo.listRecentTradeInstructions(10, agentId);
    expect(trades.length).toBeGreaterThan(0);
    const sell = trades.find((t) => t.direction === 'sell');
    expect(sell).toBeDefined();
    expect(sell?.marketId).toBe('m1');
    expect(sell?.optionId).toBe('123');
    // Expect a risk_trim reason to be recorded
    expect(sell?.reason).toContain('risk_trim');

    // After trimming, market exposure should be at or below the cap (within a small numerical tolerance)
    const positionsAfter = repo.listOpenPositions(agentId);
    const exposureAfter = positionsAfter
      .filter((p) => p.marketId === 'm1')
      .reduce((acc, p) => acc + p.averagePrice * p.quantity, 0);
    const positionsCost = positionsAfter.reduce(
      (acc, p) => acc + p.averagePrice * p.quantity,
      0,
    );
    // Use the pre-trim cap as the reference; after trimming, equity changes slightly due to cash received,
    // so exposure may end up just above capAbsAfter but should be <= capAbsBefore.
    expect(exposureAfter).toBeLessThanOrEqual(capAbsBefore + 1e-6);

    closeDatabase(db);
  });

  it('treats tiny over-cap exposure as dust and skips risk_trim', async () => {
    const db = openDatabase({ inMemory: true });
    initializeSchema(db);
    const repo = new AgentRepository(db);
    const agentId = 'agent_dust';
    const runtime = mkRuntime();

    // Ensure ui.minOpenQuantity is the standard 0.01 shares.
    (runtime as any).ui = {
      ...(runtime as any).ui,
      minOpenQuantity: 0.01,
    };

    // Construct a single position where outcome exposure exceeds the cap,
    // but only by a dust-sized amount (< exitPrice * minOpenQuantity).
    //
    // With initialBalance=1000, perMarketMaxPct=0.3, avgPrice=1:
    //   equity = 1000 + Q
    //   capAbs = 0.3 * (1000 + Q)
    //   exposure = Q
    //   over = exposure - capAbs = 0.7 * Q - 300
    // Choosing Q=428.58 yields over≈0.006, which is < 0.01 notional at price 1.
    const quantity = 428.58;

    repo.upsertPosition({
      agentId,
      marketId: 'm_dust',
      optionId: 'dust-token',
      direction: 'buy',
      quantity,
      averagePrice: 1,
      status: 'open',
    });

    const portfolio = new PortfolioManager(repo, {
      agentId,
      initialBalance: runtime.portfolio.initialBalance,
      baseCurrency: runtime.portfolio.baseCurrency,
    });

    const polymarket = {
      // Simple book: best bid at 1 with ample depth so depth is not limiting.
      getOrderBook: async () => ({
        bids: [{ price: 1, quantity: 1000 }],
        asks: [{ price: 1.01, quantity: 1000 }],
      }),
    } as any;

    const openrouter = {
      complete: async () => ({ content: '{}' }),
    } as any;

    // Sanity-check that we are slightly above the cap but by less than
    // minOpenQuantity * exitPrice, so the over-cap amount is dust-sized.
    const snapshot = portfolio.snapshot();
    const positions = repo.listOpenPositions(agentId);
    const positionsCost = positions.reduce(
      (acc, p) => acc + p.averagePrice * p.quantity,
      0,
    );
    const equity =
      snapshot.cashBalance + snapshot.reservedBalance + positionsCost;
    const capAbs = (runtime.risk!.perMarketMaxPct as number) * equity;
    const exposure = positions
      .filter((p) => p.marketId === 'm_dust')
      .reduce((acc, p) => acc + p.averagePrice * p.quantity, 0);
    const over = exposure - capAbs;
    expect(over).toBeGreaterThan(0);
    expect(over).toBeLessThan(1 * (runtime.ui as any).minOpenQuantity + 1e-6);

    await runMonitorTick({
      agentId,
      runtime,
      repo,
      portfolio,
      polymarket,
      openrouter,
    });

    const trades = repo.listRecentTradeInstructions(10, agentId);
    const riskTrimSell = trades.find(
      (t) => t.direction === 'sell' && t.reason.includes('risk_trim'),
    );
    expect(riskTrimSell).toBeUndefined();

    closeDatabase(db);
  });
});
