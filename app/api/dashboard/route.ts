import { NextResponse } from 'next/server';
import { loadAgentsConfig, loadRuntimeConfig } from '../../../src/config/loaders';
import { getRepository } from '../_lib/db';
import { buildFillsPayload, buildPortfoliosPayload } from '../_lib/dashboardPayloads';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const runtime = await loadRuntimeConfig(process.cwd());
  const agentsCfg = await loadAgentsConfig(process.cwd());
  const repo = await getRepository();
  const pageSize = 10;
  const maxPages = Math.max(1, Math.floor(runtime.ui?.maxActivityPages ?? 12));
  const fillsLimit = pageSize * maxPages;

  const [fills, portfolios] = await Promise.all([
    buildFillsPayload({ runtime, repo, agentsCfg, limit: fillsLimit, agentId: undefined }),
    buildPortfoliosPayload({ repo, runtime, agentsCfg, debugFlag: false }),
  ]);

  return NextResponse.json({
    fills,
    portfolios,
  });
}
