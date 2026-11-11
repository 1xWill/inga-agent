import { describe, expect, it, beforeEach, vi, type Mock } from 'vitest';
import { buildPortfoliosPayload } from '../app/api/_lib/dashboardPayloads';
import type { AgentRepositoryAsync } from '../src/storage/types';
import type { RuntimeConfig, AgentsConfig } from '../src/config/schema';
import { getLiveSnapshot } from '../app/api/_lib/liveSnapshots';

vi.mock('../app/api/_lib/liveSnapshots', () => ({
  getLiveSnapshot: vi.fn(),
}));

vi.mock('../app/api/_lib/marksRefresher', () => ({
  ensureMarksRefresher: vi.fn(),
  refreshMarksNow: vi.fn(),
}));

const mockedLiveSnapshot = getLiveSnapshot as unknown as Mock;

describe('buildPortfoliosPayload (live agents)', () => {
  beforeEach(() => {
    mockedLiveSnapshot.mockReset();
  });

  it('uses cumulative realized PnL and recomputes unrealized from open positions', async () => {
    const realizedTotal = 123.45;
    mockedLiveSnapshot.mockResolvedValue({
      agentId: 'agent_live',
      updatedAt: new Date().toISOString(),
      cashBalance: 700,
      realizedPnl: 5,
      unrealizedPnl: 10,
      equity: 900,
      positionsOpen: [
        {
          marketId: 'm1',
          optionId: 'o1',
          quantity: 10,
          averagePrice: 0.5,
          bestBid: 0.48,
          bestAsk: 0.5,
        },
      ],
      positionsClosed: [],
    });
    const repo = {
      buildPortfolioSnapshot: async () => ({
        agentId: 'agent_live',
        cashBalance: 1000,
        reservedBalance: 0,
        realizedPnl: 0,
        baseCurrency: 'USDC',
        positions: [],
        unrealizedPnl: 0,
      }),
      getPositionMarks: async () => new Map(),
      listRecentMarketEvaluations: async () => [],
      listRecentTradeInstructions: async () => [],
      getTotalRealizedPnlFromClosed: async () => realizedTotal,
      getEarliestPortfolioHistory: async () => ({ ts: 0, equity: 980, realizedPnl: 0, unrealizedPnl: 0 }),
    } as unknown as AgentRepositoryAsync;
    const runtime = {
      portfolio: { baseCurrency: 'USDC', initialBalance: 1000 },
      marksRefresher: { maxStalenessMinutes: 1 },
      ui: { minOpenQuantity: 0.01, filterSmallPositions: false },
    } as unknown as RuntimeConfig;
    const agentsCfg = {
      agents: [{ id: 'agent_live', enabled: true, paperTrading: false }],
    } as AgentsConfig;
    const result = await buildPortfoliosPayload({
      repo,
      runtime,
      agentsCfg,
      debugFlag: false,
    });
    expect(result).toHaveLength(1);
    const portfolio = result[0].portfolio;
    expect(portfolio.realizedPnl).toBeCloseTo(realizedTotal, 6);
    expect(portfolio.unrealizedPnl).toBeCloseTo((0.48 - 0.5) * 10, 6);
    expect(portfolio.positions).toHaveLength(1);
    expect(portfolio.positions[0].optionId).toBe('o1');
    expect(portfolio.baselineEquity).toBeCloseTo(980, 6);
  });
});
