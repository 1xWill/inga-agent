import type {
  ActivityItem,
  DashboardData,
  TradeInstructionView,
} from "../types/dashboard";

const EXIT_DUPLICATE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

function normalizeStatus(status?: string) {
  return typeof status === "string" ? status.trim().toLowerCase() : undefined;
}

function isFailureStatus(status?: string) {
  if (!status) return false;
  if (/^[45]\d{2}$/.test(status)) return true;
  return (
    status.includes("fail") ||
    status.includes("error") ||
    status.includes("timeout") ||
    status.includes("reject") ||
    status.includes("cancel")
  );
}

function isSuccessStatus(status?: string) {
  if (!status) return false;
  return (
    status === "matched" ||
    status === "filled" ||
    status === "success" ||
    status === "done" ||
    status === "partial_fill"
  );
}

function buildExitKey(exit: TradeInstructionView) {
  if (!exit.agentId || !exit.marketId) return undefined;
  return `${exit.agentId}:${exit.marketId}:${exit.optionId ?? ""}`;
}

function filterDuplicateFailedExits(exits: TradeInstructionView[]) {
  const successByKey = new Map<
    string,
    Array<{ time: number; notional?: number }>
  >();
  const suppressedIds = new Set<number>();

  for (const exit of exits) {
    const key = buildExitKey(exit);
    if (!key) continue;
    const status = normalizeStatus(exit.liveStatus);
    if (!isSuccessStatus(status)) continue;
    const time = Date.parse(exit.executedAt ?? exit.createdAt ?? "");
    if (!Number.isFinite(time)) continue;
    const bucket = successByKey.get(key);
    if (bucket) bucket.push({ time, notional: exit.notional });
    else successByKey.set(key, [{ time, notional: exit.notional }]);
  }

  const filtered = exits.filter((exit) => {
    const status = normalizeStatus(exit.liveStatus);
    if (!isFailureStatus(status)) return true;
    const key = buildExitKey(exit);
    if (!key) return true;
    const successes = successByKey.get(key);
    if (!successes || successes.length === 0) return true;
    const time = Date.parse(exit.executedAt ?? exit.createdAt ?? "");
    if (!Number.isFinite(time)) return true;
    const notional = typeof exit.notional === "number" ? exit.notional : null;
    const matched = successes.some(
      ({ time: succTime, notional: succNotional }) => {
        if (succTime > time) return false; // require success to have happened already
        if (time - succTime > EXIT_DUPLICATE_WINDOW_MS) return false;
        if (notional == null || typeof succNotional !== "number") return true;
        const tolerance = Math.max(
          1e-6,
          Math.min(notional, succNotional) * 0.001,
        );
        return Math.abs(notional - succNotional) <= tolerance;
      },
    );
    if (matched && typeof exit.id === "number") {
      suppressedIds.add(exit.id);
    }
    return !matched;
  });

  return { filtered, suppressedIds };
}

export function buildActivityItems(
  data: DashboardData,
  now: number,
  openOrderKeys: Set<string>,
): ActivityItem[] {
  const decisions: ActivityItem[] = data.planDecisions.map((d) => ({
    id: `d:${d.id}`,
    time: d.createdAt,
    type: "decision",
    status: d.status,
    marketId: d.marketId,
    marketTitle: d.marketTitle,
    marketUrl: d.marketUrl,
    outcomeId: d.outcomeId,
    outcomeName: d.outcomeName,
    rationale: d.reason ?? "",
    action: d.status.toUpperCase(),
    source: (d.reason ?? "").startsWith("monitor") ? "monitor" : "planner",
    agentId: d.agentId,
  }));
  const orders: ActivityItem[] = data.trades.map((t: any) => {
    const key = `${t.agentId}:${t.marketId}:${t.optionId}:${t.direction.toUpperCase()}`;
    const createdMs = Date.parse(t.createdAt);
    const NS_TTL_MS = 15000;
    const isPending =
      (typeof t.liveStatus === "string" &&
        t.liveStatus.toLowerCase() === "open") ||
      openOrderKeys.has(key);
    const isNotSubmitted =
      !isPending &&
      !t.liveOrderId &&
      Number.isFinite(createdMs) &&
      now - createdMs > NS_TTL_MS;
    return {
      id: `t:${t.id}`,
      time: t.createdAt,
      type: "order",
      marketId: t.marketId,
      marketTitle: t.marketTitle,
      outcomeId: t.optionId,
      outcomeName: t.outcomeName,
      rationale: t.reason,
      notional: t.notional,
      price: t.expectedPrice,
      action: t.direction.toUpperCase(),
      agentId: t.agentId,
      marketUrl: t.marketUrl,
      citations: t.citations,
      source: (t.reason || "").toLowerCase().includes("monitor")
        ? "monitor"
        : (t.reason || "").toLowerCase().includes("capacity")
          ? "planner"
          : undefined,
      pending: isPending,
      status: t.liveStatus ?? (isNotSubmitted ? "not_submitted" : undefined),
      notSubmitted: isNotSubmitted,
    } as ActivityItem;
  });
  const { filtered: dedupedExits, suppressedIds } =
    filterDuplicateFailedExits(data.exits);
  const exits: ActivityItem[] = dedupedExits.map((x: any) => {
    const key = `${x.agentId}:${x.marketId}:${x.optionId}:${(x.direction || "").toUpperCase()}`;
    const createdMs = Date.parse(x.createdAt);
    const NS_TTL_MS = 15000;
    const isPending =
      (typeof x.liveStatus === "string" &&
        x.liveStatus.toLowerCase() === "open") ||
      openOrderKeys.has(key);
    const isNotSubmitted =
      !isPending &&
      !x.liveOrderId &&
      Number.isFinite(createdMs) &&
      now - createdMs > NS_TTL_MS;
    const pnlValue =
      typeof x.pnl === "number"
        ? x.pnl
        : typeof x.realizedPnlForPosition === "number"
          ? x.realizedPnlForPosition
          : undefined;
    return {
      id: `x:${x.id}`,
      time: x.executedAt ?? x.createdAt,
      type: "exit",
      marketId: x.marketId,
      marketTitle: x.marketTitle,
      outcomeId: x.optionId,
      outcomeName: x.outcomeName,
      rationale: x.reason,
      notional: x.notional,
      price: x.expectedPrice,
      action: x.direction.toUpperCase(),
      agentId: x.agentId,
      marketUrl: x.marketUrl,
      citations: x.citations,
      pnl: pnlValue,
      source: (x.reason || "").toLowerCase().includes("monitor")
        ? "monitor"
        : undefined,
      pending: isPending,
      status: x.liveStatus ?? (isNotSubmitted ? "not_submitted" : undefined),
      notSubmitted: isNotSubmitted,
    } as ActivityItem;
  });
  const exitIndex = new Map<string, number[]>();
  for (const e of exits) {
    if (!e.agentId || !e.marketId) continue;
    const key = `${e.agentId}:${e.marketId}:${e.outcomeId ?? ""}`;
    const tMs = Date.parse(e.time as any);
    if (!Number.isFinite(tMs)) continue;
    const arr = exitIndex.get(key);
    if (arr) arr.push(tMs);
    else exitIndex.set(key, [tMs]);
  }

  const fills: ActivityItem[] = data.fills
    .map((f) => {
      const liveKey = (() => {
        const tid = (f as any)?.metadata?.tradeId as string | undefined;
        const taker = (f as any)?.metadata?.takerOrderId as
          | string
          | undefined;
        if (typeof f.id === "number" && f.id > 0) return `f:${f.id}`;
        if (tid) return `lf:tid:${tid}`;
        if (taker) return `lf:to:${taker}`;
        return `lf:${f.agentId}:${f.marketId}:${f.optionId}:${f.createdAt}`;
      })();
      return {
        id: liveKey,
        time: f.createdAt,
        type: "fill",
        marketId: f.marketId,
        marketTitle: f.marketTitle,
        outcomeId: f.optionId,
        outcomeName: f.outcomeName,
        rationale: f.tradeRationale ?? "",
        notional: f.notional,
        price: f.fillPrice,
        parentId: f.tradeInstructionId,
        pnl: f.pnl,
        action: f.direction.toUpperCase(),
        agentId: f.agentId,
        citations: f.citations,
      } as ActivityItem;
    })
    .filter((it) => {
      if (!it.agentId || !it.marketId) return true;
      if (String(it.action ?? "").toUpperCase() !== "SELL") return true;
      const key = `${it.agentId}:${it.marketId}:${it.outcomeId ?? ""}`;
      const exitsForKey = exitIndex.get(key);
      if (!exitsForKey || exitsForKey.length === 0) return true;
      const tMs = Date.parse(it.time as any);
      if (!Number.isFinite(tMs)) return true;
      const WINDOW_MS = 90 * 1000;
      return !exitsForKey.some((eMs) => Math.abs(eMs - tMs) <= WINDOW_MS);
    });

  const exitIds = new Set<number>([
    ...suppressedIds,
    ...exits.map((e) => Number(String(e.id).split(":")[1])),
  ]);
  const instruct: ActivityItem[] = [
    ...exits,
    ...orders.filter((o) => !exitIds.has(Number(String(o.id).split(":")[1]))),
  ];
  const all: ActivityItem[] = [...fills, ...instruct, ...decisions];
  all.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
  return all;
}
