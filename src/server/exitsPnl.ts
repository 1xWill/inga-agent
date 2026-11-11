import type { AgentRepositoryAsync } from '../storage/types';
import type { AgentDefinition } from '../config/schema';
import { getCachedLiveTrades } from './liveTradesCache';
import type { LiveTrade } from './liveAccount';

type ExitLike = {
  id?: number | string;
  agentId?: string;
  marketId?: string;
  optionId?: string;
  createdAt?: string;
  executedAt?: string;
  direction?: string;
  liveOrderId?: string;
  takerOrderId?: string;
  notional?: number;
  expectedPrice?: number;
};

type ClosedRow = {
  marketId: string;
  optionId: string;
  quantity: number;
  averagePrice: number;
  exitPrice: number;
  realizedPnl: number;
  feesPaid: number;
  closedAt: string;
};

type OrderPnl = {
  orderId: string;
  tokenId?: string;
  realizedPnl: number;
  quantity: number;
  avgExitPrice?: number;
  executedAt?: string;
};

type ClosedPool = {
  totalQty: number;
  remainingQty: number;
  totalPnl: number;
  remainingPnl: number;
  exitPrice?: number;
  feesPaid?: number;
};

const DEFAULT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

function parseMs(value?: string): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function feeOf(trade: LiveTrade): number {
  const bps = typeof trade.feeRateBps === 'number' ? trade.feeRateBps : 0;
  return Math.abs(trade.price * trade.size) * (bps / 10000);
}

function computeOrderPnls(trades: LiveTrade[]): Map<string, OrderPnl> {
  const result = new Map<string, OrderPnl>();
  type Lot = { qty: number; price: number; feePerShare: number };
  const lotsByToken = new Map<string, Lot[]>();

  const sorted = [...trades].sort((a, b) => {
    const am = parseMs(a.matchTime) ?? 0;
    const bm = parseMs(b.matchTime) ?? 0;
    return am - bm;
  });

  for (const trade of sorted) {
    if (!trade.tokenId || !(trade.size > 0) || !(trade.price > 0)) continue;
    const lots = lotsByToken.get(trade.tokenId) ?? [];
    if (trade.side === 'buy') {
      const fee = feeOf(trade);
      const feePerShare = trade.size > 0 ? fee / trade.size : 0;
      lots.push({
        qty: trade.size,
        price: trade.price,
        feePerShare,
      });
      lotsByToken.set(trade.tokenId, lots);
      continue;
    }

    // SELL
    let remaining = trade.size;
    let realized = 0;
    let qtySold = 0;
    let weightedExit = 0;
    const feeSell = feeOf(trade);
    const feeSellPerShare = trade.size > 0 ? feeSell / trade.size : 0;

    while (remaining > 1e-12 && lots.length > 0) {
      const lot = lots[0];
      const take = Math.min(remaining, lot.qty);
      const effectiveEntry = lot.price + lot.feePerShare;
      realized += (trade.price - effectiveEntry) * take;
      qtySold += take;
      weightedExit += trade.price * take;
      lot.qty -= take;
      if (lot.qty <= 1e-12) {
        lots.shift();
      }
      remaining -= take;
    }

    if (qtySold > 0) {
      realized -= feeSellPerShare * qtySold;
      const avgExit = qtySold > 0 ? weightedExit / qtySold : trade.price;
      if (trade.takerOrderId) {
        const prev = result.get(trade.takerOrderId);
        if (prev) {
          const newQty = prev.quantity + qtySold;
          const combinedExit =
            newQty > 0
              ? ((prev.avgExitPrice ?? avgExit) * prev.quantity +
                  avgExit * qtySold) /
                newQty
              : avgExit;
          result.set(trade.takerOrderId, {
            ...prev,
            realizedPnl: prev.realizedPnl + realized,
            quantity: newQty,
            avgExitPrice: combinedExit,
            executedAt: prev.executedAt ?? trade.matchTime,
          });
        } else {
          result.set(trade.takerOrderId, {
            orderId: trade.takerOrderId,
            tokenId: trade.tokenId,
            realizedPnl: realized,
            quantity: qtySold,
            avgExitPrice: avgExit,
            executedAt: trade.matchTime,
          });
        }
      }
      lotsByToken.set(trade.tokenId, lots);
    }
  }

  return result;
}

function extractQtyFromExit(exit: ExitLike): number | undefined {
  if (typeof (exit as any).quantity === 'number') {
    return Number((exit as any).quantity);
  }
  if (typeof exit.notional === 'number' && typeof exit.expectedPrice === 'number' && exit.expectedPrice > 0) {
    return exit.notional / exit.expectedPrice;
  }
  return undefined;
}

function buildClosedPools(
  rows: ClosedRow[] | undefined,
): Map<string, ClosedPool> {
  const map = new Map<string, ClosedPool>();
  if (!rows) return map;
  for (const row of rows) {
    const key = `${row.marketId}:${row.optionId}`;
    map.set(key, {
      totalQty: row.quantity,
      remainingQty: row.quantity,
      totalPnl: row.realizedPnl,
      remainingPnl: row.realizedPnl,
      exitPrice: row.exitPrice,
      feesPaid: row.feesPaid,
    });
  }
  return map;
}

export async function attachRealizedPnlToExits<T extends ExitLike>(
  repo: AgentRepositoryAsync | { [key: string]: any },
  exits: T[],
  opts: {
    closedRowsLimit?: number;
    matchWindowMs?: number;
    agentsById?: Map<string, AgentDefinition>;
    tradesLimit?: number;
    tradesTtlMs?: number;
  } = {},
): Promise<T[]> {
  if (!Array.isArray(exits) || exits.length === 0) return exits;
  const listClosed: ((limit: number, agentId?: string) => Promise<ClosedRow[]>) | undefined =
    typeof (repo as any)?.listRecentClosedPositions === 'function'
      ? (repo as any).listRecentClosedPositions.bind(repo)
      : undefined;

  const limit =
    typeof opts.closedRowsLimit === 'number' && opts.closedRowsLimit > 0
      ? Math.floor(opts.closedRowsLimit)
      : Math.max(50, exits.length * 2);
  const windowMs =
    typeof opts.matchWindowMs === 'number' && opts.matchWindowMs > 0
      ? opts.matchWindowMs
      : DEFAULT_WINDOW_MS;
  const tradesLimit =
    typeof opts.tradesLimit === 'number' && opts.tradesLimit > 0
      ? opts.tradesLimit
      : 400;
  const tradesTtlMs = typeof opts.tradesTtlMs === 'number' ? opts.tradesTtlMs : 0;

  const agents = Array.from(
    new Set(
      exits
        .map((x) => x.agentId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  );

  const closedPools = new Map<string, Map<string, ClosedPool>>();
  if (listClosed) {
    for (const agentId of agents) {
      try {
        const rows = await listClosed(limit, agentId);
        closedPools.set(agentId, buildClosedPools(rows));
      } catch {
        closedPools.set(agentId, new Map());
      }
    }
  }

  const perAgentOrderPnls = new Map<string, Map<string, OrderPnl>>();
  if (opts.agentsById && opts.agentsById.size > 0) {
    for (const agentId of agents) {
      const agent = opts.agentsById.get(agentId);
      if (!agent || agent.paperTrading !== false) continue;
      try {
        const trades = await getCachedLiveTrades(agent as any, tradesLimit, {
          ttlMs: tradesTtlMs,
        });
        perAgentOrderPnls.set(agentId, computeOrderPnls(trades));
      } catch {
        // ignore cache errors; fallback to closed pools
      }
    }
  }

  return exits.map((exit) => {
    if (String(exit.direction || '').toLowerCase() !== 'sell') {
      return exit;
    }
    const agentId = exit.agentId;
    const marketId = exit.marketId;
    const optionId = exit.optionId;
    if (!agentId || !marketId || !optionId) return exit;

    const orderId = exit.liveOrderId || exit.takerOrderId;
    const fromOrders =
      orderId && perAgentOrderPnls.get(agentId)?.get(orderId);
    if (fromOrders) {
      const extras: Record<string, unknown> = {
        pnl: fromOrders.realizedPnl,
        quantity: fromOrders.quantity,
      };
      if (fromOrders.avgExitPrice)
        extras['exitPrice'] = fromOrders.avgExitPrice;
      if (!exit.executedAt && fromOrders.executedAt)
        extras['executedAt'] = fromOrders.executedAt;
      return { ...exit, ...extras };
    }

    const pools = closedPools.get(agentId);
    const poolKey = `${marketId}:${optionId}`;
    const pool = pools?.get(poolKey);
    if (!pool) return exit;

    const qty = extractQtyFromExit(exit);
    if (!(qty && qty > 0 && pool.remainingQty > 0)) return exit;

    const take = Math.min(pool.remainingQty, qty);
    const share = pool.totalQty > 0 ? take / pool.totalQty : 0;
    const pnl = pool.totalPnl * share;

    pool.remainingQty -= take;
    pool.remainingPnl -= pnl;
    pools?.set(poolKey, pool);

    return {
      ...exit,
      pnl,
      quantity: take,
      exitPrice: exit.expectedPrice ?? pool.exitPrice,
      feesPaid: pool.feesPaid,
    };
  });
}
