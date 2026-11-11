import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initializeSchema, openDatabase, closeDatabase } from '../src/agent/db';
import { AgentRepository } from '../src/agent/repository';
import { PortfolioManager } from '../src/agent/portfolio';

import type { Database as SqliteDatabase } from 'better-sqlite3';

describe('PortfolioManager', () => {
  let db: SqliteDatabase;
  let repo: AgentRepository;
  let portfolio: PortfolioManager;
  let runId: number;

  beforeEach(() => {
    db = openDatabase({ inMemory: true });
    initializeSchema(db);
    repo = new AgentRepository(db);
    runId = repo.startRun('agent_openai', new Date());
    portfolio = new PortfolioManager(repo, {
      agentId: 'agent_openai',
      initialBalance: 1000,
      baseCurrency: 'USDC'
    });
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('reserves and releases funds', () => {
    const reservation = portfolio.reserve(200);
    expect(portfolio.availableBalance).toBeCloseTo(800);

    portfolio.release(reservation.id);
    expect(portfolio.availableBalance).toBeCloseTo(1000);
  });

  it('executes buy trades and records positions', () => {
    const reservation = portfolio.reserve(150);
    const evaluationId = createEvaluation('market-1');
    const tradeInstructionId = repo.recordTradeInstruction({
      evaluationId,
      agentId: 'agent_openai',
      marketId: 'market-1',
      optionId: 'yes',
      direction: 'buy',
      notional: 150,
      allocationPct: 0.15,
      expectedPrice: 0.5,
      reason: 'test',
      createdAt: new Date()
    });

    const fill = portfolio.executeTrade({
      tradeInstructionId,
      marketId: 'market-1',
      optionId: 'yes',
      direction: 'buy',
      price: 0.5,
      notional: 150,
      reservationId: reservation.id
    });

    expect(fill.quantity).toBeCloseTo(300);

    const snapshot = portfolio.snapshot();
    expect(snapshot.cashBalance).toBeCloseTo(850);
    expect(snapshot.reservedBalance).toBe(0);
    expect(snapshot.positions).toHaveLength(1);
    expect(snapshot.positions[0].quantity).toBeCloseTo(300);
    expect(snapshot.positions[0].averagePrice).toBeCloseTo(0.5);
  });

  it('executes sell trades and updates realized pnl', () => {
    const buyReservation = portfolio.reserve(240);
    const evaluationId = createEvaluation('market-2');
    const buyInstructionId = repo.recordTradeInstruction({
      evaluationId,
      agentId: 'agent_openai',
      marketId: 'market-2',
      optionId: 'yes',
      direction: 'buy',
      notional: 240,
      allocationPct: 0.24,
      expectedPrice: 0.4,
      reason: 'initial buy',
      createdAt: new Date()
    });
    portfolio.executeTrade({
      tradeInstructionId: buyInstructionId,
      marketId: 'market-2',
      optionId: 'yes',
      direction: 'buy',
      price: 0.4,
      notional: 240,
      reservationId: buyReservation.id
    });

    const sellInstructionId = repo.recordTradeInstruction({
      evaluationId,
      agentId: 'agent_openai',
      marketId: 'market-2',
      optionId: 'yes',
      direction: 'sell',
      notional: 120,
      allocationPct: 0.12,
      expectedPrice: 0.6,
      reason: 'trim position',
      createdAt: new Date()
    });
    const fill = portfolio.executeTrade({
      tradeInstructionId: sellInstructionId,
      marketId: 'market-2',
      optionId: 'yes',
      direction: 'sell',
      price: 0.6,
      notional: 120
    });

    expect(fill.quantity).toBeCloseTo(200);
    expect(fill.pnl).toBeCloseTo(40);

    const snapshot = portfolio.snapshot();
    expect(snapshot.cashBalance).toBeCloseTo(880);
    expect(snapshot.realizedPnl).toBeCloseTo(40);
    expect(snapshot.positions[0].quantity).toBeCloseTo(400); // 600 total bought - 200 sold
  });

  it('prevents overselling positions', () => {
    const reservation = portfolio.reserve(100);
    const evaluationId = createEvaluation('market-3');
    const instructionId = repo.recordTradeInstruction({
      evaluationId,
      agentId: 'agent_openai',
      marketId: 'market-3',
      optionId: 'yes',
      direction: 'buy',
      notional: 100,
      allocationPct: 0.1,
      expectedPrice: 0.5,
      reason: 'enter position',
      createdAt: new Date()
    });
    portfolio.executeTrade({
      tradeInstructionId: instructionId,
      marketId: 'market-3',
      optionId: 'yes',
      direction: 'buy',
      price: 0.5,
      notional: 100,
      reservationId: reservation.id
    });

    const sellInstructionId = repo.recordTradeInstruction({
      evaluationId,
      agentId: 'agent_openai',
      marketId: 'market-3',
      optionId: 'yes',
      direction: 'sell',
      notional: 200,
      allocationPct: 0.2,
      expectedPrice: 0.5,
      reason: 'attempt to exit',
      createdAt: new Date()
    });

    expect(() =>
      portfolio.executeTrade({
        tradeInstructionId: sellInstructionId,
        marketId: 'market-3',
        optionId: 'yes',
        direction: 'sell',
        price: 0.5,
        notional: 200
      })
    ).toThrow(/Sell quantity exceeds open position/);
  });

  function createEvaluation(marketId: string): number {
    return repo.recordMarketEvaluation({
      runId,
      agentId: 'agent_openai',
      marketId,
      title: `Evaluation for ${marketId}`,
      outcomes: [
        { id: 'yes', name: 'Yes', price: 0.5 },
        { id: 'no', name: 'No', price: 0.5 }
      ],
      currentPrices: { yes: 0.5, no: 0.5 },
      quickResearchSummary: 'test summary',
      trade: true,
      evaluationRationale: 'test rationale',
      timestamp: new Date()
    });
  }
});
