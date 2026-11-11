import { NextRequest, NextResponse } from "next/server";
import { getRepository } from "../../_lib/db";
import { loadAgentsConfig, loadRuntimeConfig } from "../../../../src/config/loaders";
import { fetchActivitiesPage } from "../../../../src/server/ui/activitiesPage";

export const runtime = "nodejs";

function parsePage(value: string | null, fallback = 1) {
  const num = Number(value);
  return Number.isFinite(num) ? Math.max(1, Math.floor(num)) : fallback;
}

export async function GET(req: NextRequest) {
  const repo = await getRepository();
  const runtimeCfg = await loadRuntimeConfig(process.cwd());
  const agentsCfg = await loadAgentsConfig(process.cwd());
  const { searchParams } = new URL(req.url);
  const page = parsePage(searchParams.get("page"));
  const limit = parsePage(searchParams.get("limit"), 10);
  const includeDecisions =
    (searchParams.get("includeDecisions") ?? "1").toLowerCase() !== "0";
  const agentId = searchParams.get("agentId") || undefined;
  const marketId = searchParams.get("marketId") || undefined;
  const optionId = searchParams.get("optionId") || undefined;

  const result = await fetchActivitiesPage({
    repo,
    runtime: runtimeCfg,
    agentsCfg,
    page,
    limit,
    includeDecisions,
    agentId,
    marketId,
    optionId,
  });
  return NextResponse.json(result);
}
