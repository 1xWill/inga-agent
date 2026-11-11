import type { AgentsConfig, RuntimeConfig } from "../../config/schema";
import type { AgentRepositoryAsync } from "../../storage/types";
import type {
  ActivityItem,
  DashboardData,
} from "../../types/dashboard";
import { buildActivityItems } from "../../dashboard/activityTimeline";
import { attachRealizedPnlToExits } from "../exitsPnl";
import { enrichMarketOutcomeLabels } from "../../../app/api/_lib/enrich";

export type ActivitiesPageResult = {
  rows: ActivityItem[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    maxPages: number;
  };
};

export async function fetchActivitiesPage({
  repo,
  runtime,
  agentsCfg,
  page,
  limit,
  includeDecisions,
  agentId,
  marketId,
  optionId,
}: {
  repo: AgentRepositoryAsync;
  runtime: RuntimeConfig;
  agentsCfg: AgentsConfig;
  page: number;
  limit: number;
  includeDecisions: boolean;
  agentId?: string | null;
  marketId?: string;
  optionId?: string;
}): Promise<ActivitiesPageResult> {
  const pageSize = Math.min(10, Math.max(1, Math.floor(limit)));
  const maxPages =
    Math.max(1, Math.floor(runtime.ui?.maxActivityPages ?? 12)) || 1;
  const safePage = Math.min(
    Math.max(1, Math.floor(page)),
    Math.max(1, maxPages),
  );
  const fetchRows = pageSize * maxPages;
  const [decisionsRaw, tradesRaw, fillsRaw, exitsRaw] = await Promise.all([
    repo.listRecentPlanDecisions(fetchRows, agentId ?? undefined),
    repo.listRecentTradeInstructions(fetchRows, agentId ?? undefined),
    repo.listRecentFills(fetchRows, agentId ?? undefined),
    repo.listRecentExits(fetchRows, agentId ?? undefined),
  ]);

  const agentsById = new Map(agentsCfg.agents.map((a) => [a.id, a]));
  const exitsWithPnl = await attachRealizedPnlToExits(repo as any, exitsRaw as any[], {
    closedRowsLimit: fetchRows * 2,
    agentsById,
    tradesTtlMs: (runtime.http as any)?.memoize?.clobTradesTtlMs,
  });

  const [decisions, trades, fills, exits] = await Promise.all([
    enrichMarketOutcomeLabels(repo as any, decisionsRaw, (d: any) => ({
      marketId: d.marketId,
      evaluationOutcomeId: d.outcomeId,
    })),
    enrichMarketOutcomeLabels(repo as any, tradesRaw, (t: any) => ({
      marketId: t.marketId,
      evaluationOutcomeId: t.optionId,
      clobTokenId: t.optionId,
    })),
    enrichMarketOutcomeLabels(repo as any, fillsRaw, (f: any) => ({
      marketId: f.marketId,
      evaluationOutcomeId: f.optionId,
      clobTokenId: f.optionId,
    })),
    enrichMarketOutcomeLabels(repo as any, exitsWithPnl, (x: any) => ({
      marketId: x.marketId,
      evaluationOutcomeId: x.optionId,
      clobTokenId: x.optionId,
    })),
  ]);

  const data: DashboardData = {
    markets: [],
    planDecisions: decisions as any,
    trades: trades as any,
    fills: fills as any,
    exits: exits as any,
    portfolios: {},
  };
  const itemsAll = buildActivityItems(
    data,
    Date.now(),
    new Set<string>(),
  );
  const filteredByFocus = itemsAll.filter((it) => {
    if (marketId && it.marketId !== marketId) return false;
    if (optionId && it.outcomeId !== optionId) return false;
    return true;
  });
  const filteredByDecision = includeDecisions
    ? filteredByFocus
    : filteredByFocus.filter((it) => it.type !== "decision");
  const total = filteredByDecision.length;
  const start = (safePage - 1) * pageSize;
  const rows = filteredByDecision.slice(start, start + pageSize);
  return {
    rows,
    pagination: {
      page: safePage,
      limit: pageSize,
      total,
      maxPages,
    },
  };
}
