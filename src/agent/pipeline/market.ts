import type { PolymarketClient, MarketSummary } from '../../clients/polymarket';
import type { RuntimeConfig } from '../../config/schema';
import type { AgentRepository } from '../repository';
import type { AgentRepositoryAsync } from '../../storage/types';

export interface FetchMarketsInput {
  client: PolymarketClient;
  runtime: RuntimeConfig;
  cursor?: string;
}

export interface FetchMarketsResult {
  markets: MarketSummary[];
  nextCursor?: string;
}

export async function fetchLatestMarkets({ client, runtime, cursor }: FetchMarketsInput): Promise<FetchMarketsResult> {
  // Gamma Markets API supports limit/offset. We page only if needed until we
  // reach the configured limit or exhaust results. Keep server order (no local resort).
  const target = runtime.polling.marketFetchLimit;
  const collected: MarketSummary[] = [];
  let next: string | undefined = cursor;

  while (collected.length < target) {
    const remaining = target - collected.length;
    const pageLimit = Math.min(remaining, 1000);
    const { markets, nextCursor } = await client.listTrendingMarkets({ limit: pageLimit, cursor: next });
    for (const m of markets) {
      if (collected.length >= target) break;
      collected.push(m);
    }
    if (!nextCursor || markets.length === 0) break;
    next = nextCursor;
  }


  return { markets: collected, nextCursor: next };
}

export interface SelectMarketsInput {
  client: PolymarketClient;
  runtime: RuntimeConfig;
  repo: AgentRepository | AgentRepositoryAsync;
  agentId: string;
}

export async function selectMarketsForEvaluation({ client, runtime, repo, agentId }: SelectMarketsInput): Promise<{
  markets: MarketSummary[];
  pagesUsed: number;
  counts: { selected: number; droppedInvalid: number; skippedByFill: number; skippedByEval: number; considered: number; skippedByDiscoveryCooldown?: number; skippedByTtlWindow?: number; skippedMissingEndDate?: number };
  preferredMarketIds: string[];
}> {
  const target = runtime.polling.marketFetchLimit;
  const picked: MarketSummary[] = [];
  // Deduplicate by event key (eventSlug || questionId || id) while paging, so we fill to unique-event limit
  const seenMarketIds = new Set<string>();
  const seenEventKeys = new Set<string>();
  const seenCursors = new Set<string>();
  // Initialize cursor state from repository to diversify results across runs
  const cursorRaw = await (repo as any).getMarketDiscoveryCursor(agentId);
  let cursorState: Record<string, string> | undefined;
  if (cursorRaw) {
    try {
      cursorState = JSON.parse(cursorRaw) as Record<string, string>;
    } catch {
      cursorState = { single: cursorRaw };
    }
  }
  let cursor: string | undefined = (runtime.marketData.discoveryMode === 'single') ? (cursorState?.single ?? undefined) : undefined;
  let pagesUsed = 0;
  let droppedInvalid = 0;
  let skippedByFill = 0;
  let skippedByEval = 0;
  let skippedByDiscoveryCooldown = 0;
  let skippedByTtlWindow = 0;
  let skippedMissingEndDate = 0;
  let considered = 0;

  const consider = async (
    m: MarketSummary,
    opts?: { fromKeyword?: boolean }
  ): Promise<{ accepted: boolean; reason?: string }> => {
    if (picked.length >= target) return { accepted: false, reason: 'target_reached' };
    const md = runtime.marketData;
    const fromKeyword = Boolean(opts?.fromKeyword);
    const skipCooldowns = fromKeyword && (((runtime as any)?.skipCooldownForKeywords ?? true) === true);
    considered++;
    const id = m.id?.trim();
    const eventKey = ((m as any).eventSlug as string | undefined) || ((m as any).questionId as string | undefined) || `id:${id}`;
    const endIso = (m as any).endDate as string | undefined;
    let ttlMinutes: number | undefined;
    if (endIso) {
      const endMs = Date.parse(endIso);
      if (Number.isFinite(endMs)) {
        const diff = endMs - Date.now();
        ttlMinutes = Math.round(diff / 60000);
      }
    }
    if (typeof ttlMinutes === 'number') {
      const minTtl = (md as any).minTtlMinutes as number | undefined;
      const maxTtl = (md as any).maxTtlMinutes as number | undefined;
      if (typeof minTtl === 'number' && ttlMinutes < minTtl) {
        skippedByTtlWindow++;
        return { accepted: false, reason: 'ttl_window' };
      }
      if (typeof maxTtl === 'number' && ttlMinutes > maxTtl) {
        skippedByTtlWindow++;
        return { accepted: false, reason: 'ttl_window' };
      }
    }
    if (!id || seenMarketIds.has(id) || seenEventKeys.has(eventKey) || !Array.isArray(m.outcomes) || m.outcomes.length === 0) {
      if (!id || !Array.isArray(m.outcomes) || m.outcomes.length === 0) droppedInvalid++;
      return { accepted: false, reason: 'invalid_or_dup' };
    }
    const now = new Date();
    let fillSkip = false;
    const sharedCooldownMinutes = Math.max(0, (runtime.cooldowns as any)?.postDecisionMinutes ?? 0);
    if (!skipCooldowns && sharedCooldownMinutes > 0) {
      const last = await (repo as any).getLastFillTime(agentId, id);
      if (last) {
        const msSince = now.getTime() - last.getTime();
        const threshold = sharedCooldownMinutes * 60000;
        fillSkip = msSince < threshold;
      }
    }
    let evalSkip = false;
    if (!fillSkip && !skipCooldowns && sharedCooldownMinutes > 0) {
      const reasons = await (repo as any).getActiveCooldownReasons(agentId, id, now);
      evalSkip = reasons.length > 0;
      // TTL-aware override: don't suppress near-expiry candidates by eval cooldown
      if (evalSkip && typeof ttlMinutes === 'number' && ttlMinutes >= 0 && ttlMinutes <= 96 * 60) {
        evalSkip = false;
      }
    }
    // Discovery cooldown skip
    const activeReasons = skipCooldowns ? [] : await (repo as any).getActiveCooldownReasons(agentId, id, now);
    const discoverySkip = activeReasons.includes('discovery');
    if (fillSkip || evalSkip || discoverySkip) {
      if (fillSkip) skippedByFill++;
      else if (evalSkip) skippedByEval++;
      else if (discoverySkip) skippedByDiscoveryCooldown++;
      return { accepted: false, reason: fillSkip ? 'fill_cooldown' : (evalSkip ? 'eval_cooldown' : 'discovery_cooldown') };
    }
    seenMarketIds.add(id);
    seenEventKeys.add(eventKey);
    picked.push(m);
    // Immediately set discovery cooldown to avoid re-pick in next run
    const baseMinutes = (runtime as any)?.cooldowns?.discoveryMinutes ?? 60;
    let cooldownMinutes = baseMinutes;
    if (typeof ttlMinutes === 'number' && ttlMinutes >= 0) {
      if (ttlMinutes <= 96 * 60) {
        const adaptive = Math.max(15, Math.floor(ttlMinutes / 4));
        cooldownMinutes = Math.min(baseMinutes, adaptive);
      }
    }
    const expiresAt = new Date(now.getTime() + cooldownMinutes * 60000);
    await (repo as any).upsertMarketCooldown({ agentId, marketId: id, reason: 'discovery', expiresAt, updatedAt: now });
    return { accepted: true };
  };

  const md = runtime.marketData;
  const supportsListMarkets = typeof (client as any).listMarkets === 'function';
  const seedRandom = md.seedOffsetStrategy === 'random' && !cursorState && supportsListMarkets;

  const preferredIds = new Set<string>();
  const kwList = Array.isArray((runtime as any)?.includeKeywords) ? (runtime as any).includeKeywords.map((s: any) => String(s ?? '').trim()).filter((s: string) => s.length > 0) : [];
  const kwIncludeOnly = Boolean((runtime as any)?.includeOnly ?? false);
  const kwLimitPerType = Number((runtime as any)?.keywordSearchLimitPerType ?? 8);
  const kwPageMax = Math.max(0, Number((runtime as any)?.keywordSearchPageMax ?? 5));
  const kwSort = ((runtime as any)?.keywordSearchSort ?? 'trending') as RuntimeConfig['keywordSearchSort'];
  const kwExcl = Array.isArray((runtime as any)?.excludeTags) ? ((runtime as any).excludeTags as string[]) : [];
  const preCap = Number(((runtime as any)?.research?.preFilterInputCap ?? Number.POSITIVE_INFINITY));
  const keywordPhaseCap = Math.max(1, Math.min(preCap, target));
  const shouldDoKeywordPhase = kwList.length > 0 && typeof kwList[0] === 'string' && kwList[0].trim().length > 0;
  // Persist keyword index across runs with config hash
  const kwStateObj: any = ((): any => {
    try { return cursorState ? JSON.parse(JSON.stringify(cursorState)) : {}; } catch { return {}; }
  })();
  const cfgHash = JSON.stringify({ kw: kwList, excl: kwExcl, only: kwIncludeOnly, lp: kwLimitPerType, pg: kwPageMax, sort: kwSort });
  let kwIdx = 0;
  let kwStored = undefined as any;
  try { kwStored = (cursorRaw ? JSON.parse(cursorRaw) : undefined) as any; } catch {}
  if (kwStored && kwStored.keywords && kwStored.keywords.configHash === cfgHash) {
    kwIdx = Number(kwStored.keywords.idx ?? 0) || 0;
  } else {
    // reset when config changes
    kwIdx = 0;
  }
  if (shouldDoKeywordPhase) {
    let acceptedKw = 0;
    let attempts = 0;
    // traverse keywords in order starting from kwIdx; wrap when includeOnly
    while (acceptedKw < keywordPhaseCap && attempts < kwList.length * 2) {
      const kIndex = (kwIdx + attempts) % kwList.length;
      const keyword = kwList[kIndex]!;
      const page = Math.floor(Math.random() * (kwPageMax + 1));
      try {
        const results = await (client as any).publicSearch?.({ q: keyword, limitPerType: kwLimitPerType, page, sort: kwSort, excludeTagIds: kwExcl }) as MarketSummary[] | undefined;
        const list = Array.isArray(results) ? results : [];
        for (const m of list) {
          if (acceptedKw >= keywordPhaseCap || picked.length >= target) break;
          const res = await consider(m, { fromKeyword: true });
          if (res.accepted) {
            acceptedKw++;
            if (m?.id) preferredIds.add(m.id);
          }
        }
      } catch {
        // ignore and continue
      }
      attempts++;
      if (!kwIncludeOnly && (kwIdx + attempts) >= kwList.length) break; // one pass when not includeOnly
    }
    // persist next starting idx
    const nextIdx = kwIncludeOnly ? ((kwIdx + attempts) % kwList.length) : ((kwIdx + Math.max(1, attempts)) % kwList.length);
    const newCursorPayload = { ...(kwStored ?? {}), keywords: { idx: nextIdx, configHash: cfgHash }, single: (cursor ?? '0') };
    try { await (repo as any).setMarketDiscoveryCursor(agentId, JSON.stringify(newCursorPayload)); } catch {}
  }
  // includeOnly=true: use keyword-first only, do not fall back to other orders
  if (shouldDoKeywordPhase && kwIncludeOnly) {
    return { markets: picked, pagesUsed, counts: { selected: picked.length, droppedInvalid, skippedByFill, skippedByEval, skippedByDiscoveryCooldown, skippedByTtlWindow, skippedMissingEndDate, considered }, preferredMarketIds: Array.from(preferredIds) };
  }

  if (supportsListMarkets && md.discoveryMode === 'composite' && Array.isArray(md.compositeSorts) && md.compositeSorts.length > 0) {
    const anyClient = client as unknown as { listMarkets?: Function; listTrendingMarkets: Function };
    const baseFetch = async (sort: RuntimeConfig['marketData']['sort'], limit: number, cursor?: string, createdAfterIso?: string, updatedAfterIso?: string) => {
      if (typeof anyClient.listMarkets === 'function') {
        return anyClient.listMarkets({ limit, cursor, sort, createdAfterIso, updatedAfterIso, excludeTagIds: (runtime as any)?.excludeTags ?? [] }) as Promise<{ markets: MarketSummary[]; nextCursor?: string }>;
      }
      return anyClient.listTrendingMarkets({ limit, cursor }) as Promise<{ markets: MarketSummary[]; nextCursor?: string }>;
    };
    const entries = md.compositeSorts as Array<{ sort: RuntimeConfig['marketData']['sort'] | 'endingSoon'; take: number }>;
    // Hard guarantee: try to pick at least one endingSoon market before randomized mixing
    if (entries.some((e) => e.sort === 'endingSoon') && picked.length < target) {
      const nowMs = Date.now();
      const minMs = (md.endingSoon?.minTtlMinutes ?? 10) * 60000;
      const maxMs = (md.endingSoon?.maxTtlMinutes ?? 1440) * 60000;
      const offsetMax = Math.max(1, (runtime.marketData as any).compositeRandomOffsetMax ?? 500);
      let cursorES: string | undefined = String(Math.floor(Math.random() * offsetMax));
      let tries = 0;
      while (picked.length < Math.min(target, 1) && tries < 12) {
        tries++;
        let page: MarketSummary[] = [] as any;
        try {
          // Override recency filters to scan broadly for near-expiry
          const r = await baseFetch('updatedAt', Math.min(200, Math.max(target * 20, 64)), cursorES, '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z');
          page = r.markets;
          cursorES = r.nextCursor;
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn('Polymarket listMarkets (endingSoon pre-pick) failed', { error: (e as Error).message });
          break;
        }
        const filtered = page.filter((m) => {
          const endIso = (m as any).endDate as string | undefined;
          if (!endIso) { skippedMissingEndDate++; return false; }
          const endMs = Date.parse(endIso);
          if (!Number.isFinite(endMs)) return false;
          const ttl = endMs - nowMs;
          if (ttl < minMs || ttl > maxMs) { skippedByTtlWindow++; return false; }
          return true;
        });
        // Randomize candidate order so we don't always pick the front of recency
        for (let attempt = 0; attempt < filtered.length; attempt++) {
          const idx = Math.floor(Math.random() * filtered.length);
          const m = filtered[idx]!;
          const res = await consider(m);
          if (res.accepted) break;
        }
        if (!cursorES) break;
      }
    }
    // Orders pool (may include synthetic 'endingSoon')
    const maxProbes = Math.min(target * 10, runtime.marketData.maxCompositeProbes ?? 20);
    const logEvery = Math.max(1, runtime.marketData.probeLogEvery ?? 5);
    let probes = 0;
    let forcedEndingSoonUsed = entries.every((e) => e.sort !== 'endingSoon');
    while (picked.length < target && probes < maxProbes) {
      probes++;
      let entry = entries[Math.floor(Math.random() * entries.length)];
      if (!forcedEndingSoonUsed) {
        const first = entries.find((e) => e.sort === 'endingSoon');
        if (first) {
          entry = first;
          forcedEndingSoonUsed = true;
        }
      }
      const choice = entry.sort;
      // Clamp sample window to avoid excessive payloads relative to target
      const sampleWindow = Math.min(
        Math.max(1, entry.take || 1),
        Math.max(10, target * 3)
      );
      // Always randomize offset for composite probes EXCEPT for the synthetic 'endingSoon' window,
      // where we want the very front of the recency feed to capture near-expiry markets.
      const offsetMax = Math.max(1, (runtime.marketData as any).compositeRandomOffsetMax ?? 500);
      const offset = choice === 'endingSoon' ? '0' : String(Math.floor(Math.random() * offsetMax));
      let createdAfterIso = md.createdSinceMinutes && md.createdSinceMinutes > 0 ? new Date(Date.now() - md.createdSinceMinutes * 60000).toISOString() : undefined;
      let updatedAfterIso = md.updatedSinceMinutes && md.updatedSinceMinutes > 0 ? new Date(Date.now() - md.updatedSinceMinutes * 60000).toISOString() : undefined;
      let page: MarketSummary[] = [];
      let ttlFiltered = 0;
      let missingEnd = 0;
      let ttlMinHours: number | undefined;
      let ttlMedianHours: number | undefined;
      let ttlMaxHours: number | undefined;
      if (choice === 'endingSoon') {
        // Override recency filters to scan broadly for near-expiry
        createdAfterIso = '1970-01-01T00:00:00.000Z';
        updatedAfterIso = '1970-01-01T00:00:00.000Z';
        let markets: MarketSummary[] = [] as any;
        try {
          // Pull a fatter window to increase odds of finding short-TTL markets
          const window = Math.max(sampleWindow, Math.min(target * 10, 64));
          const r = await baseFetch('updatedAt', window, '0', createdAfterIso, updatedAfterIso);
          markets = r.markets;
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn('Polymarket listMarkets failed', { order: 'updatedAt', error: (e as Error).message });
          continue;
        }
        pagesUsed++;
        const nowMs = Date.now();
        const minMs = (md.endingSoon?.minTtlMinutes ?? 10) * 60000;
        const maxMs = (md.endingSoon?.maxTtlMinutes ?? 1440) * 60000;
        const filtered = markets.filter((m) => {
          const endIso = (m as any).endDate as string | undefined;
          if (!endIso) { skippedMissingEndDate++; missingEnd++; return false; }
          const endMs = Date.parse(endIso);
          if (!Number.isFinite(endMs)) return false;
          const ttl = endMs - nowMs;
          const ok = ttl >= minMs && ttl <= maxMs;
          if (!ok) { skippedByTtlWindow++; ttlFiltered++; }
          return ok;
        });
        page = filtered;
        const ttlMinutesList = filtered
          .map((m) => {
            const iso = (m as any).endDate as string | undefined;
            if (!iso) return undefined;
            const endMs = Date.parse(iso);
            if (!Number.isFinite(endMs)) return undefined;
            return Math.round((endMs - nowMs) / 60000);
          })
          .filter((v): v is number => typeof v === 'number' && v >= 0);
        if (ttlMinutesList.length > 0) {
          const ttlHoursSorted = ttlMinutesList
            .map((v) => Number((v / 60).toFixed(2)))
            .sort((a, b) => a - b);
          ttlMinHours = ttlHoursSorted[0];
          ttlMaxHours = ttlHoursSorted[ttlHoursSorted.length - 1];
          ttlMedianHours = ttlHoursSorted[Math.floor(ttlHoursSorted.length / 2)];
        }
      } else {
        try {
          const { markets } = await baseFetch(choice as RuntimeConfig['marketData']['sort'], sampleWindow, offset, createdAfterIso, updatedAfterIso);
          pagesUsed++;
          page = markets;
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn('Polymarket listMarkets failed', { order: choice, error: (e as Error).message });
          continue;
        }
      }
      if (page.length === 0) continue;
      const m = page[Math.floor(Math.random() * page.length)];
      const res = await consider(m);
      if (probes % logEvery === 0 && runtime.logging.verbose.markets) {
        // eslint-disable-next-line no-console
        console.log('Discovery probe', {
          probe: probes,
          maxProbes,
          order: choice,
          page: page.length,
          limit: sampleWindow,
          offset: Number(offset),
          ttlFiltered,
          missingEnd,
          ttlMinHours,
          ttlMedianHours,
          ttlMaxHours,
          picked: picked.length,
          reason: res.accepted ? 'accepted' : (res.reason ?? 'skipped'),
        });
      }
    }
    // no need to persist cursor with randomized probes; preserve keyword cursor if present
    try {
      const existingRaw = await (repo as any).getMarketDiscoveryCursor(agentId);
      let existing: any = {};
      try { existing = existingRaw ? JSON.parse(existingRaw) : {}; } catch { existing = {}; }
      await (repo as any).setMarketDiscoveryCursor(agentId, JSON.stringify({ ...(existing || {}) }));
    } catch {}
  } else {
    if (seedRandom && !cursor) cursor = String(Math.floor(Math.random() * 50));
    const fetchPage = async (limit: number, cursor?: string, sort?: RuntimeConfig['marketData']['sort'], createdAfterIso?: string, updatedAfterIso?: string) => {
      const anyClient = client as unknown as { listMarkets?: Function; listTrendingMarkets: Function };
      if (typeof anyClient.listMarkets === 'function') {
        return anyClient.listMarkets({ limit, cursor, sort, createdAfterIso, updatedAfterIso, excludeTagIds: (runtime as any)?.excludeTags ?? [] }) as Promise<{ markets: MarketSummary[]; nextCursor?: string }>;
      }
      return anyClient.listTrendingMarkets({ limit, cursor }) as Promise<{ markets: MarketSummary[]; nextCursor?: string }>;
    };
    while (picked.length < target) {
      const createdAfterIso = md.createdSinceMinutes && md.createdSinceMinutes > 0 ? new Date(Date.now() - md.createdSinceMinutes * 60000).toISOString() : undefined;
      const updatedAfterIso = md.updatedSinceMinutes && md.updatedSinceMinutes > 0 ? new Date(Date.now() - md.updatedSinceMinutes * 60000).toISOString() : undefined;
      // If someone misconfigures md.sort to 'endingSoon' in single mode, fall back to updatedAt
      const singleSort = (md.sort as any) === 'endingSoon' ? 'updatedAt' : md.sort;
      const { markets, nextCursor } = await fetchPage(target, cursor, singleSort as RuntimeConfig['marketData']['sort'], createdAfterIso, updatedAfterIso);
      pagesUsed++;
      for (const m of markets) await consider(m);
      if (!nextCursor || seenCursors.has(nextCursor)) break;
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    try {
      const existingRaw2 = await (repo as any).getMarketDiscoveryCursor(agentId);
      let existing2: any = {};
      try { existing2 = existingRaw2 ? JSON.parse(existingRaw2) : {}; } catch { existing2 = {}; }
      await (repo as any).setMarketDiscoveryCursor(agentId, JSON.stringify({ ...(existing2 || {}), single: cursor ?? '0' }));
    } catch {}
  }

  return { markets: picked, pagesUsed, counts: { selected: picked.length, droppedInvalid, skippedByFill, skippedByEval, skippedByDiscoveryCooldown, skippedByTtlWindow, skippedMissingEndDate, considered }, preferredMarketIds: Array.from(preferredIds) };
}
