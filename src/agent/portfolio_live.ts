import type { PortfolioSnapshot, Reservation, TradeDirection } from './types';

// Lightweight in-memory portfolio manager for live mode.
// No DB writes; used only for gating (available balance, reservations) and local PnL math.
export class PortfolioManagerLive {
  private readonly agentId: string;
  private readonly baseCurrency: string;
  private cashBalance: number;
  private reservedBalance = 0;
  private realizedPnl = 0;
  private positions: Array<{ marketId: string; optionId: string; direction: TradeDirection; quantity: number; averagePrice: number; status: 'open' | 'closed'; openedAt: Date; updatedAt: Date }> = [];
  private reservations = new Map<string, Reservation>();

  constructor(opts: {
    agentId: string;
    baseCurrency: string;
    initialCash: number;
    // Optional seed from DB/async repository so live risk gates use full exposure,
    // not just positions opened in the current process.
    seedPositions?: Array<{
      marketId: string;
      optionId: string;
      direction: TradeDirection;
      quantity: number;
      averagePrice: number;
      status: 'open' | 'closed';
      openedAt: Date | string;
      updatedAt?: Date | string;
    }>;
  }) {
    this.agentId = opts.agentId;
    this.baseCurrency = opts.baseCurrency;
    this.cashBalance = opts.initialCash;

    if (Array.isArray(opts.seedPositions) && opts.seedPositions.length > 0) {
      const now = new Date();
      this.positions = opts.seedPositions.map((p) => {
        const openedAt =
          p.openedAt instanceof Date ? p.openedAt : new Date(p.openedAt);
        const updatedRaw =
          p.updatedAt instanceof Date
            ? p.updatedAt
            : p.updatedAt
              ? new Date(p.updatedAt)
              : openedAt;
        const updatedAt =
          updatedRaw instanceof Date && !Number.isNaN(updatedRaw.getTime())
            ? updatedRaw
            : now;
        return {
          marketId: p.marketId,
          optionId: p.optionId,
          direction: p.direction,
          quantity: p.quantity,
          averagePrice: p.averagePrice,
          status: p.status,
          openedAt,
          updatedAt,
        };
      });
    }
  }

  get availableBalance(): number {
    return this.cashBalance - this.reservedBalance;
  }

  setLiveCashBalance(amount: number) {
    this.cashBalance = Math.max(0, amount);
  }

  reserve(amount: number): Reservation {
    if (amount <= 0) throw new Error('Reservation amount must be positive');
    if (this.availableBalance < amount) throw new Error('Insufficient available balance');
    const id = `r_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
    const r: Reservation = { id, amount, createdAt: new Date() };
    this.reservedBalance += amount;
    this.reservations.set(id, r);
    return r;
  }

  release(id: string) {
    const r = this.reservations.get(id);
    if (!r) return;
    this.reservedBalance = Math.max(0, this.reservedBalance - r.amount);
    this.reservations.delete(id);
  }

  executeTrade(input: { tradeInstructionId: number; marketId: string; optionId: string; direction: TradeDirection; price: number; notional: number; reservationId?: string }) {
    // For live mode this is a no-op for persistence; update only balances for gating heuristics.
    const { direction, notional, price, reservationId } = input;
    if (reservationId) this.release(reservationId);
    const qty = notional / Math.max(1e-9, price);
    if (direction === 'buy') this.cashBalance = Math.max(0, this.cashBalance - notional);
    else this.cashBalance += notional; // optimistic
    // Positions tracked loosely for snapshot
    const now = new Date();
    const idx = this.positions.findIndex(p => p.marketId === input.marketId && p.optionId === input.optionId);
    if (direction === 'buy') {
      if (idx >= 0) {
        const p = this.positions[idx];
        const newQty = p.quantity + qty;
        const newAvg = newQty > 0 ? (p.averagePrice * p.quantity + price * qty) / newQty : price;
        this.positions[idx] = { ...p, quantity: newQty, averagePrice: newAvg, status: 'open', updatedAt: now };
      } else {
        this.positions.push({ marketId: input.marketId, optionId: input.optionId, direction: 'buy', quantity: qty, averagePrice: price, status: 'open', openedAt: now, updatedAt: now });
      }
    } else {
      if (idx >= 0) {
        const p = this.positions[idx];
        const rem = Math.max(0, p.quantity - qty);
        const closed = rem <= 1e-9;
        this.positions[idx] = { ...p, quantity: rem, status: closed ? 'closed' : 'open', updatedAt: now };
        const pnl = (price - p.averagePrice) * Math.min(qty, p.quantity);
        this.realizedPnl += pnl;
      }
    }
    return { id: 0 } as any;
  }

  snapshot(): PortfolioSnapshot {
    return {
      agentId: this.agentId,
      cashBalance: this.cashBalance,
      reservedBalance: this.reservedBalance,
      realizedPnl: this.realizedPnl,
      baseCurrency: this.baseCurrency,
      unrealizedPnl: 0,
      positions: this.positions.map(p => ({
        id: 0,
        agentId: this.agentId,
        marketId: p.marketId,
        optionId: p.optionId,
        direction: p.direction,
        quantity: p.quantity,
        averagePrice: p.averagePrice,
        status: p.status,
        openedAt: p.openedAt,
        updatedAt: p.updatedAt,
      })) as any,
    } as any;
  }
}
