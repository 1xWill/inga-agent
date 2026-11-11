import { Wallet } from "ethers";
import { DashboardClient } from "./components/dashboard-client";
import { loadAgentsConfig, loadRuntimeConfig } from "../src/config/loaders";
import { fetchActivitiesPage } from "../src/server/ui/activitiesPage";
import { fetchEvaluationsPage } from "../src/server/ui/evaluationsPage";
import { getRepository } from "../src/storage";
import { buildPortfoliosPayload } from "./api/_lib/dashboardPayloads";
import { fetchPortfolioHistory } from "../src/server/ui/portfolioHistoryPage";
import { fetchClosedPositionsPage } from "../src/server/ui/closedPositionsPage";

// Force SSR for the home page so Next.js does not try to prerender at build time.
// This avoids build-time DB access (e.g., missing DATABASE_URL in CI) and fetches data per request.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

type SearchParams = Record<string, string | string[] | undefined>;

function firstParam(v: string | string[] | undefined): string | undefined {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v[0];
  return undefined;
}

function parseIntParam(v: string | undefined, fallback: number) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export default async function HomePage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const sp = (await searchParams) ?? {};
  const agentFocus = firstParam(sp.agent) ?? null;
  const focusKey = firstParam(sp.focus) ?? null;
  const showDecisions = (firstParam(sp.decisions) ?? "0") === "1";
  const showRejected = (firstParam(sp.rejected) ?? "0") === "1";
  const evalPage = parseIntParam(firstParam(sp.ep), 1);
  const actPage = parseIntParam(firstParam(sp.ap), 1);
  const chartRange = (firstParam(sp.range) ?? "all") === "72h" ? "72h" : "all";
  const closedAgentsParam = firstParam(sp.closed) ?? "";
  const requestedClosedAgents = closedAgentsParam
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const [focusMarketId, focusOptionId] = (() => {
    if (!focusKey) return [undefined, undefined] as const;
    if (focusKey.includes(":")) {
      const [m, o] = focusKey.split(":");
      return [m || undefined, o || undefined] as const;
    }
    return [focusKey, undefined] as const;
  })();

  const repo = await getRepository();
  const runtime = await loadRuntimeConfig(process.cwd());
  const agentsConfig = await loadAgentsConfig(process.cwd());
  const enabledAgents = agentsConfig.agents
    .filter((a) => a.enabled)
    .map((a) => {
      // Derive Polygon address from configured envs; never expose private keys.
      const pkEnv = a.walletPrivateKeyEnv;
      const addrEnv = a.walletAddressEnv;
      const pk = process.env[pkEnv];
      const addr = process.env[addrEnv];
      let address: string | undefined = addr;
      if (!address && pk) {
        try {
          const pkHex = pk.startsWith("0x") ? pk : `0x${pk}`;
          address = new Wallet(pkHex).address;
        } catch {}
      }
      return { id: a.id, label: a.label, logo: a.logo, chartStyle: a.chartStyle, address };
    });

  // Aggregate cross-agent records for initial view
  const pageSize = 10;
  const evaluationsPage = await fetchEvaluationsPage({
    repo,
    runtime,
    page: evalPage,
    limit: pageSize,
    agentId: agentFocus,
    tradeOnly: !showRejected,
    marketId: focusMarketId,
  });
  const activitiesPage = await fetchActivitiesPage({
    repo,
    runtime,
    agentsCfg: agentsConfig,
    page: actPage,
    limit: pageSize,
    includeDecisions: showDecisions,
    agentId: agentFocus,
    marketId: focusMarketId,
    optionId: focusOptionId,
  });
  const fillsWindow = Math.min(
    Math.max(pageSize, (runtime.ui?.maxActivityPages ?? 12) * pageSize),
    300,
  );
  const fills = await repo.listRecentFills(fillsWindow, undefined);
  const portfoliosArr = await buildPortfoliosPayload({
    repo: repo as any,
    runtime,
    agentsCfg: agentsConfig,
    debugFlag: false,
  });
  const portfolios: Record<string, any> = {};
  for (const p of portfoliosArr ?? []) portfolios[p.agentId] = p.portfolio;

  const cfgPublic = {
    portfolio: {
      initialBalance: runtime.portfolio.initialBalance,
      baseCurrency: runtime.portfolio.baseCurrency,
    },
    charts:
      runtime.charts ??
      ({
        yTicks: 6,
        yPaddingPct: 0.1,
        glyphsPerSeries: 160,
        endLabel: { minGapPx: 14 },
        timeFormat: { short: "MMM d HH:mm", long: "MMM d" },
      } as any),
    portfolioHistory: {
      intervalMinutes: runtime.portfolioHistory?.intervalMinutes ?? 5,
    },
  };

  const history = await fetchPortfolioHistory({
    repo: repo as any,
    runtime,
    agentsCfg: agentsConfig,
    range: chartRange,
    agents: enabledAgents.map((a) => a.id),
    debug: false,
  });

  const enabledAgentIds = new Set(enabledAgents.map((a) => a.id));
  const closedAgents = requestedClosedAgents.filter((id) => enabledAgentIds.has(id));
  const closedPagesEntries = await Promise.all(
    closedAgents.map(async (agentId) => {
      const page = parseIntParam(firstParam((sp as any)[`closedPage_${agentId}`]), 1);
      try {
        const result = await fetchClosedPositionsPage({
          repo: repo as any,
          runtime,
          agentId,
          page,
          limit: 5,
          marketId: focusMarketId,
          optionId: focusOptionId,
        });
        return [agentId, result] as const;
      } catch {
        return [agentId, undefined] as const;
      }
    }),
  );
  const closedPages: Record<string, any> = Object.fromEntries(closedPagesEntries);

  const initialData = {
    evaluations: evaluationsPage,
    activities: activitiesPage,
    fills,
    portfolios,
  };

  const maxOpenPages = Math.max(1, Math.floor(runtime.ui?.maxOpenPages ?? 8));
  const discMinutes =
    runtime.polling.marketFetchIntervalMinutes ??
    runtime.polling.positionMonitorIntervalMinutes ??
    5;
  const monMinutes =
    runtime.polling.positionMonitorIntervalMinutes ?? discMinutes;
  const minMinutes = Math.max(1 / 60, Math.min(discMinutes, monMinutes));
  const base = minMinutes * 60 * 1000;
  const refreshIntervalMs = Math.max(3000, Math.min(20000, base));

  return (
    <main className="page">
      <DashboardClient
        agents={enabledAgents}
        initialData={{
          ...initialData,
          ui: { openPageSize: pageSize, maxOpenPages },
        }}
        refreshIntervalMs={refreshIntervalMs}
        chart={{
          cfg: cfgPublic,
          history: {
            history: Object.fromEntries(
              Object.entries(history.history ?? {}).map(([id, pts]: any) => [
                id,
                (pts ?? []).map((p: any) => ({ t: p.t, equity: p.equity })),
              ]),
            ),
            baselineStart: history.baselineStart
              ? { t: history.baselineStart.t, equity: history.baselineStart.equity }
              : undefined,
          },
          range: chartRange,
        }}
        state={{
          agentFocus,
          focusKey,
          showDecisions,
          showRejected,
          closedAgents,
          closedPages,
        }}
      />
    </main>
  );
}
