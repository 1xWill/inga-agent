import type { AgentDefinition, RuntimeConfig } from '../config/schema';
import type { AgentRepositoryAsync } from '../storage/types';
import { getLiveAccountSnapshot } from '../server/liveAccount';

type SyncParams = {
  agent: AgentDefinition;
  runtime: RuntimeConfig;
  repo: AgentRepositoryAsync;
  log?: (msg: string, data?: Record<string, unknown>) => void;
};

type SyncResult = {
  upserted: number;
  closed: number;
};

const keyFor = (marketId: string, tokenId: string) => `${marketId}:${tokenId}`;

export async function syncLivePositionsFromSnapshot({
  agent,
  runtime,
  repo,
  log,
}: SyncParams): Promise<SyncResult> {
  if (agent.paperTrading !== false) return { upserted: 0, closed: 0 };

  const minQty = Math.max(0, (runtime as any)?.ui?.minOpenQuantity ?? 0.01);
  const existing = await repo.listOpenPositions(agent.id);
  const existingMap = new Map(
    existing.map((p) => [keyFor(p.marketId, p.optionId), p]),
  );

  const snapshot = await getLiveAccountSnapshot(agent, runtime, {
    includeOrders: false,
    deepClosed: false,
  });
  const livePositions = snapshot.openPositions ?? [];
  const lastBuyByKey = new Map<string, Date>();
  for (const trade of snapshot.trades ?? []) {
    if (!trade || trade.side !== 'buy') continue;
    const ms = Date.parse(trade.matchTime);
    if (!Number.isFinite(ms)) continue;
    const keyBuy = keyFor(trade.marketId, trade.tokenId);
    const prev = lastBuyByKey.get(keyBuy);
    if (!prev || ms > prev.getTime()) {
      lastBuyByKey.set(keyBuy, new Date(ms));
    }
  }
  const liveKeys = new Set<string>();
  let upserted = 0;

  for (const pos of livePositions) {
    if (!pos || pos.quantity < minQty) continue;
    const key = keyFor(pos.marketId, pos.tokenId);
    liveKeys.add(key);
    const prev = existingMap.get(key);
    const openedAtRaw = lastBuyByKey.get(key) ?? prev?.openedAt;
    const openedAt =
      openedAtRaw instanceof Date
        ? openedAtRaw
        : openedAtRaw
          ? new Date(openedAtRaw)
          : new Date();
    const avgFromSnapshot =
      typeof pos.averagePrice === 'number' && Number.isFinite(pos.averagePrice)
        ? pos.averagePrice
        : undefined;
    const avg =
      avgFromSnapshot ??
      (typeof prev?.averagePrice === 'number'
        ? prev.averagePrice
        : typeof pos.bestAsk === 'number'
          ? pos.bestAsk
          : typeof pos.bestBid === 'number'
            ? pos.bestBid
            : 0);
    await repo.upsertPosition({
      agentId: agent.id,
      marketId: pos.marketId,
      optionId: pos.tokenId,
      direction: 'buy',
      quantity: pos.quantity,
      averagePrice: avg,
      status: 'open',
      openedAt,
    });
    upserted += 1;
  }

  const lastTradeMs = new Map<string, number>();
  for (const trade of snapshot.trades ?? []) {
    if (!trade?.marketId || !trade?.tokenId) continue;
    const ms = Date.parse(trade.matchTime);
    if (!Number.isFinite(ms)) continue;
    const key = keyFor(trade.marketId, trade.tokenId);
    const prev = lastTradeMs.get(key) ?? 0;
    if (ms > prev) lastTradeMs.set(key, ms);
  }

  let closed = 0;
  for (const pos of existing) {
    const key = keyFor(pos.marketId, pos.optionId);
    if (liveKeys.has(key)) continue;
    const ts = lastTradeMs.get(key) ?? Date.now();
    await repo.closePosition(agent.id, pos.marketId, pos.optionId, new Date(ts));
    closed += 1;
  }

  if ((upserted > 0 || closed > 0) && log) {
    log('Live positions synced from snapshot', {
      agentId: agent.id,
      upserted,
      closed,
    });
  }

  return { upserted, closed };
}
