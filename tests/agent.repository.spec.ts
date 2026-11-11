import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database as SqliteDatabase } from 'better-sqlite3';

import { initializeSchema, openDatabase, closeDatabase } from '../src/agent/db';
import { AgentRepository } from '../src/agent/repository';

describe('AgentRepository', () => {
  let db: SqliteDatabase;
  let repo: AgentRepository;

  beforeEach(() => {
    db = openDatabase({ inMemory: true });
    initializeSchema(db);
    repo = new AgentRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('starts and completes a run', () => {
    const runId = repo.startRun('agent_openai', new Date('2024-01-01T00:00:00Z'));
    repo.completeRun(runId, 'completed', new Date('2024-01-01T01:00:00Z'));

    const row = db
      .prepare('SELECT status, completed_at FROM agent_runs WHERE id = ?')
      .get(runId) as { status: string; completed_at: string };

    expect(row.status).toBe('completed');
    expect(new Date(row.completed_at).toISOString()).toBe('2024-01-01T01:00:00.000Z');
  });

  it('records market evaluations, trades, and fills', () => {
    const runId = repo.startRun('agent_openai', new Date());

    const evaluationId = repo.recordMarketEvaluation({
      runId,
      agentId: 'agent_openai',
      marketId: 'market-1',
      title: 'Will it rain?',
      outcomes: [
        { id: 'yes', name: 'Yes', price: 0.55 },
        { id: 'no', name: 'No', price: 0.45 }
      ],
      currentPrices: { yes: 0.55, no: 0.45 },
      quickResearchSummary: 'Weather reports suggest rain.',
      trade: true,
      evaluationRationale: 'Confidence 0.7 due to strong evidence',
      timestamp: new Date('2024-01-01T02:00:00Z')
    });

    const tradeInstructionId = repo.recordTradeInstruction({
      evaluationId,
      agentId: 'agent_openai',
      marketId: 'market-1',
      optionId: 'yes',
      direction: 'buy',
      notional: 200,
      allocationPct: 0.2,
      expectedPrice: 0.55,
      stopPrice: 0.35,
      takeProfitPrice: 0.75,
      reason: 'High conviction',
      createdAt: new Date('2024-01-01T02:05:00Z')
    });

    repo.recordPlanDecision({
      evaluationId,
      agentId: 'agent_openai',
      marketId: 'market-1',
      status: 'accepted',
      reason: 'Checks passed',
      createdAt: new Date('2024-01-01T02:04:00Z')
    });

    const fillId = repo.recordFill({
      tradeInstructionId,
      agentId: 'agent_openai',
      marketId: 'market-1',
      optionId: 'yes',
      direction: 'buy',
      quantity: 400,
      fillPrice: 0.5,
      notional: 200,
      pnl: 0,
      createdAt: new Date('2024-01-01T02:06:00Z')
    });

    const exitInstructionId = repo.recordTradeInstruction({
      evaluationId,
      agentId: 'agent_openai',
      marketId: 'market-1',
      optionId: 'yes',
      direction: 'sell',
      notional: 180,
      expectedPrice: 0.7,
      reason: 'Take profit at target',
      createdAt: new Date('2024-01-01T03:00:00Z')
    });

    const evaluationRow = db
      .prepare('SELECT market_id, quick_summary, trade_flag FROM market_evaluations WHERE id = ?')
      .get(evaluationId) as { market_id: string; quick_summary: string; trade_flag: number };

    expect(evaluationRow.market_id).toBe('market-1');
    expect(evaluationRow.quick_summary).toContain('Weather reports');
    expect(evaluationRow.trade_flag).toBe(1);

    const tradeRow = db
      .prepare('SELECT direction, notional, expected_price FROM trade_instructions WHERE id = ?')
      .get(tradeInstructionId) as { direction: string; notional: number; expected_price: number };

    expect(tradeRow.direction).toBe('buy');
    expect(tradeRow.notional).toBeCloseTo(200);
    expect(tradeRow.expected_price).toBeCloseTo(0.55);

    const fillRow = db
      .prepare('SELECT notional, pnl FROM fills WHERE id = ?')
      .get(fillId) as { notional: number; pnl: number };

    expect(fillRow.notional).toBeCloseTo(200);
    expect(fillRow.pnl).toBe(0);

    const recentEvaluations = repo.listRecentMarketEvaluations(5);
    expect(recentEvaluations[0]?.id).toBe(evaluationId);

    const recentPlans = repo.listRecentPlanDecisions(5);
    expect(recentPlans[0]?.evaluationId).toBe(evaluationId);

    const recentTrades = repo.listRecentTradeInstructions(5);
    expect(recentTrades.map((t) => t.id)).toEqual([exitInstructionId, tradeInstructionId]);

    const recentFills = repo.listRecentFills(5);
    expect(recentFills[0]?.id).toBe(fillId);

    const exits = repo.listRecentExits(5);
    expect(exits[0]?.id).toBe(exitInstructionId);
  });
});
