import { getRepository } from '../_lib/db';
import type { RuntimeConfig } from '../../../src/config/schema';
import { loadAgentsConfig } from '../../../src/config/loaders';
import { getLiveAccountSnapshot } from '../../../src/server/liveAccount';
import { ensureMarksRefresher, refreshMarksNow } from './marksRefresher';

type Timer = ReturnType<typeof setInterval>;

const timers = new Map<string, Timer>();

function nowMs() {
  return Date.now();
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function isSuspiciousDownSpike(params: {
  referenceEquity?: number;
  nextEquity: number;
}) {
  const { referenceEquity, nextEquity } = params;
  if (!(typeof referenceEquity === 'number' && Number.isFinite(referenceEquity))) return false;
  if (!(typeof nextEquity === 'number' && Number.isFinite(nextEquity))) return false;
  if (referenceEquity <= 0) return false;

  const ratio = nextEquity / referenceEquity;
  const absDrop = referenceEquity - nextEquity;
  return ratio <= 0.55 && absDrop >= Math.max(50, referenceEquity * 0.05);
}

async function computeAndPersistSnapshot(agentId: string, runtime: RuntimeConfig) {
  const repo = await getRepository();

  // Ensure marks refresher is active; refresh immediately if stale
  try { ensureMarksRefresher(agentId, runtime); } catch {}
  try {
    const marks = await repo.getPositionMarks(agentId);
    const now = nowMs();
    const maxAgeMs = (runtime.marksRefresher?.maxStalenessMinutes ?? 1) * 60 * 1000;
    let stale = false;
    for (const m of marks.values()) {
      if (!m.markedAt || now - m.markedAt.getTime() > maxAgeMs) { stale = true; break; }
    }
    if (stale) await refreshMarksNow(agentId, runtime);
  } catch {}

  const snap = await repo.buildPortfolioSnapshot(agentId, runtime.portfolio.baseCurrency, runtime.portfolio.initialBalance);
  const marks = await repo.getPositionMarks(agentId);
  // Default (paper): compute MTM from DB positions + marks and use persisted cashBalance.
  let mtm = (snap.positions ?? []).reduce((acc, p: any) => {
    const m = marks.get(`${p.marketId}:${p.optionId}`);
    const mark = typeof m?.bestBid === 'number' ? m.bestBid : p.averagePrice;
    return acc + mark * p.quantity;
  }, 0);
  let cash = snap.cashBalance;
  let equity = cash + mtm;
  let realizedPnl = snap.realizedPnl;
  let unrealizedPnl = snap.unrealizedPnl ?? 0;
  const fallbackEquity = equity;

  // Live agents: rely on live CLOB-backed snapshot for equity and P&L.
  try {
    const agents = await loadAgentsConfig(process.cwd());
    const ag = agents.agents.find((a) => a.id === agentId);
    if (ag && ag.enabled && ag.paperTrading === false) {
      const prev = await repo.getLatestPortfolioHistory(agentId).catch(() => undefined);

      // Retry a few times on transient CLOB failures; skip this tick if we
      // cannot obtain a live snapshot to avoid writing misleading points.
      const fetchLive = async () => {
        let liveSnap: Awaited<ReturnType<typeof getLiveAccountSnapshot>> | undefined;
        const attempts = 3;
        for (let i = 0; i < attempts; i += 1) {
          try {
            liveSnap = await getLiveAccountSnapshot(ag as any, runtime, { tradesLimit: 300, includeOrders: false, deepClosed: true });
            break;
          } catch {
            if (i < attempts - 1) await sleep(250);
          }
        }
        return liveSnap;
      };

      let liveSnap = await fetchLive();
      if (!liveSnap) return;
      // Guardrail: if balance is unknown due to CLOB hiccups, skip this tick
      if (!(typeof liveSnap.balance === 'number' && Number.isFinite(liveSnap.balance))) return;

      const toEquity = (s: Awaited<ReturnType<typeof getLiveAccountSnapshot>>) => {
        const cashLocal = typeof s.balance === 'number' ? s.balance : 0;
        const mtmLocal = (s.openPositions ?? []).reduce((a, p) => a + (p.mtm ?? 0), 0);
        const equityLocal = cashLocal + mtmLocal;
        const realizedLocal = (s.closedPositions ?? []).reduce(
          (a, p) => a + (p.realizedPnlForPosition || 0),
          0,
        );
        const unrealizedLocal = (s.openPositions ?? []).reduce((a, p) => {
          const mark =
            typeof p.bestBid === 'number'
              ? p.bestBid
              : (typeof p.bestAsk === 'number' ? p.bestAsk : p.averagePrice);
          return a + (mark - p.averagePrice) * p.quantity;
        }, 0);
        return { cashLocal, mtmLocal, equityLocal, realizedLocal, unrealizedLocal };
      };

      // Compute the candidate point.
      let computed = toEquity(liveSnap);
      const refs = [prev?.equity, fallbackEquity].filter(
        (v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0,
      );
      const referenceEquity = refs.length ? Math.max(...refs) : undefined;

      // Outlier guard: avoid persisting obvious partial snapshots. Confirm with a delayed retry.
      if (referenceEquity && isSuspiciousDownSpike({ referenceEquity, nextEquity: computed.equityLocal })) {
        // Wait a bit longer than typical transient blips so we don't misclassify
        // short-lived CLOB hiccups as real drawdowns.
        await sleep(5000);
        const retry = await fetchLive();
        if (!retry || !(typeof retry.balance === 'number' && Number.isFinite(retry.balance))) return;
        const recomputed = toEquity(retry);
        const stillSuspicious = isSuspiciousDownSpike({ referenceEquity, nextEquity: recomputed.equityLocal });
        if (stillSuspicious) return; // skip writing this tick; retry next interval
        computed = recomputed; // transient glitch: persist the retry snapshot values
        liveSnap = retry;
      }

      cash = computed.cashLocal;
      mtm = computed.mtmLocal;
      equity = computed.equityLocal;
      realizedPnl = computed.realizedLocal;
      unrealizedPnl = computed.unrealizedLocal;

      // Persist closed rounds into the closed_positions table so APIs and UI
      // can read recent closed positions without re-walking trade history.
      try {
        const closedRows =
          (liveSnap.closedPositions ?? []).map((p) => ({
            marketId: p.marketId,
            optionId: p.tokenId,
            quantity: p.quantity,
            averagePrice: p.averagePrice,
            exitPrice: p.exitPrice,
            realizedPnl: p.realizedPnlForPosition ?? 0,
            feesPaid: (p as any).feesPaid ?? 0,
            closedAt: p.closedAt,
          })) ?? [];
        if (closedRows.length > 0) {
          await repo.recordClosedPositions(agentId, closedRows);
        }
      } catch {
        // Closed-positions persistence is best-effort; do not fail the
        // portfolio history recorder if this write path is unavailable.
      }
    }
  } catch {}

  const ts = nowMs();
  await repo.recordPortfolioHistory({ agentId, ts, equity, realizedPnl, unrealizedPnl });

  // Lightweight pruning of very old raw history (beyond the largest retention horizon)
  try {
    const dailyDays = (runtime.portfolioHistory?.retention?.dailyDays ?? 365);
    const cutoff = ts - Math.max(1, dailyDays) * 24 * 60 * 60 * 1000;
    await repo.prunePortfolioHistoryBefore(agentId, cutoff);
  } catch {}
}

export function ensurePortfolioHistoryRefresher(agentId: string, runtime: RuntimeConfig) {
  const key = agentId || 'default';
  if (timers.has(key)) return;
  if (!runtime.portfolioHistory?.enabled) return;
  const intervalMinutes = Math.max(1 / 60, runtime.portfolioHistory.intervalMinutes ?? 5);
  const periodMs = Math.max(1000, intervalMinutes * 60 * 1000);
  const timer = setInterval(() => {
    computeAndPersistSnapshot(agentId, runtime).catch(() => {});
  }, periodMs);
  timers.set(key, timer);
}

export async function refreshPortfolioHistoryNow(agentId: string, runtime: RuntimeConfig) {
  await computeAndPersistSnapshot(agentId, runtime);
}
