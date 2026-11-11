import { NextRequest, NextResponse } from "next/server";
import { getRepository } from "../../_lib/db";
import { loadRuntimeConfig } from "../../../../src/config/loaders";
import { fetchEvaluationsPage } from "../../../../src/server/ui/evaluationsPage";

export const runtime = "nodejs";

function parsePage(value: string | null, fallback = 1) {
  const num = Number(value);
  return Number.isFinite(num) ? Math.max(1, Math.floor(num)) : fallback;
}

export async function GET(req: NextRequest) {
  const repo = await getRepository();
  const runtimeCfg = await loadRuntimeConfig(process.cwd());
  const { searchParams } = new URL(req.url);
  const page = parsePage(searchParams.get("page"));
  const limit = parsePage(searchParams.get("limit"), 10);
  const agentId = searchParams.get("agentId");
  const marketId = searchParams.get("marketId") || undefined;
  const tradeOnly = searchParams.get("showRejected") === "0";

  const result = await fetchEvaluationsPage({
    repo,
    runtime: runtimeCfg,
    page,
    limit,
    agentId: agentId || undefined,
    tradeOnly,
    marketId,
  });
  return NextResponse.json(result);
}
