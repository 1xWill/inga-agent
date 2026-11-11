export type TradeDirection = 'buy' | 'sell';

export interface MarketOutcomeSnapshot {
  id: string;
  name: string;
  price?: number;
  liquidity?: number;
}

export interface MarketEvaluationInsert {
  runId: number;
  agentId: string;
  marketId: string;
  title: string;
  outcomes: MarketOutcomeSnapshot[];
  currentPrices: Record<string, number | undefined>;
  quickResearchSummary: string;
  trade: boolean;
  evaluationRationale: string;
  evaluationCitations?: string[];
  riskNotes?: string;
  status?: 'accepted' | 'rejected_prefilter' | 'rejected_ai_error' | 'rejected_cooldown' | 'rejected_balance' | 'rejected_policy' | 'rejected_other';
  timestamp: Date;
  debugMarketPayloadJson?: unknown;
  debugAiInputJson?: unknown;
  debugAiOutputJson?: unknown;
}

export interface TradeInstructionInsert {
  evaluationId: number;
  agentId: string;
  marketId: string;
  optionId: string;
  direction: TradeDirection;
  notional: number;
  allocationPct?: number;
  expectedPrice?: number;
  stopPrice?: number;
  takeProfitPrice?: number;
  reason: string;
  createdAt: Date;
}

export interface FillInsert {
  tradeInstructionId: number;
  agentId: string;
  marketId: string;
  optionId: string;
  direction: TradeDirection;
  quantity: number;
  fillPrice: number;
  notional: number;
  pnl: number;
  createdAt: Date;
  metadata?: Record<string, unknown>;
  feeAmount?: number;
  feeBps?: number;
  feeMeta?: unknown;
}

export interface PositionSnapshot {
  id?: number;
  agentId: string;
  marketId: string;
  optionId: string;
  direction: TradeDirection;
  quantity: number;
  averagePrice: number;
  openedAt: Date;
  updatedAt: Date;
  status: 'open' | 'closed';
}

export interface PortfolioSnapshot {
  agentId: string;
  cashBalance: number;
  reservedBalance: number;
  baseCurrency: string;
  unrealizedPnl: number;
  realizedPnl: number;
  positions: PositionSnapshot[];
}

export interface Reservation {
  id: string;
  amount: number;
  createdAt: Date;
}
