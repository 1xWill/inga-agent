import 'dotenv/config';
import { NextRequest, NextResponse } from 'next/server';
import { loadAgentsConfig, loadRuntimeConfig } from '../../../../src/config/loaders';
import { getRepository } from '../../_lib/db';
import { fetchPortfolioHistory } from '../../../../src/server/ui/portfolioHistoryPage';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const repo = await getRepository();
  const runtimeCfg = await loadRuntimeConfig(process.cwd());
  const agentsCfg = await loadAgentsConfig(process.cwd());

  const url = new URL(req.url);
  const rangeParam = (url.searchParams.get('range') || '72h').toLowerCase();
  const range = rangeParam === 'all' ? 'all' : '72h';
  const debugFlag = ['1', 'true', 'yes'].includes((url.searchParams.get('debug') ?? '').toLowerCase());
  const agentsParam = url.searchParams.get('agents');
  const agents = agentsParam
    ? agentsParam
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

  const result = await fetchPortfolioHistory({
    repo: repo as any,
    runtime: runtimeCfg as any,
    agentsCfg,
    range: range as any,
    agents,
    debug: debugFlag,
  });
  return NextResponse.json(result);
}

