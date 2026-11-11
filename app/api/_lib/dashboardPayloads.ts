"use server";

import type { AgentsConfig, RuntimeConfig, AgentDefinition } from "../../../src/config/schema";
import type { AgentRepositoryAsync } from "../../../src/storage/types";
import type { PortfolioView, PositionView } from "../../../src/types/dashboard";
import { enrichMarketOutcomeLabels } from "./enrich";
import { attachRealizedPnlToExits } from "../../../src/server/exitsPnl";
import { ensureOrdersRefresher } from "./ordersRefresher";
import { ensureExecutionInfo, isNumericExit } from "../../../src/server/liveExecution";
import { getCachedLiveTrades } from "../../../src/server/liveTradesCache";
import { ensureMarksRefresher, refreshMarksNow } from "./marksRefresher";
import { getLiveSnapshot } from "./liveSnapshots";
import { createClobClientForAgent } from "../../../src/clients/polymarket_live";
import { deriveEffectiveTargets } from "../../../src/agent/pipeline/targets";
import { getLiveAccountSnapshot } from "../../../src/server/liveAccount";

let lastPruneAt: number | null = null;

async function buildLivePortfolioFromAccountSnapshot({
  agent,
  runtime,
  repo,
  titleMap,
  nameMap,
  urlMap,
  marks,
  lastEntryMap,
  fallbackCash,
  baseCurrency,
  baselineEquity,
}: {
  agent: AgentDefinition;
  runtime: RuntimeConfig;
  repo: AgentRepositoryAsync;
  titleMap: Map<string, string>;
  nameMap: Map<string, string>;
  urlMap: Map<string, string>;
  marks: Map<string, { markedAt?: Date; bestBid?: number; bestAsk?: number }>;
  lastEntryMap: Map<string, { tp?: number; sl?: number; exp?: number; at: string }>;
  fallbackCash: number;
  baseCurrency: string;
  baselineEquity?: number;
}): Promise<PortfolioView> {
  const live = await getLiveAccountSnapshot(agent, runtime, {
    tradesLimit: 300,
    includeOrders: false,
    deepClosed: true,
  });
  const minQty = Math.max(0, runtime.ui?.minOpenQuantity ?? 0.01);
  const filterSmall = Boolean(runtime.ui?.filterSmallPositions ?? true);
  const lastTradeMs = new Map<string, number>();
  for (const trade of live.trades ?? []) {
    const ts = Date.parse((trade as any)?.matchTime ?? '');
    if (Number.isFinite(ts)) {
      lastTradeMs.set(trade.tokenId, Math.max(lastTradeMs.get(trade.tokenId) ?? 0, ts));
    }
  }
  const feeForToken = (tokenId: string) => {
    try {
      let sum = 0;
      for (const t of live.trades ?? []) {
        if (t.tokenId !== tokenId) continue;
        const notional = (t.price as number) * (t.size as number);
        const bps = typeof (t as any).feeRateBps === 'number' ? (t as any).feeRateBps : 0;
        sum += Math.abs(notional) * bps / 10000;
      }
      return sum;
    } catch {
      return undefined;
    }
  };

  try {
    const closedRows =
      live.closedPositions?.map((p) => ({
        marketId: p.marketId,
        optionId: p.tokenId,
        quantity: p.quantity,
        averagePrice: p.averagePrice,
        exitPrice: p.exitPrice,
        realizedPnl: p.realizedPnlForPosition ?? 0,
        feesPaid: (p as any)?.feesPaid ?? 0,
        closedAt: p.closedAt,
      })) ?? [];
    if (closedRows.length > 0) {
      await repo.recordClosedPositions(agent.id, closedRows);
    }
  } catch {
    // best-effort only
  }

  const buildEntryTargetInput = (marketId: string, optionId: string, avg?: number) => {
    const entry = lastEntryMap.get(`${marketId}:${optionId}`);
    const expected =
      typeof entry?.exp === 'number'
        ? entry.exp
        : typeof avg === 'number' && avg > 0
          ? avg
          : undefined;
    if (
      typeof expected === "number" ||
      typeof entry?.tp === "number" ||
      typeof entry?.sl === "number"
    ) {
      return {
        expectedPrice: expected,
        takeProfitPrice: entry?.tp,
        stopPrice: entry?.sl,
      };
    }
    return undefined;
  };

  const liveOpenRaw = (live.openPositions ?? []).map((p) => {
    const eff = deriveEffectiveTargets(
      buildEntryTargetInput(p.marketId, p.tokenId, p.averagePrice),
      runtime as any,
    );
    const markKey = `${p.marketId}:${p.tokenId}`;
    return {
      marketId: p.marketId,
      optionId: p.tokenId,
      status: 'open',
      quantity: p.quantity,
      averagePrice: p.averagePrice,
      marketTitle: titleMap.get(p.marketId),
      marketUrl: urlMap.get(p.marketId),
      outcomeName: nameMap.get(markKey),
      bestBid: p.bestBid,
      bestAsk: p.bestAsk,
      updatedAt: (() => {
        const ms = lastTradeMs.get(p.tokenId);
        return typeof ms === 'number' && ms > 0 ? new Date(ms).toISOString() : undefined;
      })(),
      lastMarkedAt: marks.get(markKey)?.markedAt?.toISOString(),
      tpPrice: eff.tpEff,
      slPrice: eff.slEff,
      tpPriceOrig: eff.tpOrig,
      slPriceOrig: eff.slOrig,
      feesPaid: feeForToken(p.tokenId),
    } as PositionView;
  });

  for (const row of liveOpenRaw) {
    if (row.marketTitle && row.outcomeName) continue;
    try {
      const idx = await repo.getOutcomeIndexByClobTokenId(row.marketId, row.optionId);
      const ev = await repo.getLatestEvaluationSummary(row.marketId);
      if (!row.marketTitle && ev) row.marketTitle = ev.title;
      if (!row.outcomeName && typeof idx === 'number' && ev?.outcomes?.[idx]) {
        row.outcomeName = ev.outcomes[idx].name;
      }
    } catch {}
  }
  const liveOpen = filterSmall ? liveOpenRaw.filter((p) => p.quantity >= minQty) : liveOpenRaw;

  const positions = [...liveOpen];
  const cashBalance = typeof live.balance === 'number' ? live.balance : fallbackCash;
  const liveUnreal = (live.openPositions ?? []).reduce((acc, p) => {
    const mark =
      typeof p.bestBid === 'number'
        ? p.bestBid
        : typeof p.bestAsk === 'number'
          ? p.bestAsk
          : p.averagePrice;
    return acc + (mark - p.averagePrice) * p.quantity;
  }, 0);
  const liveRealized = await repo.getTotalRealizedPnlFromClosed(agent.id);
  const equity =
    cashBalance +
    (live.openPositions ?? []).reduce(
      (acc, p) => acc + (typeof (p as any).mtm === 'number' ? (p as any).mtm : 0),
      0,
    );

  return {
    agentId: agent.id,
    cashBalance,
    reservedBalance: 0,
    baseCurrency,
    realizedPnl: liveRealized,
    positions,
    unrealizedPnl: liveUnreal,
    equity,
    baselineEquity:
      typeof baselineEquity === 'number'
        ? baselineEquity
        : equity,
  };
}

export async function buildMarketsPayload({
  runtime,
  repo,
  limit,
  agentId,
  verbose,
}: {
  runtime: RuntimeConfig;
  repo: AgentRepositoryAsync;
  limit: number;
  agentId?: string;
  verbose?: boolean;
}) {
  try {
    const now = Date.now();
    if (!lastPruneAt || now - lastPruneAt > 15 * 60 * 1000) {
      const ret = runtime.evaluations?.retention ?? { prefilteredDays: 7, failedDays: 7 };
      const cutoffPref = new Date(now - (ret.prefilteredDays ?? 7) * 86400 * 1000).toISOString();
      const cutoffFail = new Date(now - (ret.failedDays ?? 7) * 86400 * 1000).toISOString();
      if ((runtime.evaluations?.persist?.prefiltered ?? true) !== false) {
        await repo.pruneEvaluationsByStatusBefore('rejected_prefilter', cutoffPref);
      }
      if ((runtime.evaluations?.persist?.failed ?? true) !== false) {
        const failStatuses = ['rejected_ai_error', 'rejected_balance', 'rejected_cooldown', 'rejected_policy', 'rejected_other'];
        for (const st of failStatuses) await repo.pruneEvaluationsByStatusBefore(st, cutoffFail);
      }
      lastPruneAt = now;
    }
  } catch {}

  const includePref = runtime.evaluations?.ui?.includePrefiltered ?? true;
  const includeFailed = runtime.evaluations?.ui?.includeFailed ?? true;
  const rows = await repo.listRecentMarketEvaluations(limit, agentId);
  const filtered = rows.filter((r: any) => {
    const st = (r.status as string | undefined) ?? undefined;
    if (st === 'rejected_prefilter' && !includePref) return false;
    if (st && st !== 'accepted' && st !== 'rejected_prefilter' && !includeFailed) return false;
    return true;
  });
  return verbose
    ? filtered.map((r: any) => ({ ...r }))
    : filtered.map((r: any) => {
        let url: string | undefined = undefined;
        if (Array.isArray(r.debugMarketPayload)) {
          const entry = r.debugMarketPayload.find((x: any) => x && (x.url || x.slug));
          if (entry) {
            url = entry.url || (entry.slug ? `https://polymarket.com/market/${entry.slug}` : undefined);
          }
        }
        return {
          id: r.id,
          runId: r.runId,
          agentId: r.agentId,
          marketId: r.marketId,
          title: r.title,
          outcomes: r.outcomes,
          currentPrices: r.currentPrices,
          quickSummary: r.quickSummary,
          trade: r.trade,
          status: r.status,
          riskNotes: r.riskNotes,
          createdAt: r.createdAt,
          url,
          citations: r.citations,
        };
      });
}

export async function buildPlanDecisionsPayload({
  repo,
  limit,
  agentId,
  verbose,
}: {
  repo: AgentRepositoryAsync;
  limit: number;
  agentId?: string;
  verbose?: boolean;
}) {
  const decisions = await repo.listRecentPlanDecisions(limit, agentId);
  const labeled = await enrichMarketOutcomeLabels(repo as any, decisions, (d: any) => ({
    marketId: d.marketId,
    evaluationOutcomeId: d.outcomeId ?? undefined,
  }));
  return labeled.map((d: any) => {
    const base: any = {
      id: d.id,
      evaluationId: d.evaluationId,
      agentId: d.agentId,
      marketId: d.marketId,
      outcomeId: d.outcomeId,
      status: d.status,
      reason: d.reason,
      tradeRationale: d.tradeRationale,
      createdAt: d.createdAt,
      outcomeName: d.outcomeName,
      marketTitle: d.marketTitle,
      marketUrl: d.marketUrl,
    };
    if (verbose && d.debug) base.debug = d.debug;
    return base;
  });
}

export async function buildTradesPayload({
  runtime,
  repo,
  limit,
  agentId,
  agentsCfg,
}: {
  runtime: RuntimeConfig;
  repo: AgentRepositoryAsync;
  limit: number;
  agentId?: string;
  agentsCfg?: AgentsConfig;
}) {
  if (agentsCfg) {
    for (const a of agentsCfg.agents) {
      if (a.enabled) {
        try {
          ensureOrdersRefresher(a as any, runtime as any);
        } catch {}
      }
    }
  }
  const trades = await repo.listRecentTradeInstructions(limit, agentId);
  const base = await Promise.all(
    trades.map(async (t: any) => {
      const numeric = isNumericExit(t.direction, t.reason ?? '');
      const latestCites = numeric
        ? undefined
        : await repo.getLatestDecisionCitations(t.agentId, t.marketId, t.optionId);

      let executedAt: string | undefined = t.executedAt;
      let liveStatus: string | undefined = t.liveStatus;
      if (agentsCfg) {
        const agent = agentsCfg.agents.find((a) => a.id === t.agentId);
        if (agent && agent.enabled && agent.paperTrading === false) {
          try {
            const execInfo = await ensureExecutionInfo({
              repo: repo as any,
              agent: agent as any,
              runtime: runtime as any,
              instructionId: t.id,
              marketId: t.marketId,
              optionId: t.optionId,
              direction: t.direction,
              liveOrderId: t.liveOrderId,
              createdAt: t.createdAt,
              status: t.liveStatus,
              executedAt: t.executedAt,
            });
            executedAt = execInfo.executedAt ?? executedAt;
            liveStatus = execInfo.status ?? liveStatus;
          } catch {}
        }
      }

      return {
        ...t,
        citations: latestCites?.citations,
        liveOrderId: t.liveOrderId,
        liveStatus,
        executedAt,
      };
    }),
  );

  return enrichMarketOutcomeLabels(repo as any, base, (t: any) => ({
    marketId: t.marketId,
    evaluationOutcomeId: t.optionId,
    clobTokenId: t.optionId,
  }));
}

export async function buildExitsPayload({
  runtime,
  repo,
  limit,
  agentId,
  agentsCfg,
}: {
  runtime: RuntimeConfig;
  repo: AgentRepositoryAsync;
  limit: number;
  agentId?: string;
  agentsCfg?: AgentsConfig;
}) {
  const exits = await repo.listRecentExits(limit, agentId);
  const base = await Promise.all(
    exits.map(async (x: any) => {
      const numeric = isNumericExit(x.direction, String(x.reason ?? ''));
      const latestCites = numeric
        ? undefined
        : await repo.getLatestDecisionCitations(x.agentId, x.marketId, x.optionId);

      let executedAt: string | undefined = x.executedAt;
      let liveStatus: string | undefined = x.liveStatus;
      if (agentsCfg) {
        const agent = agentsCfg.agents.find((a) => a.id === x.agentId);
        if (agent && agent.enabled && agent.paperTrading === false) {
          try {
            const info = await ensureExecutionInfo({
              repo: repo as any,
              agent: agent as any,
              runtime: runtime as any,
              instructionId: x.id,
              marketId: x.marketId,
              optionId: x.optionId,
              direction: x.direction,
              liveOrderId: x.liveOrderId,
              createdAt: x.createdAt,
              status: x.liveStatus,
              executedAt: x.executedAt,
            });
            executedAt = info.executedAt ?? executedAt;
            liveStatus = info.status ?? liveStatus;
          } catch {}
        }
      }

      return {
        ...x,
        citations: latestCites?.citations,
        executedAt,
        liveStatus,
      };
    }),
  );
  const agentsById =
    agentsCfg && agentsCfg.agents
      ? new Map(agentsCfg.agents.map((a) => [a.id, a]))
      : undefined;
  const withPnl = await attachRealizedPnlToExits(repo as any, base, {
    closedRowsLimit: limit * 2,
    agentsById,
    tradesTtlMs: (runtime.http as any)?.memoize?.clobTradesTtlMs,
  });

  return enrichMarketOutcomeLabels(repo as any, withPnl, (x: any) => ({
    marketId: x.marketId,
    evaluationOutcomeId: x.optionId,
    clobTokenId: x.optionId,
  }));
}

export async function buildFillsPayload({
  runtime,
  repo,
  agentsCfg,
  limit,
  agentId,
}: {
  runtime: RuntimeConfig;
  repo: AgentRepositoryAsync;
  agentsCfg: AgentsConfig;
  limit: number;
  agentId?: string;
}) {
  const effLimit = limit > 0 ? limit : 100;
  const agent = agentId ? agentsCfg.agents.find((a) => a.id === agentId) : undefined;
  let fills: any[] = [];
  if (agentId) {
    if (agent && agent.enabled && agent.paperTrading === false) {
      try {
        const trades = await getCachedLiveTrades(agent as any, Math.max(1, effLimit || 100), {
          ttlMs: (runtime.http as any)?.memoize?.clobTradesTtlMs,
        });
        fills = trades.map((t) => {
          const notional = t.price * t.size;
          const feeAmount =
            typeof t.feeRateBps === 'number'
              ? (Math.abs(notional) * t.feeRateBps) / 10000
              : undefined;
          return {
            id: 0,
            tradeInstructionId: 0,
            agentId: agent.id,
            marketId: t.marketId,
            optionId: t.tokenId,
            direction: t.side,
            quantity: t.size,
            fillPrice: t.price,
            notional,
            pnl: 0,
            createdAt: t.matchTime,
            feeAmount,
            metadata: { tradeId: t.id, takerOrderId: t.takerOrderId },
          };
        });
      } catch {
        fills = [];
      }
    } else {
      fills = await repo.listRecentFills(limit, agentId);
    }
  } else {
    const rows: any[] = [];
    for (const a of agentsCfg.agents) {
      if (!a.enabled) continue;
      if (a.paperTrading === false) {
        try {
          const trades = await getCachedLiveTrades(a as any, Math.max(1, effLimit || 100), {
            ttlMs: (runtime.http as any)?.memoize?.clobTradesTtlMs,
          });
          for (const t of trades) {
            const notional = t.price * t.size;
            const feeAmount =
              typeof t.feeRateBps === 'number'
                ? (Math.abs(notional) * t.feeRateBps) / 10000
                : undefined;
            rows.push({
              id: 0,
              tradeInstructionId: 0,
              agentId: a.id,
              marketId: t.marketId,
              optionId: t.tokenId,
              direction: t.side,
              quantity: t.size,
              fillPrice: t.price,
              notional,
              pnl: 0,
              createdAt: t.matchTime,
              feeAmount,
              metadata: { tradeId: t.id, takerOrderId: t.takerOrderId },
            });
          }
        } catch {}
      } else {
        try {
          const dbFills = await repo.listRecentFills(limit, a.id);
          rows.push(...dbFills);
        } catch {}
      }
    }
    rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    fills = rows.slice(0, effLimit);
  }

  const base = await Promise.all(
    fills.map(async (f) => {
      const dir = String((f as any)?.direction ?? '').toLowerCase();
      let tradeRationale: string | undefined;
      if (dir === 'sell') {
        try {
          const createdMs = Date.parse(f.createdAt as any);
          if (Number.isFinite(createdMs) && typeof (repo as any).listRecentTradeInstructions === 'function') {
            const recent: any[] = await (repo as any).listRecentTradeInstructions(200, f.agentId);
            let best: any | undefined;
            for (const t of recent) {
              if (String(t.direction).toLowerCase() !== 'sell') continue;
              if (t.marketId !== f.marketId || t.optionId !== f.optionId) continue;
              const tMs = Date.parse(t.createdAt as any);
              if (!Number.isFinite(tMs) || tMs > createdMs + 1000) continue;
              if (!best || tMs > Date.parse(best.createdAt as any)) {
                best = t;
              }
            }
            if (best && typeof best.reason === 'string') {
              tradeRationale = best.reason;
            }
          }
        } catch {}
      }
      if (!tradeRationale) {
        const latest = await repo.getLatestTradeRationale(f.agentId, f.marketId, f.optionId);
        tradeRationale = latest?.tradeRationale;
      }
      const latestCites = await repo.getLatestDecisionCitations(f.agentId, f.marketId, f.optionId);
      return {
        ...f,
        tradeRationale,
        citations: latestCites?.citations,
      };
    }),
  );

  return enrichMarketOutcomeLabels(repo as any, base, (f: any) => ({
    marketId: f.marketId,
    evaluationOutcomeId: f.optionId,
    clobTokenId: f.optionId,
  }));
}

export async function buildPortfoliosPayload({
  repo,
  runtime,
  agentsCfg,
  debugFlag,
}: {
  repo: AgentRepositoryAsync;
  runtime: RuntimeConfig;
  agentsCfg: AgentsConfig;
  debugFlag: boolean;
}) {
  const results: Array<{ agentId: string; portfolio: PortfolioView }> = [];
  for (const agent of agentsCfg.agents) {
    if (!agent.enabled) continue;

    if (agent.paperTrading !== false) {
      try {
        ensureMarksRefresher(agent.id, runtime);
      } catch {}
      try {
        const marks = await repo.getPositionMarks(agent.id);
        const now = Date.now();
        const maxAgeMs = (runtime.marksRefresher?.maxStalenessMinutes ?? 1) * 60 * 1000;
        let stale = false;
        for (const m of marks.values()) {
          if (!m.markedAt || now - m.markedAt.getTime() > maxAgeMs) {
            stale = true;
            break;
          }
        }
        if (stale) await refreshMarksNow(agent.id, runtime);
      } catch {}
    } else if ((runtime.marksRefresher?.writer ?? 'server') === 'server') {
      try {
        ensureMarksRefresher(agent.id, runtime);
      } catch {}
    }

    const snapshot = await repo.buildPortfolioSnapshot(
      agent.id,
      runtime.portfolio?.baseCurrency ?? "USDC",
      runtime.portfolio?.initialBalance ?? 0,
    );
    let baselineEquity: number | undefined;
    try {
      const baselineRow = await repo.getEarliestPortfolioHistory(agent.id);
      if (baselineRow && typeof baselineRow.equity === 'number') {
        baselineEquity = baselineRow.equity;
      }
    } catch {}
    const evals = await repo.listRecentMarketEvaluations(200, agent.id);
    const nameMap = new Map<string, string>();
    const titleMap = new Map<string, string>();
    const urlMap = new Map<string, string>();
    for (const e of evals) {
      titleMap.set(e.marketId, e.title);
      const u = Array.isArray(e.debugMarketPayload)
        ? (e.debugMarketPayload.find((x: any) => x && x.url)?.url as string | undefined)
        : undefined;
      if (u) urlMap.set(e.marketId, u);
      const outcomes = Array.isArray(e.outcomes) ? e.outcomes : [];
      for (const o of outcomes as Array<{ id: string; name: string }>) {
        if (o && o.id && o.name) nameMap.set(`${e.marketId}:${o.id}`, o.name);
      }
    }
    const marks = await repo.getPositionMarks(agent.id);
    const recentTrades = await repo.listRecentTradeInstructions(200, agent.id);
    const lastEntryMap = new Map<string, { tp?: number; sl?: number; exp?: number; at: string }>();
    for (const t of recentTrades) {
      if (t.direction !== 'buy') continue;
      const key = `${t.marketId}:${t.optionId}`;
      const prev = lastEntryMap.get(key);
      if (!prev || new Date(t.createdAt) > new Date(prev.at)) {
        lastEntryMap.set(key, { tp: t.takeProfitPrice, sl: t.stopPrice, exp: t.expectedPrice, at: t.createdAt });
      }
    }

    const deriveEffective = (entry?: { tp?: number; sl?: number; exp?: number }, avg?: number) => {
      const expected =
        typeof entry?.exp === 'number'
          ? entry.exp
          : typeof avg === 'number' && avg > 0
            ? avg
            : undefined;
      const hasTargets =
        typeof expected === 'number' ||
        typeof entry?.tp === 'number' ||
        typeof entry?.sl === 'number';
      const res = deriveEffectiveTargets(
        hasTargets
          ? {
              expectedPrice: expected,
              takeProfitPrice: entry?.tp,
              stopPrice: entry?.sl,
            }
          : undefined,
        runtime as any,
      );
      return {
        tpPrice: res.tpEff,
        slPrice: res.slEff,
        tpPriceOrig: res.tpOrig,
        slPriceOrig: res.slOrig,
      };
    };

    const isLive = agent.paperTrading === false;
    let enriched: PortfolioView | null = null;

    const mapSnapshotPosition = (p: any): PositionView => {
      const m = marks.get(`${p.marketId}:${p.optionId}`);
      return {
        marketId: p.marketId,
        optionId: p.optionId,
        status: p.status,
        quantity: p.quantity,
        averagePrice: p.averagePrice,
        bestBid: m?.bestBid,
        bestAsk: m?.bestAsk,
        marketTitle: titleMap.get(p.marketId),
        marketUrl: urlMap.get(p.marketId),
        outcomeName: nameMap.get(`${p.marketId}:${p.optionId}`),
        lastMarkedAt:
          m?.markedAt?.toISOString() ??
          (p.updatedAt instanceof Date ? p.updatedAt.toISOString() : undefined),
        ...deriveEffective(lastEntryMap.get(`${p.marketId}:${p.optionId}`), p.averagePrice),
      };
    };

    const paperPositions = (snapshot.positions ?? [])
      .filter((p: any) => !p.status || p.status === 'open')
      .map(mapSnapshotPosition);
    const paperEquity =
      snapshot.cashBalance +
      paperPositions.reduce((acc, p) => {
        const mark = typeof p.bestBid === 'number' ? p.bestBid : p.averagePrice;
        return acc + mark * p.quantity;
      }, 0);

    if (isLive) {
      const realizedTotal = await repo.getTotalRealizedPnlFromClosed(agent.id);
      try {
        const row = await getLiveSnapshot(agent.id);
        const maxAgeMs = (runtime.marksRefresher?.maxStalenessMinutes ?? 1) * 60 * 1000;
        if (row && Date.now() - new Date(row.updatedAt).getTime() <= maxAgeMs && typeof row.cashBalance === 'number') {
          const minQty = Math.max(0, runtime.ui?.minOpenQuantity ?? 0.01);
          const filterSmall = Boolean(runtime.ui?.filterSmallPositions ?? true);
          const feeForToken = (tokenId: string) => {
            try {
              let sum = 0;
              for (const t of ((row as any)?.trades ?? [])) {
                if ((t as any).tokenId !== tokenId) continue;
                const notional = (t as any).price * (t as any).size;
                const bps = typeof (t as any).feeRateBps === 'number' ? t.feeRateBps : 0;
                sum += Math.abs(notional) * bps / 10000;
              }
              return sum;
            } catch {
              return undefined;
            }
          };
          const open = (row.positionsOpen ?? []).map((p: any) => ({
            marketId: p.marketId,
            optionId: p.optionId,
            status: 'open',
            quantity: p.quantity,
            averagePrice: p.averagePrice,
            bestBid: p.bestBid,
            bestAsk: p.bestAsk,
            feesPaid: feeForToken(p.optionId),
            marketTitle: titleMap.get(p.marketId),
            marketUrl: urlMap.get(p.marketId),
            outcomeName: nameMap.get(`${p.marketId}:${p.optionId}`),
            lastMarkedAt:
              marks.get(`${p.marketId}:${p.optionId}`)?.markedAt?.toISOString() ||
              p.lastMarkedAt,
            ...deriveEffective(lastEntryMap.get(`${p.marketId}:${p.optionId}`), p.averagePrice),
          }));
          const openFiltered = filterSmall ? open.filter((p) => p.quantity >= minQty) : open;
          const visibleOpen = filterSmall ? openFiltered : open;
          const liveUnreal = visibleOpen.reduce((acc, p) => {
            const mark =
              typeof p.bestBid === 'number'
                ? p.bestBid
                : typeof p.bestAsk === 'number'
                  ? p.bestAsk
                  : p.averagePrice;
            return acc + (mark - p.averagePrice) * p.quantity;
          }, 0);
          const openValue = visibleOpen.reduce((acc, p) => {
            const mark =
              typeof p.bestBid === 'number'
                ? p.bestBid
                : typeof p.bestAsk === 'number'
                  ? p.bestAsk
                  : p.averagePrice;
            return acc + mark * p.quantity;
          }, 0);
          enriched = {
            agentId: agent.id,
            cashBalance: row.cashBalance,
            reservedBalance: 0,
            baseCurrency: snapshot.baseCurrency,
            realizedPnl: realizedTotal,
            unrealizedPnl: liveUnreal,
            positions: visibleOpen,
            equity:
              typeof row.equity === 'number'
                ? row.equity
                : row.cashBalance + openValue,
            baselineEquity:
              typeof baselineEquity === 'number'
                ? baselineEquity
                : typeof row.equity === 'number'
                  ? row.equity
                  : row.cashBalance + openValue,
          };
        } else {
          throw new Error('stale');
        }
      } catch {
        try {
          enriched = await buildLivePortfolioFromAccountSnapshot({
            agent,
            runtime,
            repo,
            titleMap,
            nameMap,
            urlMap,
            marks,
            lastEntryMap,
            fallbackCash: snapshot.cashBalance,
            baseCurrency: snapshot.baseCurrency,
            baselineEquity,
          });
        } catch {
          continue;
        }
      }
    } else {
      enriched = {
        agentId: agent.id,
        cashBalance: snapshot.cashBalance,
        reservedBalance: snapshot.reservedBalance,
        baseCurrency: snapshot.baseCurrency,
        realizedPnl: snapshot.realizedPnl,
        positions: paperPositions,
        unrealizedPnl: snapshot.unrealizedPnl,
        equity: paperEquity,
        baselineEquity:
          typeof baselineEquity === 'number' ? baselineEquity : paperEquity,
      };
    }

    if (enriched) {
      results.push({ agentId: agent.id, portfolio: enriched });
    }
  }

  return results;
}

export async function buildOrdersPayload({
  runtime,
  agentsCfg,
  agentFilter,
}: {
  runtime: RuntimeConfig;
  agentsCfg: AgentsConfig;
  agentFilter?: string;
}) {
  const results: Array<{
    agentId: string;
    orders: Array<{ id: string; assetId: string; market: string; side: string; price: number; sizeRemaining: number; status: string; createdAt: number }>;
  }> = [];
  for (const a of agentsCfg.agents) {
    if (!a.enabled) continue;
    if (agentFilter && a.id !== agentFilter) continue;
    try {
      ensureOrdersRefresher(a as any, runtime as any);
    } catch {}
    try {
      const live = createClobClientForAgent(a as AgentDefinition);
      if (!live) {
        results.push({ agentId: a.id, orders: [] });
        continue;
      }
      const data = await live.client.getOpenOrders();
      const mapped = (data ?? []).map((o: any) => ({
        id: String(o.id),
        assetId: String(o.asset_id),
        market: String(o.market),
        side: String(o.side),
        price: Number(o.price),
        sizeRemaining: (() => {
          const sr = Number(o.size_remaining);
          if (Number.isFinite(sr)) return Math.max(0, sr);
          return Math.max(0, Number(o.original_size ?? 0) - Number(o.size_matched ?? 0));
        })(),
        status: String(o.status ?? 'open'),
        createdAt: Number(o.created_at ?? Date.now()),
      }));
      results.push({ agentId: a.id, orders: mapped });
    } catch {
      results.push({ agentId: a.id, orders: [] });
    }
  }
  return results;
}
