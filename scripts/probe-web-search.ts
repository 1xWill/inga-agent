#!/usr/bin/env tsx
import 'dotenv/config';
import { loadAgentsConfig } from '../src/config';

async function readAgentsConfig() {
  const cfg = await loadAgentsConfig(process.cwd());
  return cfg.agents.filter((a) => a.enabled !== false && a.modelProvider === 'openrouter');
}
async function callOpenRouter(model: string, question: string, maxResults: number, apiKey: string) {
  const body = {
    model,
    plugins: [{
      id: 'web',
      engine: 'exa',
      max_results: Math.max(1, Math.min(maxResults, 15)),
      max_output_tokens: 1024,
      search_prompt: `Do at most ${Math.max(1, Math.min(maxResults, 15))} search for only the most latest, relevant and accurate results.`
    }],
    messages: [
      { role: 'system', content: 'Be concise. Use web plugin only when needed.' },
      { role: 'user', content: question }
    ]
  } as const;

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter error ${res.status}: ${text}`);
  }
  const json = await res.json();
  return json;
}

async function main() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error('Missing OPENROUTER_API_KEY in environment.');
    process.exit(1);
  }

  const agents = await readAgentsConfig();
  const question = 'what is the latest BTC price now?';
  const probeMaxResults = Number(process.env.WEB_SEARCH_MAX_RESULTS || 5);

  // Header
  console.log(`Q: ${question}`);
  console.log('A:');

  for (const agent of agents) {
    try {
      const resp = await callOpenRouter(agent.model, question, probeMaxResults, apiKey);
      // Extract assistant text from chat completions
      const answer: string = resp?.choices?.[0]?.message?.content ?? '';

      console.log(`${agent.id}: ${answer || '(no answer)'}`);
      console.log('citations:');
      console.log('---');
    } catch (err) {
      console.log(`${agent.id}: (error)`);
      console.log(`citations:`);
      console.log('---');
      // also print error to stderr for debugging
      console.error(`[probe-error][${agent.id}]`, (err as Error)?.message);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
