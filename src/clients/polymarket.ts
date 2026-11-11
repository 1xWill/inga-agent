import type { HttpClient } from '../http/client';
import type { RuntimeConfig } from '../config/schema';

export interface PolymarketClientOptions {
  httpClient: HttpClient;
  apiKey?: string;
  baseUrl?: string;
  marketConfig?: Partial<RuntimeConfig['marketData']>;
  memoize?: { orderBookTtlMs?: number; feeRateTtlMs?: number; priceHistoryTtlMs?: number };
  concurrency?: { maxConcurrent?: number };
  excludeTags?: string[];
  logger?: (msg: string, data?: unknown) => void;
}

export interface MarketListParams {
  limit: number;
  cursor?: string; // treated as numeric offset when using Gamma API
  sort?: RuntimeConfig['marketData']['sort'];
  createdAfterIso?: string;
  updatedAfterIso?: string;
  includeTagIds?: string[];
  excludeTagIds?: string[];
  eventId?: string;
}

export interface OrderBookLevel {
  price: number;
  quantity: number;
}

export interface OrderBookSnapshot {
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
}

export interface PriceHistoryPoint {
  t: number; // unix seconds
  p: number; // price 0..1
}

export interface MarketOutcome {
  id: string;
  name: string;
  price?: number;
  liquidity?: number;
  bestBid?: number;
  bestAsk?: number;
  bidLevels?: OrderBookLevel[];
  askLevels?: OrderBookLevel[];
  // When available from Gamma (clobTokenIds), this is the canonical CLOB token id for orderbooks/fees
  clobTokenId?: string;
}

export interface MarketSummary {
  id: string;
  question: string;
  outcomes: MarketOutcome[];
  orderBook?: OrderBookSnapshot;
  volume24Hr?: number;
  url?: string; // market URL
  slug?: string; // market slug
  eventSlug?: string;
  eventTitle?: string;
  questionId?: string;
  endDate?: string; // ISO end date when available (Gamma)
  // Pass-through flags from Gamma when available
  closed?: boolean;
  active?: boolean;
  // UMA resolution status string (e.g., 'resolved') when provided
  umaResolutionStatus?: string;
  closedTime?: string;
}
// Event summary (Gamma) minimal shape for sibling markets expansion
interface GammaEventSummary {
  id?: string;
  title?: string;
  slug: string;
  markets?: GammaMarketSummary[];
}

// Gamma Markets API response shape (array of markets)
// See: https://docs.polymarket.com/developers/gamma-markets-api/get-markets and
// https://docs.polymarket.com/api-reference/markets/list-markets
interface GammaMarketSummary {
  id: string;
  question: string;
  slug?: string;
  conditionId: string;
  outcomes?: string; // JSON-encoded array of outcome names
  outcomePrices?: string; // JSON-encoded array of prices (strings)
  clobTokenIds?: string; // JSON-encoded array of token ids
  closed?: boolean;
  active?: boolean;
  archived?: boolean;
  updatedAt?: string;
  endDate?: string;
  // Optional fields we rely on when present
  events?: Array<{ slug?: string; title?: string }>;
  questionID?: string;
}

export interface MarketListResult {
  markets: MarketSummary[];
  nextCursor?: string;
}

const DEFAULT_BASE_URL = 'https://gamma-api.polymarket.com';

export class PolymarketClient {
  private readonly httpClient: HttpClient;
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly marketConfig?: Partial<RuntimeConfig['marketData']>;
  private readonly clobBaseUrl = 'https://clob.polymarket.com';
  private readonly siteBaseUrl = 'https://polymarket.com';
  private readonly obTtlMs: number;
  private readonly feeTtlMs: number;
  private readonly phTtlMs: number;
  private readonly obCache = new Map<string, { ts: number; data?: OrderBookSnapshot }>();
  private readonly feeCache = new Map<string, { ts: number; data?: number }>();
  private readonly phCache = new Map<string, { ts: number; data?: PriceHistoryPoint[] }>();
  private readonly maxConcurrent: number;
  private inFlight = 0;
  private queue: Array<() => void> = [];
  private readonly logger?: (msg: string, data?: unknown) => void;
  private readonly excludeTags?: string[];

  constructor({ httpClient, apiKey, baseUrl, marketConfig, memoize, concurrency, excludeTags, logger }: PolymarketClientOptions) {
    this.httpClient = httpClient;
    this.apiKey = apiKey;
    this.baseUrl = baseUrl ?? DEFAULT_BASE_URL;
    this.marketConfig = marketConfig;
    this.obTtlMs = Math.max(0, memoize?.orderBookTtlMs ?? 2500);
    this.feeTtlMs = Math.max(0, memoize?.feeRateTtlMs ?? 2500);
    this.phTtlMs = Math.max(0, memoize?.priceHistoryTtlMs ?? 60_000);
    this.maxConcurrent = Math.max(0, concurrency?.maxConcurrent ?? 4);
    this.logger = logger;
    this.excludeTags = Array.isArray(excludeTags) ? excludeTags : undefined;
  }

  private log(msg: string, data?: unknown) {
    if (this.logger) this.logger(msg, data);
  }

  private async withConcurrency<T>(fn: () => Promise<T>): Promise<T> {
    if (this.maxConcurrent > 0 && this.inFlight >= this.maxConcurrent) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.inFlight += 1;
    try {
      const res = await fn();
      return res;
    } finally {
      this.inFlight -= 1;
      const next = this.queue.shift();
      if (next) next();
    }
  }

  async listTrendingMarkets({ limit, cursor }: MarketListParams): Promise<MarketListResult> {
    return this.listMarkets({ limit, cursor });
  }

  async getPriceHistory(params: {
    tokenId: string;
    interval?: '1m' | '1w' | '1d' | '6h' | '1h' | 'max';
    fidelityMinutes?: number;
    startTs?: number;
    endTs?: number;
  }): Promise<PriceHistoryPoint[]> {
    const tokenId = String(params.tokenId ?? '').trim();
    if (!/^\d+$/.test(tokenId)) return [];
    const interval = params.interval;
    const fidelityMinutes =
      typeof params.fidelityMinutes === 'number' && Number.isFinite(params.fidelityMinutes)
        ? Math.max(1, Math.round(params.fidelityMinutes))
        : undefined;
    const startTs =
      typeof params.startTs === 'number' && Number.isFinite(params.startTs) ? Math.round(params.startTs) : undefined;
    const endTs =
      typeof params.endTs === 'number' && Number.isFinite(params.endTs) ? Math.round(params.endTs) : undefined;

    const key = `${tokenId}|${interval ?? ''}|${fidelityMinutes ?? ''}|${startTs ?? ''}|${endTs ?? ''}`;
    const cached = this.phCache.get(key);
    const now = Date.now();
    if (cached && now - cached.ts < this.phTtlMs) return cached.data ?? [];

    const url = new URL('/prices-history', this.clobBaseUrl);
    url.searchParams.set('market', tokenId);
    if (interval) url.searchParams.set('interval', interval);
    if (typeof fidelityMinutes === 'number') url.searchParams.set('fidelity', String(fidelityMinutes));
    if (typeof startTs === 'number') url.searchParams.set('startTs', String(startTs));
    if (typeof endTs === 'number') url.searchParams.set('endTs', String(endTs));

    const started = Date.now();
    try {
      const resp = await this.withConcurrency(() =>
        this.httpClient<{ history?: PriceHistoryPoint[] }>(url.toString(), { headers: this.buildHeaders() }),
      );
      const hist = Array.isArray(resp?.history) ? (resp.history as PriceHistoryPoint[]).filter(Boolean) : [];
      this.phCache.set(key, { ts: now, data: hist });
      this.log('polymarket:getPriceHistory', {
        tokenId,
        interval: interval ?? null,
        fidelityMinutes: fidelityMinutes ?? null,
        points: hist.length,
        durationMs: Date.now() - started,
      });
      return hist;
    } catch (e: any) {
      this.log('polymarket:getPriceHistory error', { tokenId, interval: interval ?? null, msg: String(e?.message || e) });
      this.phCache.set(key, { ts: now, data: [] });
      return [];
    }
  }

  async listMarkets({ limit, cursor, sort, createdAfterIso, updatedAfterIso, includeTagIds, excludeTagIds, eventId }: MarketListParams): Promise<MarketListResult> {
    const url = new URL('/markets', this.baseUrl);
    const offset = cursor ? Number(cursor) || 0 : 0;
    url.searchParams.set('limit', String(limit));
    if (offset > 0) url.searchParams.set('offset', String(offset));

    // Sort (explicit param wins, then config)
    const s = sort ?? this.marketConfig?.sort;
    if (s) url.searchParams.set('sort', s);

    // Filter by event id if provided
    if (eventId && eventId.length > 0) url.searchParams.set('event_id', eventId);

    // Currently-open markets only
    url.searchParams.set('closed', 'false');
    url.searchParams.set('active', 'true');
    url.searchParams.set('archived', 'false');

    // Recency windows
    if (updatedAfterIso) url.searchParams.set('updated_after', updatedAfterIso);
    else if (this.marketConfig?.updatedSinceMinutes && this.marketConfig.updatedSinceMinutes > 0) {
      const dt = new Date(Date.now() - this.marketConfig.updatedSinceMinutes * 60000).toISOString();
      url.searchParams.set('updated_after', dt);
    }
    if (createdAfterIso && createdAfterIso.length > 0) url.searchParams.set('created_after', createdAfterIso);
    else if (this.marketConfig?.createdSinceMinutes && this.marketConfig.createdSinceMinutes > 0) {
      const ct = new Date(Date.now() - this.marketConfig.createdSinceMinutes * 60000).toISOString();
      url.searchParams.set('created_after', ct);
    }

    // Tag filter (inclusion). Multiple tag_id can be comma-separated if supported; fallback to first if not.
    if (includeTagIds && includeTagIds.length > 0) {
      url.searchParams.set('tag_id', includeTagIds.join(','));
    } else if (this.marketConfig?.includeTagIds && this.marketConfig.includeTagIds.length > 0) {
      url.searchParams.set('tag_id', this.marketConfig.includeTagIds.join(','));
    }
    // Tag filter (exclusion): exclude_tag_id supported by Gamma
    const exclude = (excludeTagIds && excludeTagIds.length > 0)
      ? excludeTagIds
      : (this.excludeTags && this.excludeTags.length > 0 ? this.excludeTags : undefined);
    if (exclude && exclude.length > 0) url.searchParams.set('exclude_tag_id', exclude.join(','));

    const started = Date.now();
    const response = await this.httpClient<GammaMarketSummary[]>(url.toString(), { headers: this.buildHeaders() });
    this.log('polymarket:listMarkets response', {
      durationMs: Date.now() - started,
      requested: limit,
      received: response?.length ?? 0,
      sort: url.searchParams.get('sort'),
      offset,
      eventId: eventId ?? null,
      updatedAfterIso: url.searchParams.get('updated_after'),
      createdAfterIso: url.searchParams.get('created_after'),
    });
    const markets: MarketSummary[] = [];
    const filtered = (response ?? []).filter((m) => !m.closed && m.active !== false && m.archived !== true);
    for (const m of filtered) markets.push(this.mapGammaMarket(m));
    const nextCursor = response && response.length === limit ? String(offset + response.length) : undefined;
    return { markets, nextCursor };
  }

  async listMarketsByEventId(eventId: string, limit: number = 100, cursor?: string): Promise<MarketListResult> {
    return this.listMarkets({ limit, cursor, eventId });
  }

  async getMarketsBySlug(slug: string): Promise<MarketSummary[]> {
    if (!slug) return [];
    const url = new URL('/markets', this.baseUrl);
    url.searchParams.set('slug', slug);
    try {
      const started = Date.now();
      const resp = await this.httpClient<GammaMarketSummary[]>(url.toString(), { headers: this.buildHeaders() });
      const mapped = (resp ?? []).map((m) => this.mapGammaMarket(m));
      this.log('polymarket:getMarketsBySlug', { slug, durationMs: Date.now() - started, markets: mapped.length });
      return mapped;
    } catch {
      this.log('polymarket:getMarketsBySlug error', { slug });
      return [];
    }
  }

  /**
   * Resolve the event slug by scraping the public market webpage.
   * Looks for the first href="/event/<slug>" occurrence.
   */
  async resolveEventSlugFromMarketSlug(marketSlug: string): Promise<string | undefined> {
    if (!marketSlug) return undefined;
    const url = new URL(`/market/${marketSlug}`, this.siteBaseUrl).toString();
    try {
      const started = Date.now();
      const html = await this.httpClient<string>(url, { headers: { accept: 'text/html' } as any, parseJson: false });
      const m = (html ?? '').match(/href="\/event\/([a-z0-9\-]+)"/i);
      const slug = m?.[1];
      this.log('polymarket:resolveEventSlugFromMarketSlug', { marketSlug, eventSlug: slug ?? null, durationMs: Date.now() - started });
      return slug;
    } catch (e) {
      this.log('polymarket:resolveEventSlugFromMarketSlug error', { marketSlug, error: (e as Error).message });
      return undefined;
    }
  }

  async getOrderBook(tokenId: string): Promise<OrderBookSnapshot | undefined> {
    const url = new URL('/book', this.clobBaseUrl);
    url.searchParams.set('token_id', tokenId);
    // short-ttl memoization per client instance
    const now = Date.now();
    const hit = this.obCache.get(tokenId);
    if (hit && now - hit.ts <= this.obTtlMs) {
      this.log('polymarket:getOrderBook cacheHit', { tokenId });
      return hit.data;
    }
    try {
      // Acquire concurrency slot only for the network call
      return await this.withConcurrency(async () => {
      const started = Date.now();
      const resp = await this.httpClient<{
        bids?: Array<{ price: string; size: string }>;
        asks?: Array<{ price: string; size: string }>;
      }>(url.toString(), {});

      const toLevels = (rows?: Array<{ price: string; size: string }>): OrderBookLevel[] =>
        (rows ?? [])
          .map((r) => ({ price: Number(r.price), quantity: Number(r.size) }))
          .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.quantity));

      // Normalize: sort levels so index 0 is best-of-book
      const bids = toLevels(resp.bids).sort((a, b) => b.price - a.price);
      const asks = toLevels(resp.asks).sort((a, b) => a.price - b.price);

        const snapshot = { bids, asks } as OrderBookSnapshot;
        this.obCache.set(tokenId, { ts: now, data: snapshot });
        this.log('polymarket:getOrderBook network', {
          tokenId,
          durationMs: Date.now() - started,
          bids: bids.length,
          asks: asks.length,
        });
        return snapshot;
      });
    } catch (e) {
      // 404 or invalid response: no orderbook for token; return undefined
      this.obCache.set(tokenId, { ts: now, data: undefined });
      this.log('polymarket:getOrderBook error', { tokenId, error: (e as Error).message });
      return undefined;
    }
  }

  /**
   * Fetch per-token base fee rate (bps) from the CLOB public endpoint.
   * Returns undefined when unavailable.
   */
  async getFeeRateBps(tokenId: string): Promise<number | undefined> {
    if (!tokenId) return undefined;
    const url = new URL('/fee-rate', this.clobBaseUrl);
    url.searchParams.set('token_id', tokenId);
    const now = Date.now();
    const hit = this.feeCache.get(tokenId);
    if (hit && now - hit.ts <= this.feeTtlMs) {
      this.log('polymarket:getFeeRateBps cacheHit', { tokenId });
      return hit.data;
    }
    try {
      return await this.withConcurrency(async () => {
        const started = Date.now();
        const resp = await this.httpClient<{ base_fee?: number }>(url.toString(), {});
        const bps = typeof resp?.base_fee === 'number' ? resp.base_fee : undefined;
        const val = Number.isFinite(bps as number) ? (bps as number) : undefined;
        this.feeCache.set(tokenId, { ts: now, data: val });
        this.log('polymarket:getFeeRateBps network', { tokenId, durationMs: Date.now() - started, hasFee: typeof val === 'number' });
        return val;
      });
    } catch {
      this.feeCache.set(tokenId, { ts: now, data: undefined });
      this.log('polymarket:getFeeRateBps error', { tokenId });
      return undefined;
    }
  }

  /**
   * Fetch all sibling markets for an event by slug. Falls back to empty list if not available.
   */
  async listEventMarketsBySlug(slug: string): Promise<MarketSummary[]> {
    if (!slug || slug.trim().length === 0) return [];
    let candidates: MarketSummary[] = [];
    try {
      const started = Date.now();
      const url = new URL('/events', this.baseUrl);
      url.searchParams.set('slug', slug);
      const events = await this.httpClient<GammaEventSummary[] | GammaEventSummary>(url.toString(), { headers: this.buildHeaders() });
      const arr = Array.isArray(events) ? events : (events ? [events] : []);
      const ev = arr.find((e) => (e as any)?.slug === slug);
      // Prefer embedded markets from the event record when present.
      const embedded = (ev as any)?.markets as GammaMarketSummary[] | undefined;
      if (embedded && embedded.length > 0) {
        const filtered = embedded.filter((m) => !m.closed && m.active !== false && m.archived !== true);
        candidates = filtered.map((m) => this.mapGammaMarket(m));
        // Ensure eventSlug/eventTitle are populated even if the embedded records omit events[]
        for (const c of candidates) {
          if (!(c as any).eventSlug) (c as any).eventSlug = slug;
          const evTitle = (ev as any)?.title as string | undefined;
          if (evTitle && !(c as any).eventTitle) (c as any).eventTitle = evTitle;
        }
        this.log('polymarket:listEventMarketsBySlug embedded', { slug, durationMs: Date.now() - started, markets: candidates.length });
      } else {
        const evId = (ev as any)?.id as string | undefined;
        if (evId && evId.length > 0) {
          const { markets } = await this.listMarketsByEventId(evId, 1000);
          // Safety filter: some deployments ignore event_id; restrict to matching eventSlug
          const matched = markets.filter((m) => ((m as any)?.eventSlug as string | undefined) === slug);
          // Ensure eventSlug/eventTitle present
          candidates = matched.map((m) => ({ ...m, eventSlug: (m as any).eventSlug ?? slug, eventTitle: (m as any).eventTitle ?? ((ev as any)?.title as string | undefined) }));
          this.log('polymarket:listEventMarketsBySlug direct_filtered', { slug, durationMs: Date.now() - started, markets: candidates.length });
        }
      }
    } catch {
      // ignore and fall through to wide scan below
    }
    // Wide scan fallback when no candidates were found above
    if (candidates.length === 0) {
      try {
        const started = Date.now();
        const scanUrl = new URL('/markets', this.baseUrl);
        scanUrl.searchParams.set('limit', '1000');
        scanUrl.searchParams.set('sort', 'updatedAt');
        scanUrl.searchParams.set('closed', 'false');
        scanUrl.searchParams.set('active', 'true');
        scanUrl.searchParams.set('archived', 'false');
        const all = await this.httpClient<GammaMarketSummary[]>(scanUrl.toString(), { headers: this.buildHeaders() });
        const siblings = (all ?? []).filter((m: any) => Array.isArray(m?.events) && m.events.some((e: any) => e?.slug === slug));
        candidates = siblings.map((m) => this.mapGammaMarket(m));
        for (const c of candidates) {
          if (!(c as any).eventSlug) (c as any).eventSlug = slug;
        }
        this.log('polymarket:listEventMarketsBySlug wideScan', { slug, durationMs: Date.now() - started, markets: candidates.length });
      } catch {
        // final fallback: empty
        this.log('polymarket:listEventMarketsBySlug wideScan error', { slug });
      }
    }
    return candidates;
  }

  /**
   * Fetch sibling markets by shared questionID (Gamma field). Useful when events[] is missing.
   */
  async listMarketsByQuestionId(questionId: string): Promise<MarketSummary[]> {
    if (!questionId) return [];
    const scanUrl = new URL('/markets', this.baseUrl);
    scanUrl.searchParams.set('limit', '1000');
    scanUrl.searchParams.set('sort', 'updatedAt');
    scanUrl.searchParams.set('closed', 'false');
    scanUrl.searchParams.set('active', 'true');
    scanUrl.searchParams.set('archived', 'false');
    const started = Date.now();
    const all = await this.httpClient<GammaMarketSummary[]>(scanUrl.toString(), { headers: this.buildHeaders() });
    const siblings = (all ?? []).filter((m) => (m as any)?.questionID === questionId);
    const mapped = siblings.map((m) => this.mapGammaMarket(m));
    this.log('polymarket:listMarketsByQuestionId', { questionId, durationMs: Date.now() - started, markets: mapped.length });
    return mapped;
  }

  private mapGammaMarket(market: GammaMarketSummary): MarketSummary {
    let outcomeNames: string[] = [];
    let prices: number[] = [];
    let tokenIds: string[] = [];
    try {
      outcomeNames = market.outcomes ? (JSON.parse(market.outcomes) as string[]) : [];
    } catch {}
    try {
      prices = market.outcomePrices ? (JSON.parse(market.outcomePrices) as (string|number)[]).map((p) => Number(p)) : [];
    } catch {}
    try {
      tokenIds = market.clobTokenIds ? (JSON.parse(market.clobTokenIds) as string[]) : [];
    } catch {}

    // Use a robust market id (conditionIdPreferred -> id) for fallback token ids
    const id = market.conditionId && market.conditionId.length > 0 ? market.conditionId : (market.id ?? '');
    if (!Array.isArray(tokenIds) || tokenIds.length === 0) {
      this.log('polymarket:mapGammaMarket missingClobTokenIds', {
        conditionId: market.conditionId,
        id,
        slug: market.slug,
        hasTokenIds: false,
      });
    }
    const outcomes: MarketOutcome[] = outcomeNames.map((name, idx) => ({
      id: tokenIds[idx] ?? `${id}:${idx}`,
      name,
      price: Number.isFinite(prices[idx]) ? prices[idx] : undefined,
      clobTokenId: tokenIds[idx] ?? undefined
    }));

    const ev0 = market?.events?.[0];
    const eventSlug = ev0?.slug as string | undefined;
    const eventTitle = ev0?.title as string | undefined;
    const questionId = (market as any)?.questionID as string | undefined;
    return {
      id,
      question: market.question,
      outcomes,
      orderBook: undefined,
      volume24Hr: undefined,
      url: market.slug ? `https://polymarket.com/market/${market.slug}` : undefined,
      slug: market.slug,
      eventSlug,
      eventTitle,
      questionId,
      endDate: market.endDate,
      closed: market.closed,
      active: market.active,
      umaResolutionStatus: (market as any)?.umaResolutionStatus,
      closedTime: (market as any)?.closedTime,
    };
  }

  async publicSearch(params: {
    q: string;
    limitPerType: number;
    page?: number;
    sort?: RuntimeConfig['keywordSearchSort'];
    excludeTagIds?: string[];
  }): Promise<MarketSummary[]> {
    const q = String(params.q ?? '').trim();
    if (!q) return [];
    const url = new URL('/public-search', this.baseUrl);
    url.searchParams.set('q', q);
    url.searchParams.set('limit_per_type', String(Math.max(1, Math.min(100, params.limitPerType))));
    url.searchParams.set('page', String(Math.max(0, params.page ?? 0)));
    // fixed toggles per plan
    url.searchParams.set('search_profiles', 'false');
    url.searchParams.set('search_tags', 'false');
    url.searchParams.set('events_status', 'active');
    url.searchParams.set('keep_closed_markets', '0');
    url.searchParams.set('optimized', 'true');
    url.searchParams.set('ascending', 'false');
    if (params.sort) url.searchParams.set('sort', params.sort);
    const excl = (params.excludeTagIds && params.excludeTagIds.length > 0)
      ? params.excludeTagIds
      : (this.excludeTags && this.excludeTags.length > 0 ? this.excludeTags : undefined);
    if (excl && excl.length > 0) url.searchParams.set('exclude_tag_id', excl.join(','));

    type SearchMarket = { slug?: string; active?: boolean; closed?: boolean };
    type SearchEvent = { markets?: SearchMarket[] };
    type SearchResponse = { markets?: SearchMarket[]; events?: SearchEvent[] } | undefined;

    const started = Date.now();
    const resp = await this.httpClient<SearchResponse>(url.toString(), { headers: this.buildHeaders() });
    this.log('polymarket:publicSearch', { q, durationMs: Date.now() - started, ok: !!resp });
    const slugs = new Set<string>();
    const addSlug = (m?: SearchMarket) => {
      const ok = m && m.slug && m.active !== false && m.closed !== true;
      if (ok) slugs.add(m!.slug!);
    };
    for (const m of (resp?.markets ?? [])) addSlug(m);
    for (const ev of (resp?.events ?? [])) for (const m of (ev.markets ?? [])) addSlug(m);
    if (slugs.size === 0) return [];

    // Resolve each slug to normalized MarketSummary via /markets
    const results: MarketSummary[] = [];
    const seen = new Set<string>();
    const tasks = Array.from(slugs).map((slug) => this.withConcurrency(async () => {
      const arr = await this.getMarketsBySlug(slug);
      for (const m of arr) {
        // Strictly filter here as well; getMarketsBySlug maps Gamma fields
        const closed = (m as any)?.closed as boolean | undefined;
        const active = (m as any)?.active as boolean | undefined;
        if (closed === true || active === false) continue;
        // Prefer conditionId (id in our mapping is conditionId when available)
        const key = String(m.id ?? '') + '::' + String(m.slug ?? '');
        if (seen.has(key)) continue;
        seen.add(key);
        results.push(m);
      }
    }));
    await Promise.all(tasks);
    return results;
  }

  private buildHeaders(): HeadersInit | undefined {
    if (!this.apiKey) {
      return undefined;
    }

    return {
      Authorization: `Bearer ${this.apiKey}`
    };
  }
}

// Utility to detect whether a given string is a valid CLOB token id (decimal digits)
export function isClobTokenId(candidate: string | undefined): boolean {
  if (!candidate) return false;
  return /^\d+$/.test(candidate.trim());
}

export function createPolymarketClient(options: PolymarketClientOptions) {
  return new PolymarketClient(options);
}
