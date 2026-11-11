import type { PolymarketClient, MarketSummary } from '../../clients/polymarket';
import type { RuntimeConfig } from '../../config/schema';
import type { AgentRepository } from '../repository';
import type { AgentRepositoryAsync } from '../../storage/types';
import { resolveClobTokenIdsForMarket } from '../../clients/token-resolver';

export type Cand = {
  marketId: string;
  marketTitle: string;
  url?: string;
  id: string;
  name: string;
  price?: number;
  bestBid?: number;
  bestAsk?: number;
  askLevels?: Array<{ price: number; quantity: number }>;
  ttlMinutes?: number | null;
};

export interface PreparedEvent {
  marketId: string;
  eventMarkets: MarketSummary[];
  snapshotText: string;
  includedQuick: Cand[];
  derivation: 'eventSlug' | 'questionId' | 'slug' | 'pattern' | 'curated' | 'none';
  prefilterInfo?: {
    candidates: number;
    survivors: number;
    counts: { boundsFails: number; spreadFails: number; depthFails: number };
    thresholds: {
      maxSpreadPct?: number;
      bounds?: { floor?: number; ceiling?: number };
      minTopBookNotional?: number;
      minNotional?: number;
      depthLevels: number;
      requireLiveDepthForPrefilter: boolean;
      ttlRelief: boolean;
      depthThresholdBase?: number;
    };
    caps: { in: number; out: number };
    failures: Array<{
      marketId: string;
      marketTitle: string;
      url?: string;
      outcomeId: string;
      outcomeName: string;
      failed: { bounds?: boolean; spread?: boolean; depth?: boolean };
      metrics: {
        ask?: number;
        bid?: number;
        floor?: number;
        ceiling?: number;
        spread?: number;
        maxSpreadPct?: number;
        topNotional?: number;
        depthThreshold?: number;
        ttlMinutes?: number | null;
        reliefFactor?: number;
        hasBook?: boolean;
        requireLiveDepth?: boolean;
      };
    }>;
  };
}

export async function prepareEventContext({
  market,
  polymarket,
  runtime,
  repo,
  log,
}: {
  market: MarketSummary;
  polymarket: PolymarketClient;
  runtime: RuntimeConfig;
  repo: AgentRepository | AgentRepositoryAsync;
  log: (msg: string, data?: unknown) => void;
}): Promise<PreparedEvent | null> {
  try {
    const enableTokLogs = Boolean((runtime as any)?.logging?.verbose?.providers?.tokenResolver ?? false);
    // Resolve token ids for focus market
    try {
      await resolveClobTokenIdsForMarket(polymarket, repo, market, {
        strategies: runtime.marketData.tokenResolver?.strategies as any,
        validateWithBook: runtime.marketData.tokenResolver?.validateWithBook,
        log: enableTokLogs ? log : undefined,
      });
    } catch (e) {
      if (enableTokLogs) log('Token resolver error', { marketId: market.id, error: (e as Error).message });
    }

    // Hydrate focus market orderbooks (top-K)
    const levels = runtime.tradeEvaluation?.gating?.liquidityLevels ?? 1;
    const depthLevels = Math.max(
      levels,
      runtime.execution.sizing?.maxDepthLevels ?? levels,
    );
    if (runtime.marketData.includeOrderBooks) {
      for (const o of market.outcomes) {
        try {
          const tokenId = (o as any).clobTokenId as string | undefined;
          if (!tokenId) continue;
          const ob = await polymarket.getOrderBook(tokenId);
          if (!ob) continue;
          const bestBid = ob.bids.length ? Math.max(...ob.bids.map((l) => l.price)) : undefined;
          const bestAsk = ob.asks.length ? Math.min(...ob.asks.map((l) => l.price)) : undefined;
          if (Number.isFinite(bestBid as number)) (o as any).bestBid = bestBid as number;
          if (Number.isFinite(bestAsk as number)) (o as any).bestAsk = bestAsk as number;
          (o as any).bidLevels = ob.bids.slice(0, depthLevels);
          (o as any).askLevels = ob.asks.slice(0, depthLevels);
        } catch {}
      }
    }

    // Expand siblings
    let eventMarkets = [market];
    let expanded = false;
    let derivation: PreparedEvent['derivation'] = 'none';
    if ((market as any).eventSlug) {
      try {
        const siblings = await polymarket.listEventMarketsBySlug((market as any).eventSlug as string);
        if (siblings && siblings.length > 0) {
          const byId = new Map<string, typeof market>();
          for (const m of [...siblings, market]) byId.set(m.id, m);
          eventMarkets = Array.from(byId.values());
          expanded = eventMarkets.length > 1;
          derivation = 'eventSlug';
        }
      } catch {}
    }
    if (!expanded && (market as any).questionId) {
      try {
        const siblingsQ = await polymarket.listMarketsByQuestionId((market as any).questionId as string);
        if (siblingsQ && siblingsQ.length > 0) {
          const byId = new Map<string, typeof market>();
          for (const m of [...siblingsQ, market]) byId.set(m.id, m);
          eventMarkets = Array.from(byId.values());
          expanded = eventMarkets.length > 1;
          derivation = 'questionId';
        }
      } catch {}
    }
    if (!expanded && (market as any).slug) {
      try {
        const [full] = await polymarket.getMarketsBySlug((market as any).slug as string);
        const evSlug = (full as any)?.eventSlug as string | undefined;
        if (evSlug) {
          const siblings = await polymarket.listEventMarketsBySlug(evSlug);
          if (siblings && siblings.length > 0) {
            const byId = new Map<string, typeof market>();
            for (const m of [...siblings, market]) byId.set(m.id, m);
            eventMarkets = Array.from(byId.values());
            expanded = eventMarkets.length > 1;
            derivation = 'slug';
          }
        }
      } catch {}
    }
    // Only attempt web-resolve fallback when we truly failed to expand siblings
    // via eventSlug/questionId/slug. Do NOT broaden just because the event has
    // two outcomes; many valid events are binary.
    if (!expanded && (market as any).slug) {
      try {
        const webEv = await polymarket.resolveEventSlugFromMarketSlug((market as any).slug as string);
        if (webEv) {
          const siblings = await polymarket.listEventMarketsBySlug(webEv);
          if (siblings && siblings.length > 0) {
            const byId = new Map<string, typeof market>();
            for (const m of [...siblings, market]) byId.set(m.id, m);
            eventMarkets = Array.from(byId.values());
            expanded = eventMarkets.length > 1;
            derivation = derivation === 'none' ? 'slug' : derivation;
          }
        }
      } catch {}
    }
    // Defer sibling token resolution + orderbook hydration. We first TTL-cap the sibling outcomes
    // and then hydrate only the selected subset to bound network I/O.

    // Build candidate skeletons (no orderbooks yet) to compute TTL-based cap
    type Skel = { market: MarketSummary; outcomeIdx: number; ttlMinutes: number | null };
    const skels: Skel[] = [];
    for (const mkt of eventMarkets) {
      const ttlIso = (mkt as any).endDate as string | undefined;
      const ttlMinutes = (() => {
        if (!ttlIso) return null;
        const diff = Date.parse(ttlIso) - Date.now();
        if (!Number.isFinite(diff)) return null;
        return Math.round(diff / 60000);
      })();
      for (let i = 0; i < mkt.outcomes.length; i++) {
        skels.push({ market: mkt, outcomeIdx: i, ttlMinutes });
      }
    }
    const preFilterInputCap = Number(((runtime as any)?.research?.preFilterInputCap ?? Number.POSITIVE_INFINITY));
    const cap = runtime.tradeEvaluation?.candidateMaxPerEvent ?? 12;
    const preFilterOutputCap = Number(((runtime as any)?.research?.preFilterOutputCap ?? cap));
    const sortedSkels = skels.sort((a, b) => {
      const ta = typeof a.ttlMinutes === 'number' ? a.ttlMinutes : Number.POSITIVE_INFINITY;
      const tb = typeof b.ttlMinutes === 'number' ? b.ttlMinutes : Number.POSITIVE_INFINITY;
      return ta - tb;
    });
    const initialHydrateCap = Number.isFinite(preFilterInputCap)
      ? Math.max(0, Math.min(sortedSkels.length, Math.floor(preFilterInputCap)))
      : sortedSkels.length;
    // Keep sampling until we can fill preFilterOutputCap survivors (or hit a bounded hydration budget),
    // so agents don't have "empty" runs with no LLM calls due to strict gating.
    const maxHydrateBudget = (() => {
      const base = Math.max(initialHydrateCap, Math.max(preFilterOutputCap * 6, 24));
      return Math.max(0, Math.min(sortedSkels.length, base));
    })();
    const hydrateStep = Math.max(4, Math.min(24, Math.max(preFilterOutputCap, 8)));
    let toHydrate = sortedSkels.slice(0, initialHydrateCap);

    // Resolve tokens for selected markets only, then hydrate orderbooks for selected outcomes
    const levelsPref = runtime.tradeEvaluation?.gating?.liquidityLevels ?? 1;
    const depthLevelsPref = Math.max(levelsPref, runtime.execution.sizing?.maxDepthLevels ?? levelsPref);
    const seenMkt = new Set<string>();
    const hydrateBatch = async (batch: Skel[]) => {
      if (!runtime.marketData.includeOrderBooks || batch.length === 0) return;
      const enableTokLogs = Boolean((runtime as any)?.logging?.verbose?.providers?.tokenResolver ?? false);
      for (const sk of batch) {
        const mkt = sk.market;
        if (!seenMkt.has(mkt.id)) {
          try {
            await resolveClobTokenIdsForMarket(polymarket, repo, mkt, {
              strategies: runtime.marketData.tokenResolver?.strategies as any,
              validateWithBook: runtime.marketData.tokenResolver?.validateWithBook,
              log: enableTokLogs ? log : undefined,
            });
          } catch (e) {
            if (enableTokLogs) log('Token resolver (selected) error', { marketId: market.id, error: (e as Error).message });
          }
          seenMkt.add(mkt.id);
        }
      }
      for (const sk of batch) {
        const mkt = sk.market;
        const o = mkt.outcomes[sk.outcomeIdx] as any;
        try {
          const tokenId = (o as any).clobTokenId as string | undefined;
          if (!tokenId) continue;
          const ob = await polymarket.getOrderBook(tokenId);
          if (!ob) continue;
          const bestBid = ob.bids.length ? Math.max(...ob.bids.map((l) => l.price)) : undefined;
          const bestAsk = ob.asks.length ? Math.min(...ob.asks.map((l) => l.price)) : undefined;
          if (Number.isFinite(bestBid as number)) o.bestBid = bestBid as number;
          if (Number.isFinite(bestAsk as number)) o.bestAsk = bestAsk as number;
          o.bidLevels = ob.bids.slice(0, depthLevelsPref);
          o.askLevels = ob.asks.slice(0, depthLevelsPref);
        } catch (e) {
          const enablePolyLogs = Boolean((runtime as any)?.logging?.verbose?.providers?.polymarket ?? false);
          if (enablePolyLogs) log('Sibling orderbook hydration failed', { marketId: mkt.id, outcome: (o as any).name, error: (e as Error).message });
        }
      }
    };

    // Hydrate initial window (additional hydration may occur after prefilter evaluation).
    await hydrateBatch(toHydrate);

    // Prefilter gates and ordering
    const gating = runtime.tradeEvaluation.gating ?? ({ maxSpreadPct: 1.0, minTopBookNotional: 0, liquidityLevels: 1, requireFullNotionalAtDepth: true } as any);
    const sizing = runtime.execution.sizing ?? ({ mode: 'fixed', minNotional: 0, maxDepthLevels: (gating as any).liquidityLevels } as any);
    const depthLevels3 = Math.max(gating.liquidityLevels, sizing.maxDepthLevels ?? gating.liquidityLevels);
    const floor = (runtime as any).exits?.priceFloor as number | undefined;
    const ceiling = (runtime as any).exits?.priceCeiling as number | undefined;
    const spreadOk = (bb?: number, ba?: number) => {
      if (!Number.isFinite(bb as number) || !Number.isFinite(ba as number)) return true;
      const mid = ((bb as number) + (ba as number)) / 2;
      if (mid <= 0) return false;
      const s = ((ba as number) - (bb as number)) / mid;
      return s <= (gating.maxSpreadPct ?? 1.0);
    };
    const topNotional = (asks?: Array<{ price: number; quantity: number }>) => (asks ?? []).slice(0, depthLevels3).reduce((acc, l) => acc + (Number(l.price) * Number(l.quantity)), 0);
    const passesBounds = (ba?: number) => {
      if (typeof ba !== 'number') return true;
      if (typeof floor === 'number' && ba < floor) return false;
      if (typeof ceiling === 'number' && ba > ceiling) return false;
      return true;
    };
    const minDepthNeededBase = sizing.mode === 'auto_scale_to_depth' && !gating.requireFullNotionalAtDepth
      ? Math.max((sizing as any).minNotional ?? 0, gating.minTopBookNotional ?? 0)
      : Math.max(gating.minTopBookNotional ?? 0, 0);
    const ttlReliefFactor = (ttl?: number | null) => {
      if (typeof ttl !== 'number' || ttl < 0) return 1;
      if (ttl <= 24 * 60) return 0.2;
      if (ttl <= 48 * 60) return 0.3;
      if (ttl <= 96 * 60) return 0.4;
      return 1;
    };
    const requireDepthForPref = Boolean((runtime.tradeEvaluation as any)?.gating?.requireLiveDepthForPrefilter ?? true);
    const orderMode = ((runtime as any)?.research?.order ?? 'liquidity_ttl_spread') as string;
    const computePrefilterState = (): {
      candsForPref: Cand[];
      failVectors: any[];
      includedQuick: Cand[];
    } => {
      // Build candidates from hydrated subset only
      let allCands: Cand[] = toHydrate.map((sk) => {
        const mkt = sk.market;
        const o: any = mkt.outcomes[sk.outcomeIdx];
        return {
          marketId: mkt.id,
          marketTitle: mkt.question,
          url: mkt.url,
          id: o.id,
          name: o.name,
          price: o.price,
          bestBid: o.bestBid,
          bestAsk: o.bestAsk,
          askLevels: (o.askLevels as Array<{ price: number; quantity: number }> | undefined) ?? [],
          ttlMinutes: sk.ttlMinutes,
        } as Cand;
      });

      if (orderMode === 'liquidity_ttl_spread') {
        allCands = [...allCands].sort((a, b) => {
          const la = topNotional(a.askLevels);
          const lb = topNotional(b.askLevels);
          if (lb !== la) return lb - la;
          const ta = typeof a.ttlMinutes === 'number' ? a.ttlMinutes : Number.POSITIVE_INFINITY;
          const tb = typeof b.ttlMinutes === 'number' ? b.ttlMinutes : Number.POSITIVE_INFINITY;
          const aIsNear = ta <= 96 * 60;
          const bIsNear = tb <= 96 * 60;
          if (aIsNear !== bIsNear) return aIsNear ? -1 : 1;
          if (ta !== tb) return ta - tb;
          const aHas = Number.isFinite(a.bestBid as number) && Number.isFinite(a.bestAsk as number);
          const bHas = Number.isFinite(b.bestBid as number) && Number.isFinite(b.bestAsk as number);
          const aMid = aHas ? (((a.bestBid as number) + (a.bestAsk as number)) / 2) : NaN;
          const bMid = bHas ? (((b.bestBid as number) + (b.bestAsk as number)) / 2) : NaN;
          const aSpr = aHas && aMid > 0 ? (((a.bestAsk as number) - (a.bestBid as number)) / aMid) : Number.POSITIVE_INFINITY;
          const bSpr = bHas && bMid > 0 ? (((b.bestAsk as number) - (b.bestBid as number)) / bMid) : Number.POSITIVE_INFINITY;
          if (aSpr !== bSpr) return aSpr - bSpr;
          return 0;
        });
      }
      // candsForPref is the already TTL-capped hydrated set
      const candsForPref = allCands;
      const failVectors = candsForPref.map((c) => {
        const depth = topNotional(c.askLevels);
        const relief = ttlReliefFactor(c.ttlMinutes ?? null);
        const depthThreshold = Math.max(minDepthNeededBase * relief, minDepthNeededBase > 0 ? Math.min(10, minDepthNeededBase) : 0);
        const hasBook = Array.isArray(c.askLevels) && (c.askLevels as any[]).length > 0;
        const bb = c.bestBid;
        const ba = c.bestAsk;
        const mid = (Number.isFinite(bb as number) && Number.isFinite(ba as number)) ? (((bb as number) + (ba as number)) / 2) : undefined;
        const s = (typeof mid === 'number' && mid > 0 && Number.isFinite(ba as number) && Number.isFinite(bb as number))
          ? (((ba as number) - (bb as number)) / mid)
          : undefined;
        const failsBounds = !passesBounds(ba);
        const failsSpread = !spreadOk(bb, ba);
        const failsDepth = requireDepthForPref ? depth < depthThreshold : (hasBook ? depth < depthThreshold : false);
        const passes = !failsBounds && !failsSpread && !failsDepth;
        return {
          id: c.id,
          marketId: c.marketId,
          marketTitle: c.marketTitle,
          url: c.url,
          outcomeId: c.id,
          outcomeName: c.name,
          passes,
          failed: { bounds: failsBounds || undefined, spread: failsSpread || undefined, depth: failsDepth || undefined },
          metrics: {
            ask: typeof ba === 'number' ? ba : undefined,
            bid: typeof bb === 'number' ? bb : undefined,
            floor,
            ceiling,
            spread: typeof s === 'number' ? s : undefined,
            maxSpreadPct: gating.maxSpreadPct,
            topNotional: depth,
            depthThreshold,
            ttlMinutes: c.ttlMinutes ?? null,
            reliefFactor: relief,
            hasBook,
            requireLiveDepth: requireDepthForPref,
          },
        };
      });
      const viable = candsForPref.filter((c) => failVectors.find((f) => f.id === c.id)!.passes);
      let includedQuick: Cand[];
      const distribute = Boolean((runtime as any)?.research?.distributeSurvivors ?? false);
      if (!distribute) {
        includedQuick = viable.slice(0, preFilterOutputCap);
      } else {
        // Round‑robin by sibling to maximize coverage before filling remainder
        const groups = new Map<string, Cand[]>();
        for (const c of viable) {
          const arr = groups.get(c.marketId) ?? [];
          arr.push(c);
          groups.set(c.marketId, arr);
        }
        const ordered: Cand[] = [];
        const keys = Array.from(groups.keys());
        let consumed = 0;
        let ptr = 0;
        while (consumed < preFilterOutputCap && keys.length > 0) {
          const k = keys[ptr % keys.length]!;
          const arr = groups.get(k)!;
          const next = arr.shift();
          if (next) {
            ordered.push(next);
            consumed++;
            if (arr.length === 0) {
              groups.delete(k);
              keys.splice(ptr % keys.length, 1);
              // do not advance ptr when removing current key
              continue;
            }
          }
          ptr++;
          if (ptr > 10000) break; // safety
        }
        // Fill any remaining slots with the original viable order
        if (ordered.length < preFilterOutputCap) {
          const seen = new Set(ordered.map((c) => `${c.marketId}:${c.id}`));
          for (const c of viable) {
            if (ordered.length >= preFilterOutputCap) break;
            const key = `${c.marketId}:${c.id}`;
            if (!seen.has(key)) {
              ordered.push(c);
              seen.add(key);
            }
          }
        }
        includedQuick = ordered.slice(0, preFilterOutputCap);
      }
      return { candsForPref, failVectors, includedQuick };
    };

    let { candsForPref, failVectors, includedQuick } = computePrefilterState();
    let expansions = 0;
    while (
      includedQuick.length < preFilterOutputCap &&
      toHydrate.length < sortedSkels.length &&
      toHydrate.length < maxHydrateBudget
    ) {
      const prevLen = toHydrate.length;
      const nextLen = Math.min(sortedSkels.length, maxHydrateBudget, prevLen + hydrateStep);
      const batch = sortedSkels.slice(prevLen, nextLen);
      if (batch.length === 0) break;
      toHydrate = sortedSkels.slice(0, nextLen);
      await hydrateBatch(batch);
      ({ candsForPref, failVectors, includedQuick } = computePrefilterState());
      expansions++;
      if (expansions > 20) break;
    }

    // Build event snapshot with whatever data is available (non-selected will show n/a for bids/asks)
    const eventSnapshotLines: string[] = [];
    for (const mkt of eventMarkets) {
      for (const o of mkt.outcomes) {
        const bb = (o as any).bestBid as number | undefined;
        const ba = (o as any).bestAsk as number | undefined;
        const snap = typeof o.price === 'number' ? (o.price > 1 ? o.price / 100 : o.price) : undefined;
        eventSnapshotLines.push(`${mkt.question} | ${o.name}: snap=${snap ?? 'n/a'} bid=${bb ?? 'n/a'} ask=${ba ?? 'n/a'}`);
      }
    }
    const eventSnapshotText = eventSnapshotLines.join('\n');

    // Aggregate prefilter info for observability/debug
    const boundsFails = failVectors.filter((v) => v.failed.bounds).length;
    const spreadFails = failVectors.filter((v) => v.failed.spread).length;
    const depthFails = failVectors.filter((v) => v.failed.depth).length;
    const prefilterInfo = {
      candidates: candsForPref.length,
      survivors: includedQuick.length,
      counts: { boundsFails, spreadFails, depthFails },
      thresholds: {
        maxSpreadPct: gating.maxSpreadPct,
        bounds: { floor, ceiling },
        minTopBookNotional: gating.minTopBookNotional,
        minNotional: (sizing as any).minNotional,
        depthLevels: depthLevels3,
        requireLiveDepthForPrefilter: requireDepthForPref,
        ttlRelief: true,
        depthThresholdBase: minDepthNeededBase,
      },
      caps: { in: toHydrate.length, out: preFilterOutputCap },
      failures: failVectors
        .filter((v) => !v.passes)
        .map((v) => ({
          marketId: v.marketId,
          marketTitle: v.marketTitle,
          url: v.url,
          outcomeId: v.outcomeId,
          outcomeName: v.outcomeName,
          failed: v.failed,
          metrics: v.metrics,
        })),
    } as const;

    return {
      marketId: market.id,
      eventMarkets,
      snapshotText: eventSnapshotText,
      includedQuick,
      derivation,
      prefilterInfo,
    };
  } catch (e) {
    log('prepareEventContext error', { marketId: market.id, error: (e as Error).message });
    return null;
  }
}
