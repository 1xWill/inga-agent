import type { RuntimeConfig } from "../../config/schema";
import type { AgentRepositoryAsync } from "../../storage/types";
import { enrichMarketOutcomeLabels } from "../../../app/api/_lib/enrich";

export type ClosedPositionsPageResult = {
  agentId: string;
  rows: any[];
  pagination: {
    page: number;
    limit: number;
    total: number;
  };
  filters: {
    marketId?: string;
    optionId?: string;
  };
};

export async function fetchClosedPositionsPage({
  repo,
  runtime,
  agentId,
  page,
  limit,
  marketId,
  optionId,
}: {
  repo: AgentRepositoryAsync;
  runtime: RuntimeConfig;
  agentId: string;
  page: number;
  limit: number;
  marketId?: string;
  optionId?: string;
}): Promise<ClosedPositionsPageResult> {
  const safeLimit = Math.max(1, Math.min(25, Math.floor(limit || 5)));
  const pageRaw = Number(page ?? 1);
  const safePage = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;

  const maxPages = Math.max(1, (runtime.ui as any)?.maxClosedPages ?? 12);
  if (safePage > maxPages) {
    throw new Error(`Page ${safePage} exceeds maxClosedPages (${maxPages})`);
  }

  const offset = (safePage - 1) * safeLimit;
  const rows = await (repo as any).listRecentClosedPositions(safeLimit, agentId, offset, {
    marketId,
    optionId,
  });
  const total = await (repo as any).countClosedPositions(agentId, { marketId, optionId });
  const withStatus = (rows ?? []).map((r: any) => ({
    ...r,
    status: "closed",
    realizedPnlForPosition: typeof r.realizedPnl === "number" ? r.realizedPnl : undefined,
  }));
  const enriched = await enrichMarketOutcomeLabels(repo as any, withStatus, (p: any) => ({
    marketId: p.marketId,
    evaluationOutcomeId: p.optionId,
    clobTokenId: p.optionId,
  }));

  return {
    agentId,
    rows: enriched,
    pagination: {
      page: safePage,
      limit: safeLimit,
      total: Number(total ?? 0),
    },
    filters: { marketId, optionId },
  };
}

