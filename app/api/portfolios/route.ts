import 'dotenv/config';
import { NextRequest, NextResponse } from 'next/server';

import { loadAgentsConfig, loadRuntimeConfig } from '../../../src/config/loaders';
import { getRepository } from '../_lib/db';
import { getSearchParams, parseBooleanFlag } from '../_lib/query';
import { buildPortfoliosPayload } from '../_lib/dashboardPayloads';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const repo = await getRepository();
  const runtime = await loadRuntimeConfig(process.cwd());
  const agentsCfg = await loadAgentsConfig(process.cwd());
  const params = getSearchParams(req);
  const debugFlag = parseBooleanFlag(params, 'debug');
  const portfolios = await buildPortfoliosPayload({
    repo,
    runtime,
    agentsCfg,
    debugFlag,
  });

  return NextResponse.json({ portfolios });
}
