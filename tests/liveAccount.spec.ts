import { describe, expect, it } from 'vitest';
import { deriveOpenLotsFromTrades, fetchConditionalBalancesStrict } from '../src/server/liveAccount';
import type { LiveTrade } from '../src/server/liveAccount';

const mkTrade = (overrides: Partial<LiveTrade>): LiveTrade => ({
  id: overrides.id ?? Math.random().toString(36).slice(2),
  side: overrides.side ?? 'buy',
  price: overrides.price ?? 0.5,
  size: overrides.size ?? 1,
  marketId: overrides.marketId ?? 'm1',
  tokenId: overrides.tokenId ?? 't1',
  matchTime: overrides.matchTime ?? '2025-01-01T00:00:00.000Z',
  takerOrderId: overrides.takerOrderId,
  feeRateBps: overrides.feeRateBps,
  makerOrderId: overrides.makerOrderId,
});

describe('deriveOpenLotsFromTrades', () => {
  it('keeps only the current open entry after a full round closes', () => {
    const trades: LiveTrade[] = [
      mkTrade({ id: '1', size: 50, price: 0.8, matchTime: '2025-01-01T00:00:00.000Z' }),
      mkTrade({ id: '2', side: 'sell', size: 50, price: 0.85, matchTime: '2025-01-01T01:00:00.000Z' }),
      mkTrade({ id: '3', size: 100, price: 0.96, matchTime: '2025-01-01T02:00:00.000Z' }),
    ];
    const lots = deriveOpenLotsFromTrades(trades);
    const entry = lots.get('t1');
    expect(entry).toBeDefined();
    expect(entry?.quantity).toBeCloseTo(100, 6);
    expect(entry?.averagePrice).toBeCloseTo(0.96, 6);
  });

  it('applies FIFO matching for partial exits', () => {
    const trades: LiveTrade[] = [
      mkTrade({ id: 'b1', size: 200, price: 0.8, matchTime: '2025-01-01T00:00:00.000Z' }),
      mkTrade({ id: 'b2', size: 100, price: 0.9, matchTime: '2025-01-01T00:30:00.000Z' }),
      mkTrade({ id: 's1', side: 'sell', size: 150, price: 0.95, matchTime: '2025-01-01T01:00:00.000Z' }),
    ];
    const lots = deriveOpenLotsFromTrades(trades);
    const entry = lots.get('t1');
    expect(entry).toBeDefined();
    expect(entry?.quantity).toBeCloseTo(150, 6);
    const expectedAvg = ((50 * 0.8) + (100 * 0.9)) / 150;
    expect(entry?.averagePrice).toBeCloseTo(expectedAvg, 6);
  });

  it('returns empty when all lots are closed', () => {
    const trades: LiveTrade[] = [
      mkTrade({ id: 'b1', size: 75, price: 0.7 }),
      mkTrade({ id: 's1', side: 'sell', size: 75, price: 0.8, matchTime: '2025-01-01T00:10:00.000Z' }),
    ];
    const lots = deriveOpenLotsFromTrades(trades);
    expect(lots.size).toBe(0);
  });
});

describe('fetchConditionalBalancesStrict', () => {
  it('returns human-unit balances when the CLOB returns numeric strings', async () => {
    const client = {
      getBalanceAllowance: async (params: any) => {
        if (params?.asset_type !== 'CONDITIONAL') throw new Error('unexpected asset_type');
        return { balance: '2000000' }; // 2.0 shares (6 decimals)
      },
    };
    const m = await fetchConditionalBalancesStrict(client as any, { agentId: 'agent_test', tokenIds: ['t1'] });
    expect(m.get('t1')).toBeCloseTo(2, 12);
  });

  it('throws when the CLOB client returns an {error,status} payload', async () => {
    const client = {
      getBalanceAllowance: async (params: any) => {
        if (params?.token_id === 'bad') return { error: 'rate limited', status: 429 };
        return { balance: '1000000' };
      },
    };
    await expect(
      fetchConditionalBalancesStrict(client as any, { agentId: 'agent_test', tokenIds: ['ok', 'bad'] }),
    ).rejects.toThrow(/token_id=bad/);
  });
});
