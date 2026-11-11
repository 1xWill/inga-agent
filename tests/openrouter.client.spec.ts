import { describe, expect, it } from 'vitest';

import { createOpenRouterClient } from '../src/clients/openrouter';
import { createHttpClient } from '../src/http/client';

const researchProfiles = {
  quick: {
    openrouter: {
      maxTokens: 400,
      temperature: 0.2,
      timeoutMs: 20000
    }
  },
  deep: {
    openrouter: {
      maxTokens: 1200,
      temperature: 0.1,
      timeoutMs: 45000
    }
  }
} as const;

const httpClient = createHttpClient({
  retry: {
    retries: 3,
    minDelayMs: 500,
    maxDelayMs: 4000,
    factor: 2
  },
  timeoutMs: 30000
});

describe('OpenRouterClient', () => {
  it('creates real chat completions with profile-driven defaults', async () => {
    const client = createOpenRouterClient({
      httpClient,
      apiKey: process.env.OPENROUTER_API_KEY as string,
      defaultModel: 'openai/gpt-oss-120b',
      researchProfiles
    });

    const result = await client.complete({
      messages: [
        { role: 'system', content: 'Be concise' },
        { role: 'user', content: 'Say hi in one short sentence' }
      ],
      profile: 'quick'
    });

    expect(typeof result.content).toBe('string');
    expect(result.content.length).toBeGreaterThan(0);
  });

  it('streams real responses and exposes incremental chunks', async () => {
    const client = createOpenRouterClient({
      httpClient,
      apiKey: process.env.OPENROUTER_API_KEY as string,
      defaultModel: 'openai/gpt-oss-120b',
      researchProfiles
    });

    let acc = '';
    for await (const chunk of client.streamCompletion({
      messages: [{ role: 'user', content: 'Stream a two-word greeting.' }],
      profile: 'deep'
    })) {
      if (!chunk.done && chunk.delta) acc += chunk.delta;
    }

    expect(acc.length).toBeGreaterThan(0);
  });

  it('throws when profile is missing', async () => {
    const client = createOpenRouterClient({
      httpClient,
      apiKey: 'router-key',
      defaultModel: 'openai/gpt-4.1',
      researchProfiles
    });

    await expect(
      client.complete({
        messages: [{ role: 'user', content: 'Hi' }],
        profile: 'missing' as never
      })
    ).rejects.toThrow(/Unknown OpenRouter profile/);
  });
});
