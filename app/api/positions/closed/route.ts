import { NextRequest, NextResponse } from 'next/server';
import { getRepository } from '../../_lib/db';
import { getSearchParams, parseLimit } from '../../_lib/query';
import { loadRuntimeConfig } from '../../../../src/config/loaders';
import { fetchClosedPositionsPage } from '../../../../src/server/ui/closedPositionsPage';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const params = getSearchParams(req);
  const agentId = params.get('agentId');
  if (!agentId) {
    return NextResponse.json({ error: 'agentId required' }, { status: 400 });
  }
  const marketIdRaw = params.get('marketId');
  const optionIdRaw = params.get('optionId');
  const marketId = marketIdRaw && marketIdRaw.trim().length > 0 ? marketIdRaw.trim() : undefined;
  const optionId = optionIdRaw && optionIdRaw.trim().length > 0 ? optionIdRaw.trim() : undefined;
  const limit = parseLimit(params, 5, { min: 1, max: 25 });
  const pageRaw = Number(params.get('page') ?? '1');
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
  const runtimeConfig = await loadRuntimeConfig(process.cwd());
  const repo = await getRepository();
  try {
    const result = await fetchClosedPositionsPage({
      repo: repo as any,
      runtime: runtimeConfig as any,
      agentId,
      page,
      limit,
      marketId,
      optionId,
    });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: String((e as Error).message || e) }, { status: 400 });
  }
}
