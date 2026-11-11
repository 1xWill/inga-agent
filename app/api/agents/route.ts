import { NextResponse } from 'next/server';
import { loadAgentsConfig } from '../../../src/config/loaders';

export const runtime = 'nodejs';

export async function GET() {
  const cfg = await loadAgentsConfig(process.cwd());
  const agents = cfg.agents.map((a) => ({ id: a.id, label: a.label, enabled: a.enabled, logo: a.logo, chartStyle: a.chartStyle }));
  return NextResponse.json({ agents });
}

