import { describe, expect, it } from 'vitest';

import { buildDecisionPrompt, type DecisionPromptInput } from '../src/prompts/decision';
import { buildMonitorPrompt } from '../src/prompts/monitor';
import { testRuntime } from './helpers/runtime';

describe('Prompt builders', () => {
  it('applies decision prompt overrides from runtime config', () => {
    const runtime = testRuntime({
      prompts: {
        decision: {
          quick: {
            system: ['High priority override'],
            user: ['Operator note']
          }
        }
      }
    });
    const input: DecisionPromptInput = {
      runId: 1,
      agentId: 'agent_test',
      market: {
        id: 'm1',
        question: 'Will ABC happen?',
        outcomes: [
          { id: 'yes', name: 'Yes', price: 0.4 },
          { id: 'no', name: 'No', price: 0.6 }
        ]
      },
      quickResearchSummary: '- Stub',
      runtime,
      profile: 'quick'
    };

    const result = buildDecisionPrompt(input);
    expect(result.system.startsWith('High priority override')).toBe(true);
    expect(result.user.startsWith('Operator note')).toBe(true);
  });

  it('applies monitor prompt overrides', () => {
    const runtime = testRuntime({
      prompts: {
        monitor: {
          system: ['Monitor override']
        }
      }
    });
    const prompt = buildMonitorPrompt({
      runtime,
      marketId: 'm1',
      marketTitle: 'Market title',
      outcomeId: 'yes',
      outcomeName: 'Yes',
      position: { quantity: 10, averagePrice: 0.4, openedAt: new Date('2024-01-01T00:00:00Z') },
      latest: { bestBid: 0.35, bestAsk: 0.37, mid: 0.36 },
      liquidity: { bidTop: 50, askTop: 60, levels: 3 },
      costs: { cost: 4, theoreticalMaxGain: 6, remainingBestCase: 2 },
      entryRationale: 'Initial buy',
      researchBrief: ''
    });

    expect(prompt.system.startsWith('Monitor override')).toBe(true);
    expect(prompt.user).toContain('Market title');
  });
});
