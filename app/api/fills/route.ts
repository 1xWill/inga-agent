import 'dotenv/config';
import { NextRequest, NextResponse } from 'next/server';

import { getRepository } from '../_lib/db';
import { loadAgentsConfig, loadRuntimeConfig } from '../../../src/config/loaders';
import { getSearchParams, parseAgentId, parseLimit } from '../_lib/query';
import { buildFillsPayload } from '../_lib/dashboardPayloads';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const runtime = await loadRuntimeConfig(process.cwd());
  const params = getSearchParams(req);
  const agentId = parseAgentId(params);
  const actPages = Math.max(1, Math.floor(runtime.ui?.maxActivityPages ?? 12));
  const defaultLimit = actPages * 10;
  const limit = parseLimit(params, defaultLimit);

  const repo = await getRepository();
  const agentsCfg = await loadAgentsConfig(process.cwd());

  const fills = await buildFillsPayload({
    runtime,
    repo,
    agentsCfg,
    limit,
    agentId,
  });

  return NextResponse.json({ fills });
}
