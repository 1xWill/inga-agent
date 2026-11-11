import { NextRequest, NextResponse } from 'next/server';
import { getRepository } from '../_lib/db';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const limit = Number(searchParams.get('limit') ?? '50');
  const repo = await getRepository();
  const runs = await repo.listRuns(Math.max(1, Math.min(limit, 200)));
  return NextResponse.json({ runs });
}
