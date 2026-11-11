import { createClobClientForAgent, fetchUsdcBalance, fetchConditionalBalance } from '../clients/polymarket_live';
import { END_CURSOR as POLY_END_CURSOR } from '@polymarket/clob-client/dist/constants';
import type { ClobClient } from '@polymarket/clob-client';
import { createHttpClient } from '../http/client';
import { createPolymarketClient } from '../clients/polymarket';
import type { AgentDefinition, RuntimeConfig } from '../config/schema';
import { getRepository } from '../storage';

type LiveSide = 'buy' | 'sell';
const CLOSED_POSITIONS_PAGE_SIZE = 5;

export type LiveTrade = {
  id: string;
  side: LiveSide;
  price: number;
  size: number; // shares
  marketId: string;
  tokenId: string; // CLOB asset_id
  matchTime: string; // ISO
  takerOrderId?: string;
  feeRateBps?: number;
  makerOrderId?: string;
};

export type LiveOpenOrder = {
  id: string;
  tokenId: string;
  marketId: string;
  side: LiveSide;
  price: number;
  sizeRemaining: number;
  status: string;
  createdAt: number;
};

export type LiveOpenPosition = {
  tokenId: string;
  marketId: string;
  quantity: number;
  averagePrice: number;
  bestBid?: number;
  bestAsk?: number;
  mtm?: number; // mark * quantity
};

export type LiveClosedPosition = {
  tokenId: string;
  marketId: string;
  quantity: number;
  averagePrice: number; // weighted avg entry
  exitPrice: number; // weighted avg exit
  realizedPnlForPosition: number; // net of fees
  closedAt: string; // ISO (time of last leg)
  feesPaid?: number; // total fees paid for the closed round
};

function parseNum(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : (typeof v === 'number' ? v : NaN);
  return Number.isFinite(n) ? (n as number) : undefined;
}

/**
 * Fetch latest trades for the agent. Uses cursor pagination to satisfy `limit` if provided.
 */
export async function getLiveTrades(agent: AgentDefinition, limit = 100): Promise<LiveTrade[]> {
  const live = createClobClientForAgent(agent as any);
  if (!live) return [];
  const client = live.client as any;

  // Robust approach: rely on the single-page helper which returns the latest trades
  // and slice to the requested limit. The paginated endpoint has proven brittle
  // (400 on empty params, cursor issues), which led to incomplete histories and
  // incorrect open-position reconstruction (e.g., buys without matching sells).
  // Using the latest page avoids that drift and matches the CLI snapshot behavior.
  const arr: any[] = await client.getTrades({}, true);
  return (arr ?? [])
    .map((t) => ({
      id: String(t?.id ?? ''),
      side: (String(t?.side ?? '').toLowerCase() === 'sell' ? 'sell' : 'buy') as LiveSide,
      price: parseNum(t?.price) ?? 0,
      size: parseNum(t?.size) ?? 0,
      marketId: String((t?.market || t?.asset_id) ?? ''),
      tokenId: String(t?.asset_id ?? ''),
      matchTime: (() => {
        const raw = String(t?.match_time ?? '');
        const n = Number(raw);
        if (Number.isFinite(n) && n > 1000000000 && n < 99999999999) {
          // Polymarket returns epoch seconds; normalize to ISO
          return new Date(n * 1000).toISOString();
        }
        // Fallback: try Date.parse on raw string
        const ms = Date.parse(raw);
        return Number.isFinite(ms) ? new Date(ms).toISOString() : raw;
      })(),
      takerOrderId: t?.taker_order_id ? String(t?.taker_order_id) : undefined,
      makerOrderId: t?.maker_order_id ? String(t?.maker_order_id) : undefined,
      feeRateBps: parseNum(t?.fee_rate_bps),
    }))
    .filter((r) => r.id && r.price > 0 && r.size > 0)
    .slice(0, Math.max(1, limit));
}

export async function getLiveOpenOrders(agent: AgentDefinition): Promise<LiveOpenOrder[]> {
  const live = createClobClientForAgent(agent as any);
  if (!live) return [];
  const data = await live.client.getOpenOrders();
  return (data ?? []).map((o: any) => ({
    id: String(o?.id),
    tokenId: String(o?.asset_id),
    marketId: String(o?.market || o?.asset_id || ''),
    side: (String(o?.side ?? '').toLowerCase() === 'sell' ? 'sell' : 'buy') as LiveSide,
    price: Number(o?.price ?? 0),
    sizeRemaining: Math.max(0, Number(o?.size_remaining ?? (Number(o?.original_size ?? 0) - Number(o?.size_matched ?? 0)))),
    status: String(o?.status ?? 'open'),
    createdAt: Number(o?.created_at ?? Date.now()),
  }));
}

export async function getLiveBalance(agent: AgentDefinition): Promise<number | undefined> {
  const live = createClobClientForAgent(agent as any);
  if (!live) return undefined;
  return fetchUsdcBalance(live.client);
}

export async function fetchConditionalBalancesStrict(
  client: ClobClient,
  params: { agentId: string; tokenIds: string[] },
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const tokenId of params.tokenIds) {
    try {
      const shares = await fetchConditionalBalance(client, tokenId);
      out.set(tokenId, shares);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`[CLOB] CONDITIONAL balance failed (agent=${params.agentId}, token_id=${tokenId}): ${msg}`);
    }
  }
  return out;
}

/**
 * Compute rolling-average open positions from trades; enrich with marks when available.
 */
export async function getTokenIdsToMarkFromTrades(trades: LiveTrade[]): Promise<string[]> {
  const s = new Set<string>();
  for (const t of trades) if (t.tokenId) s.add(t.tokenId);
  return [...s];
}

export function computeClosedPositionsFromTrades(
  trades: LiveTrade[],
  runtime: RuntimeConfig,
): LiveClosedPosition[] {
  // Process ascending by time; form "rounds" per token from 0 -> >0 -> 0
  const sorted = [...trades].sort((a, b) => new Date(a.matchTime).getTime() - new Date(b.matchTime).getTime());
  type Lot = { qty: number; price: number; fee?: number };
  type Round = { buys: Lot[]; sells: Lot[]; marketId: string; lastAt: string };
  const byToken = new Map<string, { qty: number; lots: Lot[]; round?: Round; marketId: string }>();
  const results: LiveClosedPosition[] = [];

  const feeOf = (t: LiveTrade) => {
    const notional = t.price * t.size;
    const bps = typeof t.feeRateBps === 'number' ? t.feeRateBps : 0;
    return Math.abs(notional) * bps / 10000;
  };

  const minQty = Math.max(0, (runtime as any)?.ui?.minOpenQuantity ?? 0.01);
  for (const t of sorted) {
    const st = byToken.get(t.tokenId) ?? { qty: 0, lots: [], marketId: t.marketId };
    if (t.side === 'buy') {
      st.qty += t.size;
      st.lots.push({ qty: t.size, price: t.price, fee: feeOf(t) });
      if (!st.round) st.round = { buys: [], sells: [], marketId: t.marketId, lastAt: t.matchTime };
      st.round.buys.push({ qty: t.size, price: t.price, fee: feeOf(t) });
      st.round.lastAt = t.matchTime;
    } else {
      let remaining = t.size;
      let sellFee = feeOf(t);
      if (!st.round) st.round = { buys: [], sells: [], marketId: t.marketId, lastAt: t.matchTime };
      st.round.sells.push({ qty: t.size, price: t.price, fee: sellFee });
      st.round.lastAt = t.matchTime;
      while (remaining > 1e-12 && st.lots.length > 0) {
        const lot = st.lots[0];
        const take = Math.min(remaining, lot.qty);
        lot.qty -= take;
        st.qty -= take;
        remaining -= take;
        if (lot.qty <= 1e-12) st.lots.shift();
      }
    }
    byToken.set(t.tokenId, st);
    // When qty returns to (approximately) zero, close a round.
    // Treat sub-tradeable dust (below minQty) as closed for consistency with UI filtering.
    if (st.qty <= Math.max(1e-12, minQty) && st.round) {
      const r = st.round;
      const buyQty = r.buys.reduce((a, x) => a + x.qty, 0);
      const sellQty = r.sells.reduce((a, x) => a + x.qty, 0);
      if (buyQty > 0 && sellQty > 0) {
        const avgEntry = r.buys.reduce((a, x) => a + x.price * x.qty, 0) / buyQty;
        const avgExit = r.sells.reduce((a, x) => a + x.price * x.qty, 0) / sellQty;
        const gross = (avgExit - avgEntry) * Math.min(buyQty, sellQty);
        const fees = r.buys.reduce((a, x) => a + (x.fee ?? 0), 0) + r.sells.reduce((a, x) => a + (x.fee ?? 0), 0);
        results.push({
          tokenId: Array.from(byToken.keys()).find(k => byToken.get(k) === st) || '',
          marketId: r.marketId,
          quantity: Math.min(buyQty, sellQty),
          averagePrice: avgEntry,
          exitPrice: avgExit,
          realizedPnlForPosition: gross - fees,
          closedAt: r.lastAt,
          feesPaid: fees,
        });
      }
      st.round = undefined; // reset for next round
    }
  }

  const maxPages = Math.max(1, (runtime as any)?.ui?.maxClosedPages ?? 12);
  const maxRows = maxPages * CLOSED_POSITIONS_PAGE_SIZE;
  return results
    .sort((a, b) => new Date(b.closedAt).getTime() - new Date(a.closedAt).getTime())
    .slice(0, maxRows);
}

const LOT_EPSILON = 1e-9;

export function deriveOpenLotsFromTrades(
  trades: LiveTrade[],
): Map<string, { quantity: number; averagePrice: number }> {
  type Lot = { qty: number; price: number };
  type TokenLots = { lots: Lot[] };
  const sorted = [...trades].sort((a, b) => {
    const ta = Date.parse(a.matchTime);
    const tb = Date.parse(b.matchTime);
    const safeA = Number.isFinite(ta) ? ta : 0;
    const safeB = Number.isFinite(tb) ? tb : 0;
    return safeA - safeB;
  });
  const byToken = new Map<string, TokenLots>();
  for (const t of sorted) {
    if (!t?.tokenId || !Number.isFinite(t.size) || !Number.isFinite(t.price)) continue;
    const rec = byToken.get(t.tokenId) ?? { lots: [] };
    if (t.side === 'buy') {
      rec.lots.push({ qty: t.size, price: t.price });
    } else {
      let remaining = t.size;
      while (remaining > LOT_EPSILON && rec.lots.length > 0) {
        const lot = rec.lots[0];
        const take = Math.min(remaining, lot.qty);
        lot.qty -= take;
        remaining -= take;
        if (lot.qty <= LOT_EPSILON) {
          rec.lots.shift();
        }
      }
      if (remaining > LOT_EPSILON) {
        rec.lots = [];
      }
    }
    byToken.set(t.tokenId, rec);
  }
  const result = new Map<string, { quantity: number; averagePrice: number }>();
  for (const [tokenId, rec] of byToken.entries()) {
    const qty = rec.lots.reduce((acc, lot) => acc + lot.qty, 0);
    if (qty <= LOT_EPSILON) continue;
    const cost = rec.lots.reduce((acc, lot) => acc + lot.qty * lot.price, 0);
    const avg = cost / qty;
    if (Number.isFinite(avg)) {
      result.set(tokenId, { quantity: qty, averagePrice: avg });
    }
  }
  return result;
}

/**
 * Fetch recent trades with pagination, bounded by UI lookback knobs. Used for closed positions on-demand.
 */
export async function getLiveTradesForClosedLookback(agent: AgentDefinition, runtime: RuntimeConfig): Promise<LiveTrade[]> {
  const live = createClobClientForAgent(agent as any);
  if (!live) return [];
  const client = live.client as any;
  const maxPages = Math.max(1, (runtime as any)?.ui?.maxClosedPages ?? 12);
  const maxRows = maxPages * CLOSED_POSITIONS_PAGE_SIZE;
  const tradesPerPositionEstimate = 12;
  const cap = Math.max(1, maxRows * tradesPerPositionEstimate);

  let cursor: string | undefined = undefined;
  const out: any[] = [];
  try {
    // Avoid sending END_CURSOR ("LTE=") to the API — it's a sentinel meaning "no more pages"
    // in the official client. Guard here to prevent 400s from the CLOB ("Invalid trade params payload").
    // See @polymarket/clob-client/dist/constants: END_CURSOR = "LTE="
    const END_CURSOR = POLY_END_CURSOR || 'LTE=';
    while (out.length < cap) {
      if (cursor === END_CURSOR) break;
      const page: any = await client.getTradesPaginated({}, cursor);
      const arr: any[] = Array.isArray(page?.trades) ? page.trades : [];
      for (const t of arr) out.push(t);
      const next: any = page?.next_cursor;
      if (!next || next === END_CURSOR || !arr.length) break;
      cursor = next;
    }
  } catch {
    // fall back to first page if pagination fails
    try { const arr = await client.getTrades({}, true); for (const t of (arr ?? [])) out.push(t); } catch {}
  }
  return (out ?? [])
    .map((t) => ({
      id: String(t?.id ?? ''),
      side: (String(t?.side ?? '').toLowerCase() === 'sell' ? 'sell' : 'buy') as LiveSide,
      price: parseNum(t?.price) ?? 0,
      size: parseNum(t?.size) ?? 0,
      marketId: String((t?.market || t?.asset_id) ?? ''),
      tokenId: String(t?.asset_id ?? ''),
      matchTime: (() => {
        const raw = String(t?.match_time ?? '');
        const n = Number(raw);
        if (Number.isFinite(n) && n > 1000000000 && n < 99999999999) return new Date(n * 1000).toISOString();
        const ms = Date.parse(raw);
        return Number.isFinite(ms) ? new Date(ms).toISOString() : raw;
      })(),
      takerOrderId: t?.taker_order_id ? String(t?.taker_order_id) : undefined,
      makerOrderId: t?.maker_order_id ? String(t?.maker_order_id) : undefined,
      feeRateBps: parseNum(t?.fee_rate_bps),
    }))
    .filter((r) => r.id && r.price > 0 && r.size > 0)
    .slice(0, cap);
}

export async function getLiveAccountSnapshot(
  agent: AgentDefinition,
  runtime: RuntimeConfig,
  opts: { tradesLimit?: number; includeOrders?: boolean; deepClosed?: boolean } = {}
): Promise<{
  balance?: number;
  trades: LiveTrade[];
  openOrders?: LiveOpenOrder[];
  openPositions: LiveOpenPosition[];
  closedPositions: LiveClosedPosition[];
  mtmTotal: number;
}> {
  const useDeep = opts.deepClosed !== false;
  const trades = useDeep
    ? await getLiveTradesForClosedLookback(agent, runtime)
    : await getLiveTrades(agent, Math.max(1, opts.tradesLimit ?? 200));
  const openLots = deriveOpenLotsFromTrades(trades);
  // Use CLOB conditional balances as the single source of truth for open
  // quantities; use trades only for cost basis and realized P&L.
  const minQty = Math.max(0, (runtime as any)?.ui?.minOpenQuantity ?? 0.01);
  const filterSmall = Boolean((runtime as any)?.ui?.filterSmallPositions ?? true);

  // Derive the token universe from both trades within the lookback window and
  // any open positions we have persisted locally. This avoids dropping older
  // still-open lots when the trade lookback is small (e.g., UI caps) while
  // still keeping the CLOB conditional balances as the canonical quantity.
  const tokenIdSet = new Set<string>();
  const tokenToMarket = new Map<string, string>();
  const tokenToAvgPrice = new Map<string, number>();
  // Only query conditional balances for tokens that appear to be open according
  // to the trade-derived lots; querying every historically-traded token can
  // explode API calls and trigger CLOB rate limits (which then present as
  // misleading 0-balance snapshots downstream).
  for (const tid of openLots.keys()) tokenIdSet.add(tid);
  try {
    const repo = await getRepository();
    const openDb = await repo.listOpenPositions(agent.id);
    for (const p of openDb as any[]) {
      if (p && typeof p.optionId === 'string' && p.optionId) {
        tokenIdSet.add(p.optionId);
        if (typeof p.marketId === 'string' && p.marketId) {
          tokenToMarket.set(p.optionId, p.marketId);
        }
        const avg = typeof p.averagePrice === 'number'
          ? p.averagePrice
          : Number(p.averagePrice);
        if (Number.isFinite(avg)) {
          tokenToAvgPrice.set(p.optionId, avg);
        }
      }
    }
  } catch {
    // If the repository is unavailable (e.g., during tests), fall back to
    // trade-derived token ids only.
  }
  const tokenIds = [...tokenIdSet];
  const live = createClobClientForAgent(agent as any);

  const condBalances = live
    ? await fetchConditionalBalancesStrict(live.client as any, { agentId: agent.id, tokenIds })
    : new Map<string, number>();

  // Compute a simple VWAP entry price per token from trades within the lookback.
  const avgPrice = new Map<string, number>();
  for (const tokenId of tokenIds) {
    const lots = openLots.get(tokenId);
    if (lots && Number.isFinite(lots.averagePrice)) {
      avgPrice.set(tokenId, lots.averagePrice);
    }
  }

  // Enrich with orderbooks for marks
  const openPositions: LiveOpenPosition[] = [];
  const http = createHttpClient(runtime.http as any);
  const poly = createPolymarketClient({
    httpClient: http,
    marketConfig: runtime.marketData,
    memoize: {
      orderBookTtlMs: (runtime.http as any)?.memoize?.clobOrderBookTtlMs,
      feeRateTtlMs: (runtime.http as any)?.memoize?.clobFeeRateTtlMs,
    },
    concurrency: { maxConcurrent: (runtime.http as any)?.hostOverrides?.['clob.polymarket.com']?.maxConcurrent ?? 4 },
  });

  for (const tokenId of tokenIds) {
    const qty = condBalances.get(tokenId) ?? 0;
    if (qty <= 0) continue;
    const tradeMarketId = trades.find((t) => t.tokenId === tokenId)?.marketId;
    const marketId = tradeMarketId || tokenToMarket.get(tokenId) || '';
    const isSmall = qty < minQty;
    let bestBid: number | undefined;
    let bestAsk: number | undefined;
    // Resolved markets: mark to payout (0 or 1) and skip CLOB books
    // Cache payout per slug this call to avoid repeated Gamma hits
    const payoutCache = new Map<string, { resolved: boolean; prices: number[] }>();
    const repoFor = await getRepository();
    const slugOf = async (mid: string): Promise<string | undefined> => {
      try {
        const ev = await (repoFor as any).getLatestEvaluationSummary(mid);
        const url = (ev as any)?.url as string | undefined;
        if (url) {
          const m = url.match(/\/market\/([a-z0-9\-]+)/i);
          if (m) return m[1];
        }
      } catch {}
      return undefined;
    };
    const payoutFor = async (mid: string, token: string): Promise<number | undefined> => {
      const slug = await slugOf(mid);
      if (!slug) return undefined;
      let entry = payoutCache.get(slug);
      if (!entry) {
        const arr = await poly.getMarketsBySlug(slug);
        const mkt = arr.find((m) => (m as any)?.id === mid) || arr[0];
        if (!mkt) return undefined;
        const resolved = (mkt as any)?.closed === true && String((mkt as any)?.umaResolutionStatus || '').toLowerCase() === 'resolved';
        const prices = (mkt.outcomes ?? []).map((o) => (typeof o.price === 'number' ? o.price : NaN));
        entry = { resolved, prices };
        payoutCache.set(slug, entry);
      }
      if (!entry.resolved) return undefined;
      try {
        const idx = await (repoFor as any).getOutcomeIndexByClobTokenId(mid, token);
        if (typeof idx === 'number') {
          const v = entry.prices[idx];
          return Number.isFinite(v) ? (v as number) : undefined;
        }
      } catch {}
      return undefined;
    };

    if (!(filterSmall && isSmall)) {
      // Try payout first
      const payout = marketId ? await payoutFor(marketId, tokenId) : undefined;
      if (typeof payout === 'number') {
        bestBid = payout;
        bestAsk = payout;
      } else {
        try {
          const ob = await poly.getOrderBook(tokenId);
          bestBid = ob?.bids?.[0]?.price;
          bestAsk = ob?.asks?.[0]?.price;
        } catch {}
      }
    }
    const avgFromTrades = avgPrice.get(tokenId);
    const avgFromDb = tokenToAvgPrice.get(tokenId);
    // Single source of truth for entry cost: prefer DB positions (which already
    // incorporate prior buys/sells) and fall back to trade-derived VWAP only
    // when no persisted open position exists for this token.
    const avg =
      typeof avgFromDb === 'number'
        ? avgFromDb
        : typeof avgFromTrades === 'number'
          ? avgFromTrades
          : 0;
    const mark = typeof bestBid === 'number' ? bestBid : (typeof bestAsk === 'number' ? bestAsk : avg);
    openPositions.push({ tokenId, marketId, quantity: qty, averagePrice: avg, bestBid, bestAsk, mtm: mark * qty });
  }

  const filteredOpen = filterSmall ? openPositions.filter((p) => p.quantity >= minQty) : openPositions;
  const closedPositions = computeClosedPositionsFromTrades(trades, runtime);
  const mtmTotal = filteredOpen.reduce((a, p) => a + (p.mtm ?? 0), 0);
  const [balance, openOrders] = await Promise.all([
    getLiveBalance(agent),
    opts.includeOrders ? getLiveOpenOrders(agent) : Promise.resolve(undefined),
  ]);
  return { balance, trades, openOrders, openPositions: filteredOpen, closedPositions, mtmTotal };
}
