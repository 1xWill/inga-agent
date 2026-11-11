import { NextRequest, NextResponse } from 'next/server';
import { getRepository } from '../../_lib/db';

export const runtime = 'nodejs';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const repo = await getRepository();
  const { id: idParam } = await params;
  const id = Number(idParam);
  if (!Number.isFinite(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });

  const run = await repo.getRun(id);
  if (!run) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const evaluations = await repo.listEvaluationsByRun(id);
  const planDecisions = await repo.listPlanDecisionsByRun(id);
  const instructions = await repo.listTradeInstructionsByRun(id);
  const fills = await repo.listFillsByInstructionIds(instructions.map((i) => i.id));

  return NextResponse.json({ run, evaluations, planDecisions, instructions, fills });
}
