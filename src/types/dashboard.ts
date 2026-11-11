export type OutcomeView = { id: string; name: string; price?: number };

export type MarketEvaluationView = {
  id: number;
  runId: number;
  agentId: string;
  marketId: string;
  title: string;
  url?: string;
  outcomes: OutcomeView[];
  currentPrices: Record<string, number | undefined>;
  quickSummary: string;
  trade: boolean;
  citations?: string[];
  riskNotes?: string;
  createdAt: string;
  status?: string;
  marketTitle?: string;
};

export type PlanDecisionView = {
  id: number;
  evaluationId: number;
  agentId: string;
  marketId: string;
  outcomeId?: string;
  status: string;
  reason?: string;
  tradeRationale?: string;
  createdAt: string;
  outcomeName?: string;
  marketTitle?: string;
  marketUrl?: string;
};

export type ActivityItem = {
  id: string;
  time: string;
  type: "decision" | "order" | "fill" | "exit";
  status?: string;
  pending?: boolean;
  notSubmitted?: boolean;
  marketId: string;
  marketTitle?: string;
  marketUrl?: string;
  outcomeId?: string;
  outcomeName?: string;
  rationale: string;
  notional?: number;
  price?: number;
  parentId?: number;
  pnl?: number;
  action?: string;
  source?: string;
  agentId?: string;
  citations?: string[];
};

export type TradeInstructionView = {
  id: number;
  evaluationId?: number;
  agentId: string;
  marketId: string;
  optionId: string;
  marketTitle?: string;
  outcomeName?: string;
  direction: string;
  notional: number;
  allocationPct?: number;
  expectedPrice?: number;
  stopPrice?: number;
  takeProfitPrice?: number;
  reason: string;
  createdAt: string;
  citations?: string[];
  executedAt?: string;
  liveOrderId?: string;
  liveStatus?: string;
};

export type FillView = {
  id: number;
  tradeInstructionId: number;
  agentId: string;
  marketId: string;
  optionId: string;
  marketTitle?: string;
  outcomeName?: string;
  direction: string;
  quantity: number;
  fillPrice: number;
  notional: number;
  pnl: number;
  createdAt: string;
  feeAmount?: number;
  tradeRationale?: string;
  citations?: string[];
};

export type PositionView = {
  marketId: string;
  optionId: string;
  marketTitle?: string;
  marketUrl?: string;
  outcomeName?: string;
  quantity: number;
  averagePrice: number;
  status: string;
  lastMid?: number;
  bestBid?: number;
  bestAsk?: number;
  lastMarkedAt?: string;
  unrealizedPnl?: number;
  tpPrice?: number;
  slPrice?: number;
  tpPriceOrig?: number;
  slPriceOrig?: number;
  feesPaid?: number;
  exitPrice?: number;
  updatedAt?: string;
  realizedPnlForPosition?: number;
};

export type PortfolioView = {
  agentId: string;
  cashBalance: number;
  reservedBalance: number;
  baseCurrency: string;
  realizedPnl: number;
  positions: PositionView[];
  unrealizedPnl?: number;
  equity?: number;
  baselineEquity?: number;
};

export type ClosedPositionsPage = {
  agentId: string;
  rows: PositionView[];
  pagination: {
    page: number;
    limit: number;
    total: number;
  };
  filters?: {
    marketId?: string;
    optionId?: string;
  };
};

export type OrdersView = {
  agentId: string;
  orders: Array<{
    id: string;
    assetId: string;
    market: string;
    side: string;
    price: number;
    sizeRemaining: number;
    status: string;
    createdAt: number;
  }>;
};

export type DashboardData = {
  markets: MarketEvaluationView[];
  planDecisions: PlanDecisionView[];
  trades: TradeInstructionView[];
  fills: FillView[];
  exits: TradeInstructionView[];
  portfolios: Record<string, PortfolioView>;
  orders?: OrdersView[];
};
