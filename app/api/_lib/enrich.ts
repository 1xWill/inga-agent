import type { AgentRepositoryAsync } from '../../../src/storage/types';

type LabelKey = {
  marketId: string;
  evaluationOutcomeId?: string;
  clobTokenId?: string;
};

type Labeled<T> = T & {
  marketTitle?: string;
  outcomeName?: string;
  marketUrl?: string;
};

/**
 * Shared helper to enrich dashboard rows with human-readable market titles and
 * outcome names using the latest evaluation summary for each market.
 *
 * - Performs targeted lookups by marketId (no global "last N evaluations" window).
 * - Uses evaluationOutcomeId when it matches evaluation.outcomes[].id.
 * - Optionally falls back via token_resolution_map when clobTokenId is provided.
 */
export async function enrichMarketOutcomeLabels<T>(
  repo: AgentRepositoryAsync | any,
  items: T[],
  getKey: (item: T) => LabelKey,
): Promise<Array<Labeled<T>>> {
  if (!items || items.length === 0) return items as Array<Labeled<T>>;

  const marketIds = Array.from(
    new Set(
      items
        .map((it) => getKey(it).marketId)
        .filter((m): m is string => typeof m === 'string' && m.length > 0),
    ),
  );

  const evalByMarket = new Map<
    string,
    { title: string; outcomes: Array<{ id: string; name: string }>; url?: string }
  >();

  for (const marketId of marketIds) {
    try {
      const ev = await (repo as any).getLatestEvaluationSummary(marketId);
      if (ev && typeof ev.title === "string" && Array.isArray(ev.outcomes)) {
        evalByMarket.set(
          marketId,
          ev as {
            title: string;
            outcomes: Array<{ id: string; name: string }>;
            url?: string;
          },
        );
      }
    } catch {
      // Best-effort only; some markets may have no evaluations.
    }
  }

  const clobIndexCache = new Map<string, number | undefined>();
  const clobKey = (marketId: string, token: string) => `${marketId}:${token}`;

  const getClobIndex = async (
    marketId: string,
    clobTokenId?: string,
  ): Promise<number | undefined> => {
    if (!clobTokenId) return undefined;
    const k = clobKey(marketId, clobTokenId);
    if (clobIndexCache.has(k)) return clobIndexCache.get(k);
    let idx: number | undefined;
    try {
      idx = await (repo as any).getOutcomeIndexByClobTokenId(marketId, clobTokenId);
    } catch {
      idx = undefined;
    }
    clobIndexCache.set(k, idx);
    return idx;
  };

  const out: Array<Labeled<T>> = [];
  for (const item of items) {
    const key = getKey(item);
    const ev = key.marketId ? evalByMarket.get(key.marketId) : undefined;
    let marketTitle = (item as any).marketTitle as string | undefined;
    let outcomeName = (item as any).outcomeName as string | undefined;
    let marketUrl = (item as any).marketUrl as string | undefined;

    if (!marketTitle && ev) {
      marketTitle = ev.title;
    }

    if (!outcomeName && ev && key.evaluationOutcomeId) {
      const match = ev.outcomes.find(
        (o) => o && typeof o.id !== 'undefined' && String(o.id) === String(key.evaluationOutcomeId),
      );
      if (match?.name) outcomeName = match.name;
    }

    if (!outcomeName && ev && key.clobTokenId) {
      const idx = await getClobIndex(key.marketId, key.clobTokenId);
      if (typeof idx === 'number') {
        const o = ev.outcomes[idx];
        if (o?.name) outcomeName = o.name;
      }
    }

    if (!marketUrl && ev && ev.url) {
      marketUrl = ev.url;
    }

    out.push({ ...(item as any), marketTitle, outcomeName, marketUrl });
  }

  return out;
}
