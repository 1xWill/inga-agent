import type { AgentRepositoryAsync } from "../../storage/types";
import type { RuntimeConfig } from "../../config/schema";
import type { MarketEvaluationView } from "../../types/dashboard";
import { enrichMarketOutcomeLabels } from "../../../app/api/_lib/enrich";

export type EvaluationsPageResult = {
  rows: MarketEvaluationView[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    maxPages: number;
  };
};

export async function fetchEvaluationsPage({
  repo,
  runtime,
  page,
  limit,
  agentId,
  tradeOnly,
  marketId,
}: {
  repo: AgentRepositoryAsync;
  runtime: RuntimeConfig;
  page: number;
  limit: number;
  agentId?: string | null;
  tradeOnly?: boolean;
  marketId?: string;
}): Promise<EvaluationsPageResult> {
  const pageSize = Math.min(10, Math.max(1, Math.floor(limit)));
  const maxPages =
    Math.max(1, Math.floor(runtime.ui?.maxEvaluationPages ?? 12)) || 1;
  const safePage = Math.min(
    Math.max(1, Math.floor(page)),
    Math.max(1, maxPages),
  );
  const offset = (safePage - 1) * pageSize;
  const result = await (repo as any).listMarketEvaluationsPage({
    limit: pageSize,
    offset,
    agentId: agentId ?? undefined,
    tradeOnly,
    marketId,
  });
  // Enrich rows with marketUrl via shared helper, then map to `url` for evaluations UI.
  const labeled = await enrichMarketOutcomeLabels(repo as any, (result.rows ?? []) as any[], (r: any) => ({
    marketId: r.marketId,
  }));
  const rowsWithUrl = labeled.map((r: any) => {
    const { marketUrl, ...rest } = r;
    return { ...rest, url: rest.url ?? marketUrl };
  });
  const total = Number(result.total ?? 0);
  return {
    rows: rowsWithUrl,
    pagination: {
      page: safePage,
      limit: pageSize,
      total,
      maxPages,
    },
  };
}
