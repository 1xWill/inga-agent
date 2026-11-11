import { createHttpClient } from '../../../src/http/client';
import { createPolymarketClient } from '../../../src/clients/polymarket';
import type { RuntimeConfig, AgentDefinition } from '../../../src/config/schema';
import { getRepository } from '../_lib/db';
import { loadAgentsConfig } from '../../../src/config/loaders';
import { getLiveAccountSnapshot } from '../../../src/server/liveAccount';
import { deriveEffectiveTargets } from '../../../src/agent/pipeline/targets';
import { PortfolioManagerLive } from '../../../src/agent/portfolio_live';
import { manageExits } from '../../../src/agent/pipeline/exits';
import { createClobClientForAgent } from '../../../src/clients/polymarket_live';
import { getLiveSnapshot } from './liveSnapshots';
import type { TradeDirection } from '../../../src/agent/types';

type Timer = ReturnType<typeof setInterval>;

const timers = new Map<string, Timer>();
let lastTick = 0;
const numericExitInFlight = new Map<string, Promise<void>>();

type PositionLike = {
  id?: number;
  agentId?: string;
  marketId: string;
  optionId: string | number;
  direction?: string;
  quantity: number;
  averagePrice: number;
  status?: string;
  openedAt: Date;
  updatedAt?: Date;
};

const posKey = (marketId: string | undefined, optionId: string | number | undefined) =>
  `${marketId ?? ''}:${optionId ?? ''}`;

async function loadLiveAwarePositions(params: {
  agentId: string;
  agent?: AgentDefinition;
  runtime: RuntimeConfig;
  repo: any;
  base?: PositionLike[];
  enforceMinQty?: boolean;
}): Promise<PositionLike[]> {
  const { agentId, agent, runtime, repo, base, enforceMinQty = true } = params;
  const minQty = Math.max(0, (runtime.ui as any)?.minOpenQuantity ?? 0.01);
  let positions: PositionLike[] =
    base && base.length > 0
      ? base
      : await (async () => {
          const arr: any[] = await repo.listOpenPositions(agentId);
          return arr.map((p) => ({
            ...p,
            openedAt: toDate(p.openedAt) ?? new Date(),
            updatedAt: toDate(p.updatedAt) ?? toDate(p.openedAt) ?? new Date(),
          }));
        })();

  if (agent && agent.enabled && agent.paperTrading === false) {
    try {
      const snapshot = await getLiveSnapshot(agent.id);
      const maxAgeMs = (runtime.marksRefresher?.maxStalenessMinutes ?? 1) * 60 * 1000;
      if (
        snapshot &&
        snapshot.positionsOpen &&
        Date.now() - new Date(snapshot.updatedAt).getTime() <= maxAgeMs
      ) {
        const merged = new Map<string, PositionLike>();
        for (const p of positions) {
          merged.set(posKey(p.marketId, p.optionId), p);
        }
        for (const raw of snapshot.positionsOpen as any[]) {
          if (!raw || !raw.marketId || !raw.optionId) continue;
          const key = posKey(raw.marketId, raw.optionId);
          const existing = merged.get(key);
          const openedAt =
            toDate(raw.openedAt) ??
            existing?.openedAt ??
            new Date(snapshot.updatedAt);
          const avg =
            typeof raw.averagePrice === 'number'
              ? raw.averagePrice
              : existing?.averagePrice ?? 0;
          const qty =
            typeof raw.quantity === 'number'
              ? raw.quantity
              : existing?.quantity ?? 0;
          merged.set(key, {
            ...(existing ?? {}),
            marketId: raw.marketId,
            optionId: raw.optionId,
            direction: existing?.direction ?? 'buy',
            status: 'open',
            quantity: qty,
            averagePrice: avg,
            openedAt,
            updatedAt: openedAt,
          });
        }
        positions = Array.from(merged.values());
      }
    } catch {
      // Snapshot unavailable; fall back to repo data only.
    }
  }

  return enforceMinQty ? positions.filter((p) => p.quantity >= minQty) : positions;
}

function toDate(input: unknown): Date | undefined {
  if (input instanceof Date) return input;
  if (typeof input === 'string' || typeof input === 'number') {
    const d = new Date(input);
    if (!isNaN(d.getTime())) return d;
  }
  return undefined;
}

async function shouldTriggerNumericExit(
  agent: AgentDefinition | undefined,
  runtime: RuntimeConfig,
  repo: any,
  seedPositions?: PositionLike[],
): Promise<boolean> {
  if (!agent || !agent.enabled || agent.paperTrading !== false) return false;
  if (!runtime?.execution?.live || runtime.execution.live.dryRun !== false) return false;
  if (numericExitInFlight.has(agent.id)) return false;
  if (!runtime?.exits) return false;
  const exits = runtime.exits;
  const positionsRaw =
    seedPositions ??
    (await loadLiveAwarePositions({
      agentId: agent.id,
      agent,
      runtime,
      repo,
    }));
  if (!positionsRaw || positionsRaw.length === 0) return false;
  const positions = positionsRaw;
  const marks = await repo.getPositionMarks(agent.id);
  const recentTrades: any[] = await repo.listRecentTradeInstructions(200, agent.id);
  const lastEntryMap = new Map<string, any>();
  for (const t of recentTrades) {
    if (t.direction !== 'buy') continue;
    const key = `${t.marketId}:${t.optionId}`;
    const createdAt = toDate(t.createdAt);
    if (!createdAt) continue;
    const prev = lastEntryMap.get(key);
    if (!prev || createdAt.getTime() > prev.createdAt.getTime()) {
      lastEntryMap.set(key, { createdAt, takeProfitPrice: t.takeProfitPrice, stopPrice: t.stopPrice, expectedPrice: t.expectedPrice });
    }
  }
  const now = Date.now();
  const priceFloor = exits.priceFloor ?? 0.0;
  const priceCeiling = exits.priceCeiling ?? 1.0;
  for (const pos of positions) {
    const openedAt = toDate(pos.openedAt);
    if (
      typeof exits.maxHoldingMinutes === 'number' &&
      exits.maxHoldingMinutes > 0 &&
      openedAt instanceof Date &&
      !isNaN(openedAt.getTime())
    ) {
      const heldMinutes = (now - openedAt.getTime()) / 60000;
      if (heldMinutes >= exits.maxHoldingMinutes) return true;
    }
    const key = `${pos.marketId}:${pos.optionId}`;
    const mark = marks.get(key);
    const bestBid = typeof mark?.bestBid === 'number' ? mark.bestBid : undefined;
    const bestAsk = typeof mark?.bestAsk === 'number' ? mark.bestAsk : undefined;
    let mid = typeof mark?.mid === 'number' ? mark.mid : undefined;
    if (typeof mid !== 'number' && typeof bestBid === 'number' && typeof bestAsk === 'number') {
      mid = (bestBid + bestAsk) / 2;
    }
    const basis = typeof bestBid === 'number' ? bestBid : undefined;
    if (typeof basis !== 'number') continue;
    if (basis < priceFloor || basis > priceCeiling) continue;
    let tpLevel: number | undefined;
    let slLevel: number | undefined;
    const lastEntry = lastEntryMap.get(key);
    if (lastEntry) {
      const eff = deriveEffectiveTargets(
        {
          expectedPrice: lastEntry.expectedPrice,
          takeProfitPrice: lastEntry.takeProfitPrice,
          stopPrice: lastEntry.stopPrice,
        },
        runtime as any,
      );
      tpLevel = eff.tpEff;
      slLevel = eff.slEff;
    } else {
      const avg = pos.averagePrice;
      if (typeof exits.takeProfitPct === 'number') {
        const rawTp = avg * (1 + exits.takeProfitPct);
        tpLevel = Math.min(priceCeiling, Math.max(priceFloor, rawTp));
      }
      if (typeof exits.stopLossPct === 'number') {
        const rawSl = avg * (1 - exits.stopLossPct);
        slLevel = Math.min(priceCeiling, Math.max(priceFloor, rawSl));
      }
    }
    if (typeof slLevel === 'number' && basis <= slLevel + 1e-9) return true;
    if (typeof tpLevel === 'number' && basis >= tpLevel - 1e-9) return true;
  }
  return false;
}

async function triggerNumericExit(agent: AgentDefinition, runtime: RuntimeConfig) {
  if (numericExitInFlight.has(agent.id)) return;
  if (!runtime?.execution?.live || runtime.execution.live.dryRun !== false) {
    if (process.env.NODE_ENV !== 'test') {
      console.warn(`[numeric-exit:${agent.id}] skipped (live trading disabled or dry-run)`);
    }
    return;
  }
  const liveTrading = createClobClientForAgent(agent as any);
  if (!liveTrading) {
    if (process.env.NODE_ENV !== 'test') {
      console.warn(`[numeric-exit:${agent.id}] skipped (missing live credentials)`);
    }
    return;
  }
  const promise = (async () => {
    try {
      const repo = await getRepository();
      const http = createHttpClient(runtime.http as any);
      const clobOv = (runtime.http as any)?.hostOverrides?.['clob.polymarket.com'];
      const polymarket = createPolymarketClient({
        httpClient: http,
        marketConfig: runtime.marketData,
        memoize: { orderBookTtlMs: (runtime.http as any)?.memoize?.clobOrderBookTtlMs, feeRateTtlMs: (runtime.http as any)?.memoize?.clobFeeRateTtlMs },
        concurrency: { maxConcurrent: clobOv?.maxConcurrent },
      });
      const state = await repo.getPortfolioState(
        agent.id,
        runtime.portfolio.baseCurrency,
        runtime.portfolio.initialBalance,
      );
      const seedPositions = await loadLiveAwarePositions({
        agentId: agent.id,
        agent,
        runtime,
        repo,
      });
      const normalizedSeedPositions = seedPositions.map((p) => {
        const openedAt =
          p.openedAt instanceof Date ? p.openedAt : toDate(p.openedAt) ?? new Date();
        const updatedAt =
          p.updatedAt instanceof Date
            ? p.updatedAt
            : p.updatedAt
              ? toDate(p.updatedAt)
              : openedAt;
        const dir: TradeDirection =
          String(p.direction ?? 'buy').toLowerCase() === 'sell' ? 'sell' : 'buy';
        const status: 'open' | 'closed' = p.status === 'closed' ? 'closed' : 'open';
        return {
          ...p,
          optionId: String(p.optionId),
          direction: dir,
          status,
          openedAt,
          updatedAt,
        };
      });
      const portfolio = new PortfolioManagerLive({
        agentId: agent.id,
        baseCurrency: runtime.portfolio.baseCurrency,
        initialCash: state?.cashBalance ?? runtime.portfolio.initialBalance,
        seedPositions: normalizedSeedPositions,
      });
      await manageExits({
        agentId: agent.id,
        runtime,
        repo,
        portfolio,
        polymarket,
        agent,
        liveTrading,
        seedPositions,
        log: (msg, data) => {
          if (process.env.NODE_ENV !== 'test') {
            // eslint-disable-next-line no-console
            console.log(`[numeric-exit:${agent.id}] ${msg}`, data ?? '');
          }
        },
      });
    } catch (err) {
      if (process.env.NODE_ENV !== 'test') {
        // eslint-disable-next-line no-console
        console.error(`[numeric-exit:${agent.id}] run failed`, {
          error: (err as Error)?.message ?? err,
        });
      }
    }
  })().finally(() => {
    numericExitInFlight.delete(agent.id);
  });
  numericExitInFlight.set(agent.id, promise);
}

async function refreshOnce(agentId: string, runtime: RuntimeConfig) {
  // Skip when order books are not requested in runtime config
  if (!runtime?.marketData?.includeOrderBooks) return;

  const repo = await getRepository();
  const http = createHttpClient(runtime.http);
  const polymarket = createPolymarketClient({
    httpClient: http,
    marketConfig: runtime.marketData,
    memoize: { orderBookTtlMs: (runtime.http as any)?.memoize?.clobOrderBookTtlMs, feeRateTtlMs: (runtime.http as any)?.memoize?.clobFeeRateTtlMs },
    concurrency: { maxConcurrent: (runtime.http as any)?.hostOverrides?.['clob.polymarket.com']?.maxConcurrent ?? 4 }
  });

  const agentsCfg = await loadAgentsConfig(process.cwd());
  const agentDef = agentsCfg.agents.find((a) => a.id === agentId);
  const skipSmall = Boolean((runtime.ui as any)?.skipSmallPositionMarks ?? true);
  let positions = await loadLiveAwarePositions({
    agentId,
    agent: agentDef,
    runtime,
    repo,
    base: await repo.listOpenPositions(agentId),
    enforceMinQty: skipSmall,
  });
  const minQty = Math.max(0, (runtime.ui as any)?.minOpenQuantity ?? 0.01);
  // If no DB positions but the agent is live, derive token set from live open positions
  if (positions.length === 0) {
    try {
      if (agentDef && agentDef.enabled && agentDef.paperTrading === false) {
        const live = await getLiveAccountSnapshot(agentDef as any, runtime, { tradesLimit: 300, includeOrders: false });
        const derived = (live.openPositions ?? []).map((p) => ({ agentId, marketId: p.marketId, optionId: p.tokenId, direction: 'buy', quantity: p.quantity, averagePrice: p.averagePrice, status: 'open' as const }));
        const arr = derived as any[];
        positions = skipSmall ? arr.filter((p) => p.quantity >= minQty) : (arr as any);
      }
    } catch {}
  }
  const exitPositions =
    positions.length > 0 ? positions.filter((p) => p.quantity >= minQty) : [];
  let ok = 0;
  let fail = 0;
  const failed: Array<{ marketId: string; optionId: string; reason: string }> = [];
  // Cache resolved/payout per slug in this tick to avoid repeated Gamma calls
  const payoutCache = new Map<string, { resolved: boolean; prices: number[] }>();
  const slugOf = async (marketId: string): Promise<string | undefined> => {
    try {
      const ev = await repo.getLatestEvaluationSummary(marketId);
      const url = (ev as any)?.url as string | undefined;
      if (url) {
        const m = url.match(/\/market\/([a-z0-9\-]+)/i);
        if (m) return m[1];
      }
    } catch {}
    return undefined;
  };

  const getPayoutFor = async (marketId: string, outcomeIdx: number): Promise<number | undefined> => {
    const slug = await slugOf(marketId);
    if (!slug) return undefined;
    let entry = payoutCache.get(slug);
    if (!entry) {
      const arr = await polymarket.getMarketsBySlug(slug);
      // Prefer exact match by conditionId (id field in our mapping is conditionId when present)
      const mkt = arr.find((m) => (m as any)?.id === marketId) || arr[0];
      if (!mkt) return undefined;
      const resolved = (mkt as any)?.closed === true && String((mkt as any)?.umaResolutionStatus || '').toLowerCase() === 'resolved';
      const prices = (mkt.outcomes ?? []).map((o) => (typeof o.price === 'number' ? o.price : NaN));
      entry = { resolved, prices };
      payoutCache.set(slug, entry);
    }
    if (!entry.resolved) return undefined;
    const v = entry.prices[outcomeIdx];
    return Number.isFinite(v) ? (v as number) : undefined;
  };

  for (const p of positions) {
    try {
      // Guard: only query CLOB when we have a numeric token id
      if (typeof p.optionId !== 'string' || !/^\d+$/.test(p.optionId)) continue;
      // Check resolved payout; when resolved, write payout mark and skip /book entirely
      let wrote = false;
      try {
        const idx = await repo.getOutcomeIndexByClobTokenId(p.marketId, p.optionId);
        if (typeof idx === 'number') {
          const payout = await getPayoutFor(p.marketId, idx);
          if (typeof payout === 'number') {
            await repo.setPositionMark({ agentId, marketId: p.marketId, optionId: p.optionId, bestBid: payout, bestAsk: payout, mid: payout });
            ok += 1;
            wrote = true;
          }
        }
      } catch {}
      if (wrote) continue;

      // Not resolved: use live orderbook
      const ob = await polymarket.getOrderBook(p.optionId);
      if (!ob) {
        fail += 1;
        failed.push({ marketId: p.marketId, optionId: p.optionId, reason: 'no_book' });
        continue;
      }
      const bestBid = ob?.bids?.[0]?.price;
      const bestAsk = ob?.asks?.[0]?.price;
      const mid = typeof bestBid === 'number' && typeof bestAsk === 'number' ? (bestBid + bestAsk) / 2 : undefined;
      await repo.setPositionMark({ agentId, marketId: p.marketId, optionId: p.optionId, bestBid, bestAsk, mid });
      ok += 1;
    } catch {
      // ignore individual failures
      fail += 1;
      failed.push({ marketId: p.marketId, optionId: String(p.optionId), reason: 'error' });
    }
  }
  // Lightweight one-line summary when any failures, to aid debugging without spam
  if (fail > 0) {
    const sample = failed.slice(0, 3).map((f) => `${f.marketId}:${f.optionId}(${f.reason})`).join(', ');
    // eslint-disable-next-line no-console
    console.warn('[marks]', { refreshed: ok, failed: fail, sample });
  }

  try {
    if (
      exitPositions.length > 0 &&
      (await shouldTriggerNumericExit(agentDef, runtime, repo, exitPositions))
    ) {
      if (agentDef) triggerNumericExit(agentDef, runtime);
    }
  } catch (err) {
    if (process.env.NODE_ENV !== 'test') {
      // eslint-disable-next-line no-console
      console.warn('[marks] numeric trigger check failed', {
        agentId,
        error: (err as Error)?.message ?? err,
      });
    }
  }
}

export function ensureMarksRefresher(agentId: string, runtime: RuntimeConfig) {
  const key = agentId || 'default';
  if (timers.has(key)) return;
  // Respect disable switch and orderbook inclusion flag
  if (!runtime.marksRefresher?.enabled || !runtime?.marketData?.includeOrderBooks) return;
  const intervalMinutes = Math.max(1 / 60, runtime.marksRefresher.intervalMinutes ?? 10 / 60);
  const periodMs = Math.max(1000, intervalMinutes * 60 * 1000);
  // Start after a small delay to avoid blocking first response
  const timer = setInterval(async () => {
    try {
      await refreshOnce(agentId, runtime);
      lastTick = Date.now();
    } catch {}
  }, periodMs);
  timers.set(key, timer);
}

export async function refreshMarksNow(agentId: string, runtime: RuntimeConfig) {
  await refreshOnce(agentId, runtime);
}

export function getLastMarksTick(): number {
  return lastTick;
}
