import type {
  ActivityItem,
  DashboardData,
  MarketEvaluationView,
  PortfolioView,
  PositionView,
} from "../../../src/types/dashboard";

export type DashboardMetrics = {
  marketsMonitored: number;
  lastPaperTrade: string;
  openPositions: number;
  equity: number;
  totalPnl: number;
  realizedPnl: number;
  unrealizedPnl: number;
  positionsValue: number;
};

export type PositionsByAgent = Record<
  string,
  { open: PositionView[]; closed: PositionView[] }
>;

export function buildDashboardMetrics(
  data: DashboardData,
  portfolios: Record<string, PortfolioView>,
  markBasis: "ask" | "bid",
): DashboardMetrics {
  const marketsMonitored = data.markets.length;
  const lastPaperTrade =
    data.fills.length > 0 ? data.fills[0].createdAt : "—";
  const allPortfolios = Object.values(portfolios);
  let openPositions = 0;
  let positionsValue = 0;
  let equity = 0;
  let unrealizedPnl = 0;
  let totalPnl = 0;
  let realizedPnl = 0;

  for (const port of allPortfolios) {
    const opens = (port.positions ?? []).filter((x) => x.status === "open");
    openPositions += opens.length;

    const positionsValueForAgent = opens.reduce((a, p) => {
      const markVal =
        markBasis === "ask"
          ? typeof p.bestAsk === "number"
            ? p.bestAsk
            : typeof p.bestBid === "number"
              ? p.bestBid
              : p.averagePrice
          : typeof p.bestBid === "number"
            ? p.bestBid
            : typeof p.bestAsk === "number"
              ? p.bestAsk
              : p.averagePrice;
      return a + markVal * p.quantity;
    }, 0);

    const equityAgent =
      typeof port.equity === "number"
        ? port.equity
        : port.cashBalance + positionsValueForAgent;

    const unrealAgent =
      typeof port.unrealizedPnl === "number"
        ? port.unrealizedPnl
        : positionsValueForAgent -
          opens.reduce((a, p) => a + p.averagePrice * p.quantity, 0);

    const baseline =
      typeof port.baselineEquity === "number"
        ? port.baselineEquity
        : undefined;

    const totalAgent =
      typeof baseline === "number"
        ? equityAgent - baseline
        : (port.realizedPnl ?? 0) + unrealAgent;

    const realizedAgent = totalAgent - unrealAgent;

    positionsValue += positionsValueForAgent;
    equity += equityAgent;
    unrealizedPnl += unrealAgent;
    totalPnl += totalAgent;
    realizedPnl += realizedAgent;
  }

  return {
    marketsMonitored,
    lastPaperTrade,
    openPositions,
    equity,
    totalPnl,
    realizedPnl,
    unrealizedPnl,
    positionsValue,
  };
}

export function buildPositionsByAgent(
  agents: Array<{ id: string }>,
  portfolios: Record<string, PortfolioView>,
  focusKey: string | null,
  closedByAgent: Record<string, PositionView[]>,
): PositionsByAgent {
  const obj: PositionsByAgent = {};
  for (const a of agents) {
    const port = portfolios[a.id];
    const arr = (port?.positions ?? []).filter((p) => p.status === "open");
    const open = arr.filter(
      (p) =>
        p.status === "open" &&
        (!focusKey ||
          focusKey === p.marketId ||
          focusKey === `${p.marketId}:${p.optionId}` ||
          focusKey?.startsWith(`${p.marketId}:`)),
    );
    const closedSource = closedByAgent[a.id] ?? [];
    const closed = closedSource.filter(
      (p) =>
        !focusKey ||
        focusKey === p.marketId ||
        focusKey === `${p.marketId}:${p.optionId}` ||
        focusKey?.startsWith(`${p.marketId}:`),
    );
    obj[a.id] = { open, closed };
  }
  return obj;
}

export function resolveFocusLabel(
  focusKey: string | null,
  portfolios: Record<string, PortfolioView>,
  evaluations: MarketEvaluationView[],
  activityItems: ActivityItem[],
): string {
  if (!focusKey) return "all";
  const [mId, oId] = focusKey.includes(":")
    ? focusKey.split(":")
    : [focusKey, undefined];
  const allPos: PositionView[] = Object.values(portfolios).flatMap(
    (p) => p.positions ?? [],
  );
  const foundPos = allPos.find(
    (p) => p.marketId === mId && (!oId || p.optionId === oId),
  );
  const foundActivity = activityItems.find(
    (t) => t.marketId === mId && (!oId || t.outcomeId === oId),
  );
  const marketTitle =
    foundPos?.marketTitle ??
    foundActivity?.marketTitle ??
    evaluations.find((e) => e.marketId === mId)?.title ??
    mId;
  const outcomeName =
    foundPos?.outcomeName ?? foundActivity?.outcomeName ?? oId;
  return outcomeName ? `${marketTitle} | ${outcomeName}` : marketTitle;
}
