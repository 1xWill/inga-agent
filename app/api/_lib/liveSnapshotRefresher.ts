import type { RuntimeConfig } from '../../../src/config/schema';
import { loadAgentsConfig } from '../../../src/config/loaders';
import { getLiveAccountSnapshot } from '../../../src/server/liveAccount';
import { upsertLiveSnapshot } from './liveSnapshots';
import { getRepository } from './db';

type Timer = ReturnType<typeof setInterval>;
const timers = new Map<string, Timer>();

export function ensureLiveSnapshotRefresher(agentId: string, runtime: RuntimeConfig) {
  const key = agentId || 'default';
  if (timers.has(key)) return;
  // Use marksRefresher cadence by default for parity
  const intervalMinutes = Math.max(1 / 60, runtime.marksRefresher?.intervalMinutes ?? 10 / 60);
  const periodMs = Math.max(1000, intervalMinutes * 60 * 1000);
  const timer = setInterval(async () => {
    try {
      const agents = await loadAgentsConfig(process.cwd());
      const ag = agents.agents.find((a) => a.id === agentId);
      if (!ag || !ag.enabled || ag.paperTrading !== false) return; // live only
      // Deep closed for accurate realized P&L and open positions derived from
      // a sufficiently long trade window.
      const snap = await getLiveAccountSnapshot(ag as any, runtime, { tradesLimit: 300, includeOrders: false, deepClosed: true });
      // Guardrail: if balance is unknown due to CLOB hiccups, skip this tick
      if (!(typeof snap.balance === 'number' && Number.isFinite(snap.balance))) {
        return; // do not write misleading zero-cash snapshots
      }
      const minQty = Math.max(0, (runtime.ui as any)?.minOpenQuantity ?? 0.01);
      const filterSmall = Boolean((runtime.ui as any)?.filterSmallPositions ?? true);
      const feeForToken = (tokenId: string) => {
        try {
          let sum = 0;
          for (const t of (snap.trades ?? [])) {
            if ((t as any).tokenId !== tokenId) continue;
            const notional = (t as any).price * (t as any).size;
            const bps =
              typeof (t as any).feeRateBps === "number"
                ? (t as any).feeRateBps
                : 0;
            sum += Math.abs(notional) * bps / 10000;
          }
          return sum;
        } catch {
          return undefined;
        }
      };
      const repo = await getRepository();
      const realizedTotal = await repo.getTotalRealizedPnlFromClosed(agentId);
      const lastBuyMap = new Map<string, string>();
      for (const t of snap.trades ?? []) {
        if (!t || String(t.side ?? '').toLowerCase() !== 'buy') continue;
        const ms = Date.parse((t as any).matchTime ?? '');
        if (!Number.isFinite(ms)) continue;
        const key = `${t.marketId}:${t.tokenId}`;
        const prev = lastBuyMap.get(key);
        if (!prev || ms > Date.parse(prev)) {
          lastBuyMap.set(key, new Date(ms).toISOString());
        }
      }

      const open = (snap.openPositions ?? []).map((p) => {
        const openedIso = lastBuyMap.get(`${p.marketId}:${p.tokenId}`);
        return {
          marketId: p.marketId,
          optionId: p.tokenId,
          status: "open",
          quantity: p.quantity,
          averagePrice: p.averagePrice,
          bestBid: p.bestBid,
          bestAsk: p.bestAsk,
          openedAt: openedIso,
          feesPaid: feeForToken(p.tokenId),
        };
      });
      const openFiltered = filterSmall ? open.filter((p) => p.quantity >= minQty) : open;
      const unreal = openFiltered.reduce((acc, p) => {
        const mark = typeof p.bestBid === 'number' ? p.bestBid : (typeof p.bestAsk === 'number' ? p.bestAsk : p.averagePrice);
        return acc + (mark - p.averagePrice) * p.quantity;
      }, 0);
      const equity = snap.balance + (snap.mtmTotal ?? 0);
      await upsertLiveSnapshot({
        agentId,
        updatedAt: new Date().toISOString(),
        cashBalance: snap.balance,
        realizedPnl: realizedTotal,
        unrealizedPnl: unreal,
        equity,
        positionsOpen: openFiltered,
        positionsClosed: (snap.closedPositions ?? []).map((p) => ({
          marketId: p.marketId,
          optionId: p.tokenId,
          status: 'closed',
          quantity: p.quantity,
          averagePrice: p.averagePrice,
          exitPrice: p.exitPrice,
          realizedPnlForPosition: p.realizedPnlForPosition,
          updatedAt: p.closedAt,
          feesPaid: (p as any).feesPaid ?? undefined,
        })),
      });
    } catch {
      // ignore timer tick errors
    }
  }, periodMs);
  timers.set(key, timer);
}
