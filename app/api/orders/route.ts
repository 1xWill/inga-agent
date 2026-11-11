import { NextRequest, NextResponse } from 'next/server';

import { loadAgentsConfig, loadRuntimeConfig } from '../../../src/config/loaders';
import { getSearchParams, parseAgentId } from '../_lib/query';
import { buildOrdersPayload } from '../_lib/dashboardPayloads';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const agentsCfg = await loadAgentsConfig(process.cwd());
  const cfg = await loadRuntimeConfig(process.cwd());
  const params = getSearchParams(req);
  const agentFilter = parseAgentId(params);

  const byAgent = await buildOrdersPayload({ runtime: cfg, agentsCfg, agentFilter });
  return NextResponse.json({ byAgent });
}
