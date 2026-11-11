import { randomUUID } from 'node:crypto';

import { AgentRepository } from './repository';
import type { FillInsert, PortfolioSnapshot, Reservation, TradeDirection } from './types';

interface PortfolioManagerOptions {
  agentId: string;
  initialBalance: number;
  baseCurrency: string;
}

interface ExecuteTradeInput {
  tradeInstructionId: number;
  marketId: string;
  optionId: string;
  direction: TradeDirection;
  price: number;
  notional: number;
  reservationId?: string;
  metadata?: Record<string, unknown>;
}

interface InternalState {
  cashBalance: number;
  reservedBalance: number;
  realizedPnl: number;
}

export class PortfolioManager {
  private readonly agentId: string;
  private readonly baseCurrency: string;
  private readonly initialBalance: number;
  private readonly repo: AgentRepository;
  private readonly reservations = new Map<string, Reservation>();
  private state: InternalState;

  constructor(repo: AgentRepository, options: PortfolioManagerOptions) {
    this.repo = repo;
    this.agentId = options.agentId;
    this.baseCurrency = options.baseCurrency;
    this.initialBalance = options.initialBalance;

    const snapshot = this.repo.getPortfolioState(
      options.agentId,
      options.baseCurrency,
      options.initialBalance
    );

    this.state = {
      cashBalance: snapshot.cashBalance,
      reservedBalance: snapshot.reservedBalance,
      realizedPnl: snapshot.realizedPnl
    };
  }

  get availableBalance(): number {
    return this.state.cashBalance - this.state.reservedBalance;
  }

  reserve(amount: number): Reservation {
    if (amount <= 0) {
      throw new Error('Reservation amount must be positive');
    }

    if (this.availableBalance < amount) {
      throw new Error(
        `Insufficient available balance to reserve ${amount}. Available: ${this.availableBalance}`
      );
    }

    const reservation: Reservation = {
      id: randomUUID(),
      amount,
      createdAt: new Date()
    };

    this.state.reservedBalance += amount;
    this.persistState();
    this.reservations.set(reservation.id, reservation);
    return reservation;
  }

  release(reservationId: string): void {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) {
      return;
    }

    this.state.reservedBalance = Math.max(0, this.state.reservedBalance - reservation.amount);
    this.persistState();
    this.reservations.delete(reservationId);
  }

  executeTrade(input: ExecuteTradeInput): FillInsert {
    const { direction, notional, price, reservationId } = input;
    if (price <= 0) {
      throw new Error('Trade price must be positive');
    }

    if (notional <= 0) {
      throw new Error('Trade notional must be positive');
    }

    const quantity = notional / price;
    if (quantity <= 0) {
      throw new Error('Calculated trade quantity must be positive');
    }

    if (reservationId) {
      const reservation = this.reservations.get(reservationId);
      if (!reservation) {
        throw new Error(`Unknown reservation ${reservationId}`);
      }

      if (reservation.amount < notional) {
        throw new Error(
          `Reservation ${reservationId} amount ${reservation.amount} is less than trade notional ${notional}`
        );
      }

      this.state.reservedBalance = Math.max(
        0,
        this.state.reservedBalance - reservation.amount
      );
      this.reservations.delete(reservationId);
    }

    // Fee estimation from metadata (bps) → absolute amount on notional
    const metaFeeBps = typeof input.metadata?.['feeBps'] === 'number' ? (input.metadata?.['feeBps'] as number) : undefined;
    const feeBps = typeof metaFeeBps === 'number' && Number.isFinite(metaFeeBps) ? Math.max(0, metaFeeBps) : 0;
    const feeAmount = (Math.abs(notional) * feeBps) / 10000;

    let realizedPnlDelta = 0;
    const openPositions = this.repo.listOpenPositions(this.agentId);

    if (direction === 'buy') {
      if (notional > this.state.cashBalance + this.state.reservedBalance) {
        throw new Error('Trade notional exceeds total accessible balance');
      }

      this.state.cashBalance -= (notional + feeAmount);
      const existingPosition = openPositions.find(
        (p) =>
          p.marketId === input.marketId &&
          p.optionId === input.optionId &&
          p.direction === direction
      );
      this.repo.upsertPosition({
        agentId: this.agentId,
        marketId: input.marketId,
        optionId: input.optionId,
        direction,
        quantity: this.mergeQuantity(existingPosition, quantity),
        averagePrice: this.mergeAveragePrice(existingPosition, price, quantity),
        status: 'open'
      });
    } else {
      const position = openPositions.find(
        (p) => p.marketId === input.marketId && p.optionId === input.optionId
      );

      if (!position || position.quantity <= 0) {
        throw new Error(`No open position for market ${input.marketId} option ${input.optionId} to sell`);
      }

      if (quantity > position.quantity + 1e-9) {
        throw new Error('Sell quantity exceeds open position');
      }

      this.state.cashBalance += (notional - feeAmount);
      realizedPnlDelta = (price - position.averagePrice) * Math.min(quantity, position.quantity) - feeAmount;
      const remainingQuantity = position.quantity - quantity;

      if (remainingQuantity <= 1e-9) {
        this.repo.closePosition(this.agentId, input.marketId, input.optionId, new Date());
      } else {
        const updatedAvg = position.averagePrice; // maintaining same average for remaining units
        this.repo.upsertPosition({
          agentId: this.agentId,
          marketId: input.marketId,
          optionId: input.optionId,
          direction: position.direction,
          quantity: remainingQuantity,
          averagePrice: updatedAvg,
          status: 'open'
        });
      }
    }

    this.state.realizedPnl += realizedPnlDelta;
    this.persistState();

    const fill: FillInsert = {
      tradeInstructionId: input.tradeInstructionId,
      agentId: this.agentId,
      marketId: input.marketId,
      optionId: input.optionId,
      direction: input.direction,
      quantity,
      fillPrice: price,
      notional,
      // For buys, treat pnl as negative fees (cash outflow); for sells, realized PnL net of fees
      pnl: direction === 'buy' ? -feeAmount : realizedPnlDelta,
      createdAt: new Date(),
      metadata: input.metadata,
      feeAmount,
      feeBps,
      feeMeta: input.metadata && 'feeSource' in input.metadata ? { source: (input.metadata as any)['feeSource'] } : undefined
    };

    this.repo.recordFill(fill);
    return fill;
  }

  snapshot(): PortfolioSnapshot {
    return this.repo.buildPortfolioSnapshot(this.agentId, this.baseCurrency, this.initialBalance);
  }

  private mergeQuantity(
    existingPosition: { quantity: number } | undefined,
    incomingQuantity: number
  ): number {
    if (!existingPosition) {
      return incomingQuantity;
    }

    return existingPosition.quantity + incomingQuantity;
  }

  private mergeAveragePrice(
    existingPosition: { averagePrice: number; quantity: number } | undefined,
    price: number,
    quantity: number
  ): number {
    if (!existingPosition) {
      return price;
    }

    const totalQuantity = existingPosition.quantity + quantity;
    if (totalQuantity <= 0) {
      return price;
    }

    const totalCost = existingPosition.averagePrice * existingPosition.quantity + price * quantity;
    return totalCost / totalQuantity;
  }

  private persistState(): void {
    this.repo.updatePortfolioState(this.agentId, {
      cashBalance: this.state.cashBalance,
      reservedBalance: this.state.reservedBalance,
      realizedPnl: this.state.realizedPnl,
      baseCurrency: this.baseCurrency
    });
  }
}
