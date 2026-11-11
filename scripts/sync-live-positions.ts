#!/usr/bin/env tsx
import 'dotenv/config';

import { loadAgentsConfig, loadRuntimeConfig } from '../src/config';
import { getRepository } from '../src/storage';
import { syncLivePositionsFromSnapshot } from '../src/agent/livePositions';
import { createClobClientForAgent } from '../src/clients/polymarket_live';

async function main() {
  const root = process.cwd();
  const runtime = await loadRuntimeConfig(root);
  const { agents } = await loadAgentsConfig(root);
  const repo = await getRepository();

  let touched = 0;
  for (const agent of agents) {
    if (!agent.enabled || agent.paperTrading !== false) continue;
    const liveClient = createClobClientForAgent(agent as any);
    if (!liveClient) {
      console.warn(`[positions:sync-live] skipping ${agent.id}: missing live credentials`);
      continue;
    }
    try {
      const res = await syncLivePositionsFromSnapshot({
        agent: agent as any,
        runtime: runtime as any,
        repo,
        log: (msg, data) => console.log(`[positions:sync-live] ${msg}`, data),
      });
      touched += res.upserted + res.closed;
    } catch (err) {
      console.error(`[positions:sync-live] failed for ${agent.id}`, err);
    }
  }

  console.log(`[positions:sync-live] complete (rows touched: ${touched})`);
}

main().catch((err) => {
  console.error('[positions:sync-live] error', err);
  process.exit(1);
});
