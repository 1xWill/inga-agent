import 'dotenv/config';
import { NextRequest, NextResponse } from 'next/server';

import type { AgentsConfig } from '../../../src/config/schema';
import { getRepository } from '../_lib/db';
import { loadAgentsConfig, loadRuntimeConfig } from '../../../src/config/loaders';
import { getSearchParams, parseAgentId, parseLimit } from '../_lib/query';
import { buildExitsPayload } from '../_lib/dashboardPayloads';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const runtime = await loadRuntimeConfig(process.cwd());
  const params = getSearchParams(req);
  const agentId = parseAgentId(params);
  const actPages = Math.max(1, Math.floor(runtime.ui?.maxActivityPages ?? 12));
  const defaultLimit = actPages * 10;
  const limit = parseLimit(params, defaultLimit);

  const repo = await getRepository();
  let agentsCfg: AgentsConfig | undefined;
  try {
    agentsCfg = await loadAgentsConfig(process.cwd());
  } catch {}

  const exits = await buildExitsPayload({
    runtime,
    repo,
    limit,
    agentId,
    agentsCfg,
  });

  return NextResponse.json({ exits });
}
