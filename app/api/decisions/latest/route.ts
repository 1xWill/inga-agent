import { NextRequest, NextResponse } from 'next/server';

import { getRepository } from '../../_lib/db';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const agentId = searchParams.get('agentId') ?? undefined;
  const marketId = searchParams.get('marketId') ?? undefined;
  const outcomeId = searchParams.get('outcomeId') ?? undefined;

  if (!agentId || !marketId || !outcomeId) {
    return NextResponse.json({ error: 'agentId, marketId, and outcomeId are required' }, { status: 400 });
  }

  const repo = await getRepository();
  const latest = await repo.getLatestTradeRationale(agentId, marketId, outcomeId);
  if (!latest) return NextResponse.json({ trade_rationale: null, createdAt: null });
  return NextResponse.json({ trade_rationale: latest.tradeRationale, createdAt: latest.createdAt });
}
