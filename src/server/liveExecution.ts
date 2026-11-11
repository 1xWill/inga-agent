import type { AgentDefinition, RuntimeConfig } from '../config/schema';
import type { AgentRepositoryAsync } from '../storage/types';
import { findLatestExecutionTime } from './liveTradesCache';

const NUMERIC_EXIT_PREFIXES = [
  'stop loss at ',
  'take profit at ',
  'time-based exit ',
  'target tp hit',
  'target sl hit',
  'monitor risk_trim:',
  'auto-redeem',
];

export function isNumericExit(direction: string, reason: string): boolean {
  if (String(direction).toLowerCase() !== 'sell') return false;
  const lower = reason.toLowerCase();
  return NUMERIC_EXIT_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

export async function resolveFallbackTokenId(
  repo: AgentRepositoryAsync,
  marketId: string,
  optionId: string
): Promise<string | undefined> {
  if (!marketId || !optionId) return undefined;
  try {
    const ev = await repo.getLatestEvaluationSummary(marketId);
    const idx = ev?.outcomes?.findIndex((o: any) => o?.id === optionId) ?? -1;
    if (idx >= 0) {
      const resolved = await repo.getResolvedClobTokenId(marketId, idx);
      if (resolved) return resolved;
    }
  } catch {
    // best effort only
  }
  return undefined;
}

type ExecutionParams = {
  repo: AgentRepositoryAsync;
  agent: AgentDefinition;
  runtime: RuntimeConfig;
  instructionId: number;
  marketId: string;
  optionId: string;
  direction: string;
  liveOrderId?: string;
  createdAt: string;
  status?: string;
  executedAt?: string;
  forceRefresh?: boolean;
};

export async function ensureExecutionInfo({
  repo,
  agent,
  runtime,
  instructionId,
  marketId,
  optionId,
  direction,
  liveOrderId,
  createdAt,
  status,
  executedAt,
  forceRefresh,
}: ExecutionParams): Promise<{ executedAt?: string; status?: string }> {
  if (!liveOrderId) return { executedAt, status };
  const lowerStatus = (status ?? '').toLowerCase();
  const tradesTtl =
    typeof (runtime.http as any)?.memoize?.clobTradesTtlMs === 'number'
      ? (runtime.http as any).memoize.clobTradesTtlMs
      : undefined;
  const ttlMs = forceRefresh ? 0 : tradesTtl;
  let finalStatus = status;
  let finalExecutedAt = executedAt;

  const fallbackTokenId = await resolveFallbackTokenId(repo, marketId, optionId);
  const lookup = async (ttlOverride?: number) =>
    findLatestExecutionTime(agent as any, liveOrderId, {
      ttlMs: typeof ttlOverride === 'number' ? ttlOverride : ttlMs,
      fallbackByToken: fallbackTokenId
        ? { tokenId: fallbackTokenId, side: direction as any, after: createdAt }
        : undefined,
    });

  if (!finalExecutedAt && lowerStatus === 'filled') {
    const ts = await lookup();
    if (ts) {
      finalExecutedAt = ts;
      try {
        await repo.setTradeInstructionExecutionInfo(instructionId, {
          executedAt: ts,
          takerOrderId: liveOrderId,
        });
      } catch {}
    }
  } else if (lowerStatus === 'canceled' || lowerStatus === 'failed') {
    const ts = await lookup(0);
    if (ts) {
      finalExecutedAt = finalExecutedAt ?? ts;
      finalStatus = 'filled';
      try {
        await repo.setTradeInstructionExecutionInfo(instructionId, {
          executedAt: ts,
          takerOrderId: liveOrderId,
        });
      } catch {}
      try {
        await repo.setTradeInstructionLiveInfo(instructionId, { status: 'filled' });
      } catch {}
    }
  }

  return { executedAt: finalExecutedAt, status: finalStatus };
}
