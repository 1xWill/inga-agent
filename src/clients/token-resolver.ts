import type { PolymarketClient, MarketSummary } from './polymarket';
import type { AgentRepository } from '../agent/repository';
import type { AgentRepositoryAsync } from '../storage/types';

export interface TokenResolverOptions {
  strategies?: Array<'slug' | 'event' | 'question' | 'web'>;
  validateWithBook?: boolean;
  log?: (msg: string, data?: unknown) => void;
}

function isNumericId(s: unknown): s is string {
  return typeof s === 'string' && /^\d+$/.test(s);
}

/**
 * Resolve CLOB token ids for all outcomes in a market, updating the provided MarketSummary in-place.
 * Uses a sequence of strategies and caches results in the repository. Public CLOB endpoints do not
 * require wallet balance or gas — missing ids originate from Gamma data sparsity.
 */
export async function resolveClobTokenIdsForMarket(
  client: PolymarketClient,
  repo: AgentRepository | AgentRepositoryAsync,
  market: MarketSummary,
  { strategies = ['slug', 'event', 'question', 'web'], validateWithBook = true, log }: TokenResolverOptions = {}
): Promise<void> {
  if (!Array.isArray(market.outcomes) || market.outcomes.length === 0) return;

  const start = Date.now();
  const logEvent = (msg: string, data?: Record<string, unknown>) => {
    if (!log) return;
    log(msg, { marketId: market.id, ...(data ?? {}) });
  };

  logEvent('token-resolver:start', {
    strategies,
    validateWithBook,
    outcomeCount: market.outcomes.length,
  });

  // 1) Use existing clobTokenId values and cache them
  let unresolved = new Set<number>();
  let directHits = 0;
  let cachedHits = 0;
  for (let idx = 0; idx < market.outcomes.length; idx++) {
    const o = market.outcomes[idx];
    const existing = (o as any).clobTokenId as string | undefined;
    if (isNumericId(existing)) {
      await (repo as any).upsertResolvedClobTokenId({ marketId: market.id, outcomeIndex: idx, clobTokenId: existing, source: 'direct' });
      (o as any).id = existing;
      directHits += 1;
    } else {
      const cached = await (repo as any).getResolvedClobTokenId(market.id, idx);
      if (isNumericId(cached)) {
        (o as any).clobTokenId = cached;
        (o as any).id = cached;
        cachedHits += 1;
      } else {
        unresolved.add(idx);
      }
    }
  }
  if (directHits > 0 || cachedHits > 0) {
    logEvent('token-resolver:cache-primed', {
      directHits,
      cachedHits,
      unresolvedCount: unresolved.size,
    });
  } else if (unresolved.size === market.outcomes.length) {
    logEvent('token-resolver:no-direct-ids', {
      unresolvedCount: unresolved.size,
    });
  }
  if (unresolved.size === 0) return;

  // Helper: apply candidate list of token ids
  const applyCandidates = async (candidate: MarketSummary | undefined, source: string) => {
    if (!candidate) return;
    if (!Array.isArray(candidate.outcomes) || candidate.outcomes.length !== market.outcomes.length) return;
    const attemptStart = Date.now();
    let applied = 0;
    for (let i = 0; i < candidate.outcomes.length; i++) {
      if (!unresolved.has(i)) continue;
      const tok = (candidate.outcomes[i] as any).clobTokenId as string | undefined;
      if (!isNumericId(tok)) continue;
      // Optional validation by fetching orderbook; skip if invalid
      if (validateWithBook) {
        try {
          const ob = await client.getOrderBook(tok);
          if (!ob) continue; // invalid
        } catch (e) {
          logEvent('token-resolver:validation-failed', {
            source,
            outcomeIndex: i,
            tokenId: tok,
            error: (e as Error).message,
          });
          continue;
        }
      }
      (market.outcomes[i] as any).clobTokenId = tok;
      (market.outcomes[i] as any).id = tok;
      await (repo as any).upsertResolvedClobTokenId({ marketId: market.id, outcomeIndex: i, clobTokenId: tok, source });
      unresolved.delete(i);
      applied += 1;
    }
    if (applied > 0) {
      logEvent('token-resolver:strategy-success', {
        source,
        applied,
        durationMs: Date.now() - attemptStart,
        remaining: unresolved.size,
      });
    } else {
      logEvent('token-resolver:strategy-no-match', {
        source,
        durationMs: Date.now() - attemptStart,
        remaining: unresolved.size,
      });
    }
  };

  // 2) Try slug refetch (markets?slug=)
  if (unresolved.size > 0 && strategies.includes('slug') && (market as any).slug) {
    try {
      const arr = await client.getMarketsBySlug((market as any).slug as string);
      const found = arr.find((m) => m.id === market.id) ?? arr[0];
      await applyCandidates(found, 'slug');
    } catch (e) {
      logEvent('token-resolver:strategy-error', {
        source: 'slug',
        error: (e as Error).message,
      });
    }
  }

  // 3) Try event scan (events?slug= → listMarketsByEventId)
  if (unresolved.size > 0 && strategies.includes('event') && (market as any).eventSlug) {
    try {
      const siblings = await client.listEventMarketsBySlug((market as any).eventSlug as string);
      const found = siblings.find((m) => m.id === market.id);
      await applyCandidates(found, 'event');
    } catch (e) {
      logEvent('token-resolver:strategy-error', {
        source: 'event',
        error: (e as Error).message,
      });
    }
  }

  // 4) Try questionId scan
  if (unresolved.size > 0 && strategies.includes('question') && (market as any).questionId) {
    try {
      const siblingsQ = await client.listMarketsByQuestionId((market as any).questionId as string);
      const found = siblingsQ.find((m) => m.id === market.id);
      await applyCandidates(found, 'question');
    } catch (e) {
      logEvent('token-resolver:strategy-error', {
        source: 'question',
        error: (e as Error).message,
      });
    }
  }

  // 5) As a last resort, attempt deriving event slug from web (public site) and reuse event strategy
  if (unresolved.size > 0 && strategies.includes('web') && (market as any).slug) {
    try {
      const evSlug = await client.resolveEventSlugFromMarketSlug((market as any).slug as string);
      if (evSlug) {
        const siblings = await client.listEventMarketsBySlug(evSlug);
        const found = siblings.find((m) => m.id === market.id);
        await applyCandidates(found, 'web');
      }
    } catch (e) {
      logEvent('token-resolver:strategy-error', {
        source: 'web',
        error: (e as Error).message,
      });
    }
  }

  if (unresolved.size > 0) {
    logEvent('token-resolver:unresolved', {
      unresolved: Array.from(unresolved.values()).slice(0, 10),
      unresolvedCount: unresolved.size,
      durationMs: Date.now() - start,
    });
  } else {
    logEvent('token-resolver:complete', {
      durationMs: Date.now() - start,
    });
  }
}
