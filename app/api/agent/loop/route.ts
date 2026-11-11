import { NextRequest, NextResponse } from 'next/server';
import { runAgentWithDualLoops } from '../../../../src/agent/runner';

export const runtime = 'nodejs';

// Support multiple concurrent loops keyed by agentId
const loops = new Map<string, { stop: () => void }>();

function status() {
  const entries = Array.from(loops.keys());
  return { running: entries.length > 0, agents: entries };
}

export async function GET() {
  return NextResponse.json(status());
}

export async function POST(req: NextRequest) {
  let body: any = {};
  const contentType = req.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    body = await req.json().catch(() => ({}));
  } else if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data')) {
    const form = await req.formData();
    body = Object.fromEntries(form.entries());
  }
  const action = body.action ?? 'start';
  const agentId: string | undefined = typeof body.agentId === 'string' ? body.agentId : undefined;
  const dbFilePath: string | undefined = typeof body.db === 'string' ? body.db : process.env.PAPER_DB_FILE;

  if (action === 'stop') {
    if (agentId) {
      const loop = loops.get(agentId);
      if (loop) {
        loop.stop();
        loops.delete(agentId);
        return NextResponse.json({ status: 'stopped', agentId });
      }
      return NextResponse.json({ status: 'not_running', agentId });
    }
    // Stop all
    for (const [id, loop] of loops.entries()) {
      try { loop.stop(); } catch {}
      loops.delete(id);
    }
    return NextResponse.json({ status: 'stopped_all' });
  }

  if (action === 'start_all') {
    // Start loops for all enabled agents not already running
    try {
      const { loadAgentsConfig } = await import('../../../../src/config/loaders');
      const cfg = await loadAgentsConfig(process.cwd());
      const started: string[] = [];
      for (const a of cfg.agents) {
        if (!a.enabled) continue;
        if (loops.has(a.id)) continue;
        const stop = runAgentWithDualLoops({ agentId: a.id, baseDir: process.cwd(), dbFilePath, log: (m, d) => console.log('[api/loop]', m, d ?? '') });
        loops.set(a.id, { stop });
        started.push(a.id);
      }
      return NextResponse.json({ status: 'started', agents: started });
    } catch (e) {
      return NextResponse.json({ error: String((e as Error).message || e) }, { status: 500 });
    }
  }

  if (!agentId) return NextResponse.json({ error: 'agentId required to start a loop' }, { status: 400 });
  if (loops.has(agentId)) return NextResponse.json({ status: 'already_running', agentId });

  const stop = runAgentWithDualLoops({ agentId, baseDir: process.cwd(), dbFilePath, log: (m, d) => console.log('[api/loop]', m, d ?? '') });
  loops.set(agentId, { stop });
  return NextResponse.json({ status: 'started', agentId });
}
