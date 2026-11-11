import { NextRequest, NextResponse } from 'next/server';

import { getRepository } from '../_lib/db';
import { loadRuntimeConfig } from '../../../src/config/loaders';
import { getSearchParams, parseAgentId, parseBooleanFlag, parseLimit } from '../_lib/query';
import { buildPlanDecisionsPayload } from '../_lib/dashboardPayloads';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const runtime = await loadRuntimeConfig(process.cwd());
  const params = getSearchParams(req);
  const agentId = parseAgentId(params);
  const verbose = parseBooleanFlag(params, 'verbose');
  const actPages = Math.max(1, Math.floor(runtime.ui?.maxActivityPages ?? 12));
  const defaultLimit = actPages * 10;
  const limit = parseLimit(params, defaultLimit);
  const repo = await getRepository();
  const decisions = await buildPlanDecisionsPayload({ repo, limit, agentId, verbose });
  return NextResponse.json({ decisions });
}
