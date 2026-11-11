import { NextRequest, NextResponse } from 'next/server';
import { runAgentOnce } from '../../../../src/agent/runner';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  let data: any = {};
  const contentType = req.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    data = await req.json().catch(() => ({}));
  } else if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data')) {
    const form = await req.formData();
    data = Object.fromEntries(form.entries());
  }
  const agentId = typeof data.agentId === 'string' ? data.agentId : undefined;
  const dbFilePath = typeof data.db === 'string' ? data.db : process.env.PAPER_DB_FILE;

  // Run synchronously for now; this call may take seconds depending on providers.
  await runAgentOnce({ agentId, dbFilePath, log: (m, d) => console.log('[api/run]', m, d ?? '') });
  return NextResponse.json({ status: 'completed' });
}
