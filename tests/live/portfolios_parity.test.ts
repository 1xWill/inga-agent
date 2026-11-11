import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';

// Import the API handler directly
import { GET as getPortfolios } from '../../app/api/portfolios/route';

function haveLiveCreds() {
  // These will be validated by the polymarket:account script; here we just ensure we're not missing env entirely
  return Boolean(process.env.OPENROUTER_API_KEY) && (Boolean(process.env.POLY_API_KEY) || Object.keys(process.env).some(k=>k.startsWith('POLY_API_KEY_')));
}

describe('Live parity: /api/portfolios vs polymarket:account', () => {
  beforeAll(() => {
    if (!haveLiveCreds()) {
      throw new Error('Missing required env vars for live tests (OPENROUTER_API_KEY and Polymarket L2 creds)');
    }
  });

  it('matches equity and open position tokens for the first enabled agent (within small tolerance)', async () => {
    // Run the CLI snapshot
    const stdout = execSync('npm run -s polymarket:account -- --mode snapshot --limit 200', { stdio: ['ignore','pipe','pipe'] });
    const snap = JSON.parse(String(stdout));
    const agentId: string = snap.agentId;

    // Invoke the API handler
    const res = await getPortfolios({ url: 'http://test/api/portfolios' } as any);
    const body = await (res as any).json();
    const row = (body.portfolios as any[]).find(r => r.agentId === agentId);
    expect(row).toBeTruthy();
    const equityApi = Number(row.portfolio?.equity ?? 0);
    const equityCli = Number(snap.usdc) + (Array.isArray(snap.openPositions) ? snap.openPositions.reduce((a:number,p:any)=>a + (p.mtm ?? (p.averagePrice*p.quantity)), 0) : 0);

    // Tolerance: a few cents due to marks refresh timing
    expect(Math.abs(equityApi - equityCli)).toBeLessThan(0.25);

    const tokensApi = new Set<string>((row.portfolio?.positions ?? []).filter((p:any)=>p.status==='open').map((p:any)=>p.optionId));
    const tokensCli = new Set<string>((snap.openPositions ?? []).map((p:any)=>p.tokenId));
    // Require that every CLI open token is present in API open positions
    for (const t of tokensCli) expect(tokensApi.has(t)).toBe(true);
  }, 120_000);
});

