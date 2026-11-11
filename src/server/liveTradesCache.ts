// Simple per-agent in-memory cache of live trades to avoid hammering the CLOB
// on frequent dashboard/API polls. Shared by /api/fills and the orders refresher.
// TTL kept short (default 3s) to preserve freshness.

import type { AgentDefinition } from '../config/schema';
import { getLiveTrades, type LiveTrade } from './liveAccount';

type Entry = { ts: number; trades: LiveTrade[] };
const cache = new Map<string, Entry>();

export async function getCachedLiveTrades(
  agent: AgentDefinition,
  limit: number = 100,
  opts: { ttlMs?: number } = {}
): Promise<LiveTrade[]> {
  const ttlMsRaw = opts.ttlMs ?? 3000;
  const force = typeof ttlMsRaw === 'number' && ttlMsRaw <= 0;
  const ttlMs = force ? 0 : Math.max(500, ttlMsRaw);
  const key = agent.id;
  const now = Date.now();
  const ent = cache.get(key);
  if (!force && ent && now - ent.ts < ttlMs && ent.trades.length > 0) {
    // Return a slice to the requested limit (cached array is newest-first already)
    return ent.trades.slice(0, Math.max(1, limit));
  }
  const trades = await getLiveTrades(agent, Math.max(1, limit));
  cache.set(key, { ts: now, trades });
  return trades.slice(0, Math.max(1, limit));
}

// Find the latest execution time for a given order id using cached live trades.
// Returns an ISO timestamp string when found.
export async function findLatestExecutionTime(
  agent: AgentDefinition,
  orderId: string,
  opts: { ttlMs?: number; fallbackByToken?: { tokenId?: string; side?: 'buy' | 'sell'; after?: string } }
): Promise<string | undefined> {
  if (!orderId) return undefined;
  const trades = await getCachedLiveTrades(agent, 200, { ttlMs: opts?.ttlMs });
  // Match by either taker or maker order id (our order could be maker on the book)
  const byOrder = trades.filter((t) => String(t.takerOrderId || '') === orderId || String(t.makerOrderId || '') === orderId);
  if (byOrder.length > 0) {
    return byOrder
      .map((t) => t.matchTime)
      .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0];
  }
  const fb = opts?.fallbackByToken;
  if (fb?.tokenId && fb?.side) {
    const afterMs = fb.after ? Date.parse(fb.after) : undefined;
    const alt = trades.filter((t) => t.tokenId === fb.tokenId && t.side === fb.side && (!afterMs || Date.parse(t.matchTime) >= afterMs));
    if (alt.length > 0) {
      return alt
        .map((t) => t.matchTime)
        .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0];
    }
  }
  return undefined;
}
