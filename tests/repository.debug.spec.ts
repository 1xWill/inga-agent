import { describe, it, expect } from 'vitest';

import { openDatabase, initializeSchema, closeDatabase } from '../src/agent/db';
import { AgentRepository } from '../src/agent/repository';

describe('Repository debug fields', () => {
  it('persists and reads debug blobs on evaluations', () => {
    const db = openDatabase({ inMemory: true });
    initializeSchema(db);
    const repo = new AgentRepository(db);

    const runId = repo.startRun('agent', new Date(), { mode: 'test' });
    const id = repo.recordMarketEvaluation({
      runId,
      agentId: 'agent',
      marketId: 'm1',
      title: 'Q',
      outcomes: [{ id: 'o1', name: 'Yes', price: 0.5 }],
      currentPrices: { o1: 0.5 },
      quickResearchSummary: 's',
      trade: false,
      evaluationRationale: 'r',
      timestamp: new Date(),
      debugMarketPayloadJson: [{ id: 'o1', bid: 0.49, ask: 0.51 }],
      debugAiInputJson: { system: 's', user: 'u' },
      debugAiOutputJson: { raw: '{"trade":false}' }
    });
    expect(id).toBeGreaterThan(0);

    const rows = repo.listRecentMarketEvaluations(10, 'agent');
    expect(rows[0].debugMarketPayload).toBeDefined();
    expect(rows[0].debugAiInput).toBeDefined();
    expect(rows[0].debugAiOutput).toBeDefined();

    closeDatabase(db);
  });
});
