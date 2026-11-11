import { describe, expect, it } from 'vitest';

import type { MarketSummary } from '../src/clients/polymarket';
import type { RuntimeConfig } from '../src/config/schema';
import { testRuntime } from './helpers/runtime';
import { evaluateMarket } from '../src/agent/pipeline/decision';
import { createOpenRouterClient } from '../src/clients/openrouter';
import { createHttpClient } from '../src/http/client';

const runtime: RuntimeConfig = testRuntime();

async function retryOnTransient<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e: any) {
      lastErr = e;
      const code = (e as any)?.code as string | undefined;
      const msg = String((e as any)?.message ?? e ?? '');
      const transient =
        code === 'UND_ERR_SOCKET' ||
        msg.includes('terminated') ||
        msg.includes('other side closed') ||
        msg.includes('ECONNRESET') ||
        msg.includes('socket');
      if (!transient || i === retries - 1) throw e;
      await new Promise((r) => setTimeout(r, 750 * (i + 1)));
    }
  }
  throw lastErr;
}

describe('Decision pipeline', () => {
  it('produces a structured evaluation with trade flag (live)', async () => {
    const market: MarketSummary = {
      id: 'm1',
      question: 'Will XYZ pass?',
      outcomes: [
        { id: 'yes', name: 'Yes', price: 0.45 },
        { id: 'no', name: 'No', price: 0.55 }
      ]
    };

    const llm = createOpenRouterClient({
      httpClient: createHttpClient({ retry: { retries: 3, minDelayMs: 500, maxDelayMs: 4000, factor: 2 }, timeoutMs: 30000 }),
      apiKey: process.env.OPENROUTER_API_KEY as string,
      defaultModel: 'openai/gpt-oss-120b',
      researchProfiles: runtime.researchProfiles
    });
    const { evaluation } = await retryOnTransient(() =>
      evaluateMarket(llm, {
        runId: 1,
        agentId: 'agent_openai',
        market,
        quickResearchSummary: '- News A\n- News B',
        runtime,
        profile: 'quick'
      })
    );

    expect(evaluation.marketId).toBe('m1');
    expect(typeof evaluation.trade).toBe('boolean');
    expect(typeof evaluation.evaluationRationale).toBe('string');
    expect(evaluation.outcomes).toHaveLength(2);
  });

  it('honors quick-phase trade context in deep phase and focuses on strategy', async () => {
    const market: MarketSummary = {
      id: 'm2',
      question: 'Will ABC happen?',
      outcomes: [
        { id: 'yes', name: 'Yes', price: 0.4 },
        { id: 'no', name: 'No', price: 0.6 }
      ]
    };

    let capturedUser: string | undefined;
    let capturedSystem: string | undefined;

    const llmStub = {
      // Minimal stub: capture prompts and return a deterministic JSON payload
      complete: async ({ messages }: any) => {
        capturedSystem = messages?.[0]?.content;
        capturedUser = messages?.[1]?.content;
        return {
          content: JSON.stringify({
            trade: true,
            outcomeId: 'yes',
            subjectiveProb: 0.7,
            maxPayPrice: 0.6,
            spendPct: 0.1,
            tpPct: null,
            slPct: null,
            evidence: [
              { sourceType: 'reputable', sourceName: 'TestWire', timestampIso: '2025-01-01T00:00:00Z', credibility: 'medium', summary: 'Stub evidence item.' }
            ],
            guards: { momentumSpike: false, evidenceQuality: 'medium', multiCandidateChecked: true },
            rationale:
              'Sizing the trade according to the quick decision and available headroom; we keep a modest position with no TP/SL for this stub.',
            riskNotes: null
          })
        };
      }
    } as any;

    const { evaluation, tradeRationale } = await evaluateMarket(llmStub, {
      runId: 1,
      agentId: 'agent_test',
      market,
      quickResearchSummary: '- Quick notes',
      deepResearchSummary: '- Deep notes',
      runtime,
      profile: 'deep',
      phase: 'deep',
      quickDecision: {
        trade: true,
        outcomeId: 'yes',
        subjectiveProb: 0.7,
        maxPayPrice: 0.6,
        edgeBps: 300,
        evaluationRationale: 'Quick phase decided to BUY yes with solid edge.'
      }
    });

    expect(evaluation.marketId).toBe('m2');
    // Guard: quick-phase trade=true + valid numeric fields → deep evaluation keeps trade=true
    expect(evaluation.trade).toBe(true);
    // Deep rationale is preserved as human-facing explanation
    expect(tradeRationale).toMatch(/Sizing the trade/i);

    // Prompt should include the quick decision context in deep phase
    expect(capturedUser).toMatch(/Quick decision summary \(prior phase\)/);
    expect(capturedSystem).toMatch(/Final phase role: quick phase has already done the high-level market evaluation/);
  });
});
