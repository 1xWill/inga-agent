import { NextResponse } from 'next/server';
import { loadRuntimeConfig } from '../../../../src/config/loaders';

export const runtime = 'nodejs';

export async function GET() {
  const cfg = await loadRuntimeConfig(process.cwd());
  const body = {
    portfolio: { initialBalance: cfg.portfolio.initialBalance, baseCurrency: cfg.portfolio.baseCurrency },
    charts: cfg.charts ?? { yTicks: 6, yPaddingPct: 0.1, glyphsPerSeries: 160, endLabel: { minGapPx: 14 }, timeFormat: { short: 'MMM d HH:mm', long: 'MMM d' } },
    portfolioHistory: { intervalMinutes: cfg.portfolioHistory?.intervalMinutes ?? 5 },
    evaluations: { ui: cfg.evaluations?.ui ?? { includePrefiltered: true, includeFailed: true } },
    ui: {
      maxEvaluationPages: cfg.ui?.maxEvaluationPages ?? 12,
      maxActivityPages: cfg.ui?.maxActivityPages ?? 12,
      maxOpenPages: cfg.ui?.maxOpenPages ?? 8,
    }
  };
  return NextResponse.json(body);
}
