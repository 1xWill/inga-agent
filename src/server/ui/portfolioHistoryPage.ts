import type { AgentsConfig, RuntimeConfig } from "../../config/schema";
import type { AgentRepositoryAsync } from "../../storage/types";
import {
  BUCKET_STEPS_MS,
  bucketLabelToMs,
  groupAndDownsample,
  msToBucketLabel,
  SeriesPoint,
} from "../portfolioHistory";
import { getLiveAccountSnapshot } from "../liveAccount";

export type PortfolioHistoryResult = {
  history: Record<string, SeriesPoint[]>;
  baselineStart?: SeriesPoint;
  debug?: { bucketMs: number; bucket: string; maxPoints: number; range: string };
};

export async function fetchPortfolioHistory({
  repo,
  runtime,
  agentsCfg,
  range,
  agents,
  debug,
}: {
  repo: AgentRepositoryAsync;
  runtime: RuntimeConfig;
  agentsCfg: AgentsConfig;
  range: "72h" | "all";
  agents?: string[];
  debug?: boolean;
}): Promise<PortfolioHistoryResult> {
  const enabledAgents = agentsCfg.agents.filter((a) => a.enabled).map((a) => a.id);
  const requestedAgents = (agents && agents.length > 0 ? agents : enabledAgents).filter((id) =>
    enabledAgents.includes(id),
  );
  if (requestedAgents.length === 0) return { history: {} };

  const now = Date.now();
  let baselineStart: SeriesPoint | undefined = undefined;
  const seventyTwoHoursMs = 72 * 60 * 60 * 1000;
  let startTs = range === "all" ? 0 : now - seventyTwoHoursMs;

  // Initial bucket hint from config; we may escalate to honor maxPointsPerSeries
  const hintLabel =
    range === "all"
      ? (runtime.portfolioHistory?.buckets?.longRange ?? "1h")
      : (runtime.portfolioHistory?.buckets?.shortRange ?? "5m");
  let bucketMs = bucketLabelToMs(hintLabel);
  const maxPoints = Math.max(100, runtime.portfolioHistory?.maxPointsPerSeries ?? 1200);

  // Determine earliest snapshot across requested agents
  if (range === "all") {
    let earliest: number | undefined = undefined;
    const earliestRunStart = await (repo as any).getEarliestRunStart();
    if (typeof earliestRunStart === "number") earliest = earliestRunStart;
    for (const agentId of requestedAgents) {
      const first = await (repo as any).getEarliestPortfolioHistory(agentId);
      if (first && (earliest === undefined || first.ts < earliest)) earliest = first.ts;
    }
    if (typeof earliest === "number" && earliest > 0) {
      startTs = earliest;
    } else {
      startTs = now - 24 * 60 * 60 * 1000;
    }
  } else {
    // 72h range: if ALL requested agents started within the last 72h,
    // align startTs to the shared earliest start (same as ALL behavior).
    let earliestAcross: number | undefined = undefined;
    let anyUnknown = false;
    for (const agentId of requestedAgents) {
      let earliestForAgent: number | undefined = undefined;
      const s = await (repo as any).getEarliestRunStart(agentId);
      if (typeof s === "number") earliestForAgent = s;
      const first = await (repo as any).getEarliestPortfolioHistory(agentId);
      if (first && (earliestForAgent === undefined || first.ts < earliestForAgent)) {
        earliestForAgent = first.ts;
      }
      if (typeof earliestForAgent === "number") {
        if (earliestAcross === undefined || earliestForAgent < earliestAcross) {
          earliestAcross = earliestForAgent;
        }
      } else {
        anyUnknown = true;
      }
    }
    const anchor72h =
      !anyUnknown &&
      typeof earliestAcross === "number" &&
      earliestAcross >= now - seventyTwoHoursMs;
    if (anchor72h) startTs = earliestAcross as number;
  }

  // Global all-time baseline start across the requested agents (used for 72h pnl anchoring).
  for (const agentId of requestedAgents) {
    const first = await (repo as any).getEarliestPortfolioHistory(agentId);
    if (first) {
      const pt: SeriesPoint = {
        t: first.ts,
        equity: first.equity,
        realized: first.realizedPnl ?? 0,
        unrealized: first.unrealizedPnl ?? 0,
      };
      if (!baselineStart || pt.t < baselineStart.t) baselineStart = pt;
    }
  }

  const rawByAgent = new Map<string, SeriesPoint[]>();
  for (const agentId of requestedAgents) {
    const rows = await (repo as any).listPortfolioHistoryBetween(agentId, startTs, now);
    let pts: SeriesPoint[] = (rows ?? []).map((r: any) => ({
      t: r.ts,
      equity: r.equity,
      realized: r.realizedPnl,
      unrealized: r.unrealizedPnl,
    }));

    // Live-mode hygiene: if existing history is entirely the paper initialBalance from
    // earlier runs, ignore it so the chart reflects live values only.
    try {
      const ag = agentsCfg.agents.find((a) => a.id === agentId);
      if (ag && ag.enabled && ag.paperTrading === false) {
        const init = runtime.portfolio.initialBalance;
        let cut = 0;
        while (cut < Math.max(0, pts.length - 1) && pts[cut].equity === init) cut += 1;
        if (cut > 0) pts = pts.slice(cut);
      }
    } catch {}

    if (pts.length === 0) {
      // Compute an equity fallback at startTs (read-only).
      // - Paper mode: use DB positions + marks.
      // - Live mode: attempt a live CLOB-backed snapshot; if it fails, leave empty.
      let cash = runtime.portfolio.initialBalance;
      let mtm = 0;
      let unrealized = 0;
      let haveConcrete = false;
      try {
        const ag = agentsCfg.agents.find((a) => a.id === agentId);
        if (ag && ag.enabled && ag.paperTrading === false) {
          let liveSnap: Awaited<ReturnType<typeof getLiveAccountSnapshot>> | undefined;
          const attempts = 3;
          for (let i = 0; i < attempts; i += 1) {
            try {
              liveSnap = await getLiveAccountSnapshot(ag as any, runtime as any, {
                tradesLimit: 300,
                includeOrders: false,
                deepClosed: true,
              });
              break;
            } catch {
              if (i < attempts - 1) {
                await new Promise((resolve) => setTimeout(resolve, 250));
              }
            }
          }
          if (liveSnap) {
            cash = typeof liveSnap.balance === "number" ? liveSnap.balance : 0;
            mtm = (liveSnap.openPositions ?? []).reduce((acc, p) => acc + (p.mtm ?? 0), 0);
            unrealized = (liveSnap.openPositions ?? []).reduce((acc, p) => {
              const mark =
                typeof p.bestBid === "number"
                  ? p.bestBid
                  : typeof p.bestAsk === "number"
                    ? p.bestAsk
                    : p.averagePrice;
              return acc + (mark - p.averagePrice) * p.quantity;
            }, 0);
            haveConcrete = true;
          } else {
            pts = [];
          }
        } else {
          const marks = await (repo as any).getPositionMarks(agentId);
          const open = await (repo as any).listOpenPositions(agentId);
          mtm = (open ?? []).reduce((acc: number, p: any) => {
            const m = marks.get(`${p.marketId}:${p.optionId}`);
            const mark = typeof m?.bestBid === "number" ? m.bestBid : p.averagePrice;
            return acc + mark * p.quantity;
          }, 0);
          haveConcrete = true;
        }
      } catch {}
      if (pts.length === 0 && haveConcrete) {
        pts = [{ t: startTs, equity: cash + mtm, realized: 0, unrealized }];
      }
    }

    rawByAgent.set(agentId, pts);
  }

  // Escalate bucket if any agent would exceed maxPoints when grouped
  const stepOrder = BUCKET_STEPS_MS.slice();
  let stepIdx = stepOrder.findIndex((v) => v >= bucketMs);
  if (stepIdx < 0) stepIdx = 1;

  function anyExceeds(pointsByAgent: Map<string, SeriesPoint[]>, bMs: number): boolean {
    for (const pts of pointsByAgent.values()) {
      const grouped = groupAndDownsample(pts, bMs);
      if (grouped.length > maxPoints) return true;
    }
    return false;
  }

  while (stepIdx < stepOrder.length && anyExceeds(rawByAgent, stepOrder[stepIdx])) {
    stepIdx += 1;
  }
  bucketMs = stepOrder[Math.min(stepIdx, stepOrder.length - 1)] ?? bucketMs;

  const history: Record<string, SeriesPoint[]> = {};
  for (const [agentId, pts] of rawByAgent.entries()) {
    history[agentId] = groupAndDownsample(pts, bucketMs);
  }

  const response: PortfolioHistoryResult = { history };
  if (range === "72h" && baselineStart) response.baselineStart = baselineStart;
  if (debug) {
    response.debug = {
      bucketMs,
      bucket: msToBucketLabel(bucketMs),
      maxPoints,
      range,
    };
  }
  return response;
}
