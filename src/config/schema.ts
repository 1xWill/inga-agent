import { z } from 'zod';

const AgentExecutionSchema = z.object({
  maxOpenPositions: z.number().int().nonnegative()
});

const AgentResearchSchema = z.object({
  quickProfile: z.string().min(1),
  deepProfile: z.string().min(1)
});

const ChartStyleSchema = z.object({
  color: z.string().min(1).optional(),
  glyph: z.string().min(1).optional()
});

export const AgentDefinitionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  logo: z.string().min(1).optional(),
  modelProvider: z.string().min(1),
  model: z.string().min(1),
  walletPrivateKeyEnv: z.string().min(1),
  walletAddressEnv: z.string().min(1),
  paperTrading: z.boolean().default(true),
  enabled: z.boolean().default(true),
  research: AgentResearchSchema,
  execution: AgentExecutionSchema,
  // Optional per-agent chart styling for dashboard charts
  chartStyle: ChartStyleSchema.optional()
});

const AgentDefinitionInputSchema = AgentDefinitionSchema.extend({
  modelProvider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  paperTrading: z.boolean().optional(),
  enabled: z.boolean().optional(),
  research: AgentResearchSchema.optional(),
  execution: AgentExecutionSchema.optional(),
  chartStyle: ChartStyleSchema.optional()
});

const AgentDefaultsSchema = z.object({
  modelProvider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  paperTrading: z.boolean().optional(),
  enabled: z.boolean().optional(),
  research: AgentResearchSchema.optional(),
  execution: AgentExecutionSchema.optional(),
  chartStyle: ChartStyleSchema.optional()
});

export const AgentsConfigSchema = z.object({
  defaults: AgentDefaultsSchema.optional(),
  agents: z.array(AgentDefinitionSchema).min(1)
});

export const AgentsConfigInputSchema = z.object({
  defaults: AgentDefaultsSchema.optional(),
  agents: z.array(AgentDefinitionInputSchema).min(1)
});

const ResearchProfileSchema = z.object({
  openrouter: z.object({
    maxTokens: z.number().int().positive(),
    temperature: z.number().min(0),
    timeoutMs: z.number().int().positive()
  })
});

const DecisionSchema = z.object({
  fields: z.array(z.string().min(1)).nonempty()
});

const GatingSchema = z
  .object({
    maxSpreadPct: z.number().min(0).default(1.0),
    minTopBookNotional: z.number().min(0).default(0),
    liquidityLevels: z.number().int().positive().default(1),
    requireFullNotionalAtDepth: z.boolean().default(true),
    requireLiveDepthForPrefilter: z.boolean().default(true)
  })
  .default({ maxSpreadPct: 1.0, minTopBookNotional: 0, liquidityLevels: 1, requireFullNotionalAtDepth: true, requireLiveDepthForPrefilter: true });

const TradeEvaluationSchema = z.object({
  decisionSchema: DecisionSchema,
  targetSelection: z.object({
    minConfidence: z.number().min(0).max(1),
    maxTargets: z.number().int().positive()
  }),
  // Minimum required statistical edge in basis points (1/100 of a percent).
  // Used by decision prompt and executor checks. Defaults to 150 bps (1.5%).
  minEdgeBps: z.number().int().nonnegative().default(150),
  // Additional executor guard: require net edge vs expected fill to exceed spread/2 + this buffer (in bps).
  // Optional: when omitted the system derives it from minEdgeBps + default half-spread/fee buffer.
  minEdgeBpsNet: z.number().int().nonnegative().optional(),
  candidateMaxPerEvent: z.number().int().positive().default(12),
  gating: GatingSchema.optional()
});

const PriceRefreshSchema = z.object({
  enabled: z.boolean().default(true),
  maxAgeMinutes: z.number().positive()
});

const SlippageModelSchema = z
  .object({
    type: z.enum(['midpoint', 'depth_aware']).default('depth_aware'),
    levels: z.number().int().positive().default(1)
  })
  .default({ type: 'depth_aware', levels: 1 });

const ExecutionSizingSchema = z
  .object({
    mode: z.enum(['fixed', 'auto_scale_to_depth']).default('fixed'),
    minNotional: z.number().min(0).default(0),
    maxDepthLevels: z.number().int().positive().default(1)
  })
  .default({ mode: 'fixed', minNotional: 0, maxDepthLevels: 1 });

const RotationWhenNoBalanceSchema = z
  .object({ enabled: z.boolean().default(true) })
  .default({ enabled: true });

const RotationWhenNoHeadroomSchema = z
  .object({
    enabled: z.boolean().default(true),
    // When true, only allow rotations when the candidate market is marked as preferred (e.g., keyword-matched).
    preferredOnly: z.boolean().default(true)
  })
  .default({ enabled: true, preferredOnly: true });

const LiveAutoCancelSchema = z
  .object({
    enabled: z.boolean().default(false),
    ttlMinutes: z.number().nonnegative().default(0)
  })
  .default({ enabled: false, ttlMinutes: 0 });

const LiveExecutionSchema = z
  .object({
    // Safety and control knobs for authenticated live trading
    dryRun: z.boolean().default(true),
    // Hard caps to avoid oversized orders/spend
    maxNotionalPerOrder: z.number().min(0).optional(),
    maxDailySpend: z.number().min(0).optional(),
    maxOpenOrders: z.number().int().nonnegative().optional(),
    // Simple client-side rate limiting for submissions
    submitJitterMs: z
      .object({
        min: z.number().int().nonnegative().default(100),
        max: z.number().int().nonnegative().default(400)
      })
      .default({ min: 100, max: 400 }),
    maxOrdersPerSecond: z.number().int().positive().default(1)
    ,
    // Auto-cancel orders after TTL if still open
    autoCancel: LiveAutoCancelSchema,
    // Orders refresher cadence (server-side status linker)
    ordersRefresher: z
      .object({ intervalMinutes: z.number().positive().default(10 / 60) })
      .default({ intervalMinutes: 10 / 60 })
  })
  .default({ dryRun: true, submitJitterMs: { min: 100, max: 400 }, maxOrdersPerSecond: 1, autoCancel: { enabled: false, ttlMinutes: 0 }, ordersRefresher: { intervalMinutes: 10 / 60 } });

const ExecutionSchema = z.object({
  strategy: z.enum(['immediate', 'batch']),
  reserveBalance: z.boolean(),
  priceRefresh: PriceRefreshSchema,
  slippageModel: SlippageModelSchema.optional(),
  sizing: ExecutionSizingSchema.optional(),
  largeTradeThreshold: z.number().min(0).optional(),
  multiLeg: z.boolean().default(false),
  rotationWhenNoBalance: RotationWhenNoBalanceSchema.optional(),
  rotationWhenNoHeadroom: RotationWhenNoHeadroomSchema.optional(),
  live: LiveExecutionSchema
});

const PollingSchema = z.object({
  marketFetchLimit: z.number().int().positive(),
  // If all selected markets are eliminated by event pre-filter (0 survivors),
  // retry discovery to fetch a fresh batch up to this many additional times.
  marketRefillMaxTries: z.number().int().nonnegative().default(0),
  // Monitor buy concurrency per tick (per agent)
  monitorMaxBuyPerTick: z.number().int().positive(),
  marketFetchIntervalMinutes: z.number().positive(),
  positionMonitorIntervalMinutes: z.number().positive()
});

const CooldownsSchema = z.object({
  // Shared suppression window for re-trading/evaluating the same market
  postDecisionMinutes: z.number().nonnegative().default(240),
  // Cooling off a market after it was already picked in discovery
  discoveryMinutes: z.number().int().nonnegative().default(60)
});

const SortEnum = z.enum(['trending', 'volume', 'liquidity', 'updatedAt']);

const CompositeSortEntrySchema = z.object({
  // Note: 'endingSoon' is a synthetic order handled by selection logic; not sent to Gamma
  sort: z.union([SortEnum, z.literal('endingSoon')]),
  // Per-probe sample window (page size) for this order
  take: z.number().int().positive()
});

const EndingSoonSchema = z
  .object({
    minTtlMinutes: z.number().int().nonnegative().default(10),
    maxTtlMinutes: z.number().int().positive().default(1440)
  })
  .default({ minTtlMinutes: 10, maxTtlMinutes: 1440 });

const MarketDataSchema = z.object({
  sort: SortEnum.default('trending'),
  includeOrderBooks: z.boolean(),
  includeOutcomePrices: z.boolean(),
  updatedSinceMinutes: z.number().int().positive().optional(),
  createdSinceMinutes: z.number().int().positive().optional(),
  discoveryMode: z.enum(['single', 'composite']).default('single'),
  compositeSorts: z.array(CompositeSortEntrySchema).optional(),
  seedOffsetStrategy: z.enum(['none', 'random']).default('none'),
  // Max numeric offset used per randomized composite probe (Gamma uses numeric offset)
  compositeRandomOffsetMax: z.number().int().positive().default(500),
  // Global TTL window for discovery; when set, markets with endDate outside this
  // window (too far in the past or future) are skipped before evaluation.
  minTtlMinutes: z.number().int().optional(),
  maxTtlMinutes: z.number().int().positive().optional(),
  includeTagIds: z.array(z.string().min(1)).optional(),
  excludeTagIds: z.array(z.string().min(1)).optional(),
  endingSoon: EndingSoonSchema,
  // Composite discovery controls
  maxCompositeProbes: z.number().int().positive().default(20),
  probeLogEvery: z.number().int().positive().default(5),
  requireClobTokenIdsForPaper: z.boolean().default(true),
  requireClobTokenIdsForLive: z.boolean().default(true),
  tokenResolver: z
    .object({
      strategies: z.array(z.enum(['slug', 'event', 'question', 'web'])).default(['slug', 'event', 'question', 'web']),
      validateWithBook: z.boolean().default(true)
    })
    .default({ strategies: ['slug', 'event', 'question', 'web'], validateWithBook: true })
});

const RetryPolicySchema = z.object({
  retries: z.number().int().nonnegative(),
  minDelayMs: z.number().int().nonnegative(),
  maxDelayMs: z.number().int().positive(),
  factor: z.number().min(1)
}).refine((policy) => policy.maxDelayMs >= policy.minDelayMs, {
  message: 'maxDelayMs must be greater than or equal to minDelayMs'
});

const CircuitBreakerSchema = z
  .object({
    failureThreshold: z.number().int().positive().default(3),
    openMinutes: z.number().positive().default(1)
  })
  .partial()
  .default({ failureThreshold: 3, openMinutes: 1 });

const HostOverrideSchema = z
  .object({
    retry: RetryPolicySchema.optional(),
    timeoutMs: z.number().int().positive().optional(),
    circuitBreaker: CircuitBreakerSchema.optional(),
    maxConcurrent: z.number().int().positive().optional()
  })
  .partial();

const HttpMemoizeSchema = z
  .object({
    clobOrderBookTtlMs: z.number().int().nonnegative().default(2500),
    clobFeeRateTtlMs: z.number().int().nonnegative().default(2500),
    clobTradesTtlMs: z.number().int().nonnegative().default(3000)
  })
  .partial()
  .default({ clobOrderBookTtlMs: 2500, clobFeeRateTtlMs: 2500, clobTradesTtlMs: 3000 });

const HttpConfigSchema = z.object({
  retry: RetryPolicySchema,
  timeoutMs: z.number().int().positive(),
  hostOverrides: z.record(z.string(), HostOverrideSchema).optional(),
  memoize: HttpMemoizeSchema.optional()
});

const PortfolioSchema = z.object({
  initialBalance: z.number().positive(),
  baseCurrency: z.string().min(1)
});

const PromptLineArraySchema = z.array(z.string().min(1));

const PromptPhaseOverrideSchema = z.object({
  system: PromptLineArraySchema.optional(),
  user: PromptLineArraySchema.optional()
});

const DecisionPromptOverridesSchema = z.object({
  quick: PromptPhaseOverrideSchema.optional(),
  deep: PromptPhaseOverrideSchema.optional()
});

const PromptsSchema = z.object({
  decision: DecisionPromptOverridesSchema.optional(),
  monitor: PromptPhaseOverrideSchema.optional()
}).optional();

export const RuntimeConfigSchema = z.object({
  polling: PollingSchema,
  cooldowns: CooldownsSchema,
  marketData: MarketDataSchema,
  // Shared discovery orchestration
  discovery: z
    .object({ shared: z.boolean().default(true) })
    .default({ shared: true }),
  researchProfiles: z.record(z.string(), ResearchProfileSchema),
  includeKeywords: z.array(z.string()).default([]),
  includeOnly: z.boolean().default(false),
  // When true, ignore cooldown suppression for keyword-discovered markets during selection
  skipCooldownForKeywords: z.boolean().default(true),
  bonusConfidence: z.number().min(0).max(1).default(0.5),
  // Tag exclusions applied to discovery and keyword search (Gamma exclude_tag_id)
  excludeTags: z.array(z.string()).default([]),
  // Keyword search knobs
  keywordSearchLimitPerType: z.number().int().positive().default(8),
  keywordSearchPageMax: z.number().int().nonnegative().default(5),
  keywordSearchSort: SortEnum.default('trending'),
  // Dashboard UI limits (server-fetch caps; 0 = unlimited)
  ui: z
    .object({
      maxOpenPages: z.number().int().positive().default(8),
      maxEvaluationPages: z.number().int().positive().default(12),
      maxActivityPages: z.number().int().positive().default(12),
      maxClosedPages: z.number().int().positive().default(12),
      // New: hide/filter tiny open positions and optionally skip marking them to save requests
      minOpenQuantity: z.number().min(0).default(0.01),
      filterSmallPositions: z.boolean().default(true),
      skipSmallPositionMarks: z.boolean().default(true)
    })
    .default({ maxOpenPages: 8, maxEvaluationPages: 12, maxActivityPages: 12, maxClosedPages: 12, minOpenQuantity: 0.01, filterSmallPositions: true, skipSmallPositionMarks: true }),
  tradeEvaluation: TradeEvaluationSchema,
  // Marks refresher (server-side writer of display marks)
  marksRefresher: z
    .object({
      enabled: z.boolean().default(true),
      intervalMinutes: z.number().positive().default(10 / 60),
      maxStalenessMinutes: z.number().positive().default(1),
      writer: z.enum(['server']).default('server')
    })
    .default({ enabled: true, intervalMinutes: 10 / 60, maxStalenessMinutes: 1, writer: 'server' }),
  // Agent data sources policy
  agent: z
    .object({
      dataSources: z
        .object({
          useDbMarksInAiContext: z.boolean().default(false),
          requireLiveDepthForExecution: z.boolean().default(true)
        })
        .default({ useDbMarksInAiContext: false, requireLiveDepthForExecution: true }),
      monitor: z
        .object({
          cooldown: z
            .object({
              minHoldingMinutes: z.number().nonnegative().default(1),
              highConfidenceOverride: z.number().min(0).max(1).default(0.8)
            })
            .default({ minHoldingMinutes: 1, highConfidenceOverride: 0.8 }),
          // Require loss to exceed microstructure friction before LLM-triggered exits
          // in absolute price terms: halfSpreadAbs + feeAbs + bufferAbs (buffer from bps)
          exitFrictionBps: z.number().int().nonnegative().default(300),
          // Require N consecutive close signals from the monitor before executing
          consecutiveCloseSignals: z.number().int().positive().default(2)
        })
        .default({ cooldown: { minHoldingMinutes: 1, highConfidenceOverride: 0.8 }, exitFrictionBps: 300, consecutiveCloseSignals: 2 })
    })
    .default({ dataSources: { useDbMarksInAiContext: false, requireLiveDepthForExecution: true }, monitor: { cooldown: { minHoldingMinutes: 1, highConfidenceOverride: 0.8 }, exitFrictionBps: 300, consecutiveCloseSignals: 2 } }),
  execution: ExecutionSchema,
  fees: z
    .object({
      trading: z.object({
        makerBps: z.number().min(0).default(0),
        takerBps: z.number().min(0).default(0)
      }).default({ makerBps: 0, takerBps: 0 }),
      mintRedeemBps: z.number().min(0).optional(),
      mergeSplitBps: z.number().min(0).optional(),
      gasUsdEstimate: z.number().min(0).optional(),
      source: z.string().optional(),
      requireLiveFeeRate: z.boolean().default(false)
    })
    .optional(),
  research: z
    .object({
      // Ordering and caps for event sibling selection
      order: z
        .enum(['liquidity_ttl_spread'])
        .default('liquidity_ttl_spread'),
      // Cap 1: max siblings sent into numeric pre-filter after sorting
      preFilterInputCap: z.number().int().positive().default(12),
      // Cap 2: max survivors (post pre-filter) sent into per-sibling LLM evaluation
      preFilterOutputCap: z.number().int().positive().default(8),
      // Optional: ensure survivors cover distinct siblings first (round‑robin by market)
      distributeSurvivors: z.boolean().default(false),
      strategy: z.enum(['quick_then_deep_on_true_or_uncertain']).default('quick_then_deep_on_true_or_uncertain'),
      quick: z
        .object({
          evaluationStrategy: z
            .enum(['per_sibling', 'event_multi', 'hybrid'])
            .default('per_sibling')
        })
        .default({ evaluationStrategy: 'per_sibling' }),
      webSearch: z
        .object({
          quickMaxResults: z.number().int().positive().default(6),
          deepMaxResults: z.number().int().positive().default(8),
          monitorMaxResults: z.number().int().positive().default(6),
          // Domains to exclude from research/analysis/citations (including subdomains)
          excludeDomains: z.array(z.string()).default([])
        })
        .default({ quickMaxResults: 6, deepMaxResults: 8, monitorMaxResults: 6, excludeDomains: [] }),
      // Event-level coherence: prefer a single YES per event
      groupDecisions: z
        .object({
          enabled: z.boolean().default(true),
          maxGroupSize: z.number().int().positive().default(4)
        })
        .default({ enabled: true, maxGroupSize: 4 })
    })
    .default({
      order: 'liquidity_ttl_spread',
      preFilterInputCap: 12,
      preFilterOutputCap: 8,
      distributeSurvivors: false,
      strategy: 'quick_then_deep_on_true_or_uncertain',
      quick: { evaluationStrategy: 'per_sibling' },
      webSearch: { quickMaxResults: 6, deepMaxResults: 8, monitorMaxResults: 6, excludeDomains: [] },
      groupDecisions: { enabled: true, maxGroupSize: 4 }
    }),
  risk: z
    .object({
      perTradeMax: z.number().min(0).optional(),
      perMarketMaxPct: z.number().min(0).max(1).optional(),
      // Alias for perMarketMaxPct; treated identically as a per-outcome cap.
      perOutcomeMaxPct: z.number().min(0).max(1).optional(),
      perRunMaxPct: z.number().min(0).max(1).optional(),
      dailyLossLimitPct: z.number().min(0).max(1).optional(),
      perTradeMin: z.number().min(0).optional()
    })
    .transform((risk) => {
      if (!risk) return risk;
      if (risk.perMarketMaxPct === undefined && risk.perOutcomeMaxPct !== undefined) {
        return { ...risk, perMarketMaxPct: risk.perOutcomeMaxPct };
      }
      return risk;
    })
    .optional(),
  exits: z
    .object({
      // TP can exceed 100% (e.g., buy 0.38, target 0.90); final price still clamped by priceCeiling
      takeProfitPct: z.number().min(0).optional(),
      stopLossPct: z.number().min(0).max(1).optional(),
      // Optional hard caps on tp/sl suggestions from the model or defaults
      maxTakeProfitPct: z.number().min(0).optional(),
      maxStopLossPct: z.number().min(0).max(1).optional(),
      maxHoldingMinutes: z.number().int().positive().optional(),
      // Legacy support: allow configs to specify hours; converted to minutes during parsing.
      maxHoldingHours: z.number().int().positive().optional(),
      minHoldingMinutes: z.number().nonnegative().optional(),
      priceFloor: z.number().min(0).max(1).optional(),
      priceCeiling: z.number().min(0).max(1).optional(),
      consecutiveTriggers: z.number().int().positive().optional(),
      minExitTopBookNotional: z.number().min(0).optional(),
      // Near-resolution exit guard (optional if auto-redeem is relied upon)
      resolutionGuardEnabled: z.boolean().optional(),
      resolutionGuardMinutes: z.number().int().nonnegative().optional()
    })
    .transform((value) => {
      const next = { ...value };
      if (
        next.maxHoldingMinutes === undefined &&
        typeof next.maxHoldingHours === 'number'
      ) {
        next.maxHoldingMinutes = next.maxHoldingHours * 60;
      }
      delete (next as any).maxHoldingHours;
      return next;
    })
    .optional(),
  http: HttpConfigSchema,
  portfolio: PortfolioSchema,
  portfolioHistory: z
    .object({
      enabled: z.boolean().default(true),
      intervalMinutes: z.number().positive().default(5),
      retention: z
        .object({
          rawDays: z.number().int().nonnegative().default(14),
          hourlyDays: z.number().int().nonnegative().default(90),
          dailyDays: z.number().int().nonnegative().default(365)
        })
        .default({ rawDays: 14, hourlyDays: 90, dailyDays: 365 }),
      buckets: z
        .object({
          shortRange: z.string().default('5m'),
          longRange: z.string().default('1h')
        })
        .default({ shortRange: '5m', longRange: '1h' }),
      maxPointsPerSeries: z.number().int().positive().default(1200)
    })
    .default({ enabled: true, intervalMinutes: 5, retention: { rawDays: 14, hourlyDays: 90, dailyDays: 365 }, buckets: { shortRange: '5m', longRange: '1h' }, maxPointsPerSeries: 1200 }),
  charts: z
    .object({
      yTicks: z.number().int().positive().default(6),
      yPaddingPct: z.number().min(0).max(1).default(0.1),
      // UI-only: fixed glyph count per series rendered in the dashboard chart
      // The chart always renders this many glyphs per line by binning dense
      // real samples and interpolating "ghost" glyphs when sparse.
      glyphsPerSeries: z.number().int().positive().default(160),
      endLabel: z.object({ minGapPx: z.number().int().nonnegative().default(14) }).default({ minGapPx: 14 }),
      timeFormat: z
        .object({ short: z.string().min(1).default('MMM d HH:mm'), long: z.string().min(1).default('MMM d') })
        .default({ short: 'MMM d HH:mm', long: 'MMM d' })
    })
    .default({ yTicks: 6, yPaddingPct: 0.1, glyphsPerSeries: 160, endLabel: { minGapPx: 14 }, timeFormat: { short: 'MMM d HH:mm', long: 'MMM d' } }),
  evaluations: z
    .object({
      ui: z
        .object({ includePrefiltered: z.boolean().default(true), includeFailed: z.boolean().default(true) })
        .default({ includePrefiltered: true, includeFailed: true }),
      persist: z
        .object({ prefiltered: z.boolean().default(true), failed: z.boolean().default(true) })
        .default({ prefiltered: true, failed: true }),
      retention: z
        .object({ prefilteredDays: z.number().int().nonnegative().default(7), failedDays: z.number().int().nonnegative().default(7) })
        .default({ prefilteredDays: 7, failedDays: 7 })
    })
    .default({ ui: { includePrefiltered: true, includeFailed: true }, persist: { prefiltered: true, failed: true }, retention: { prefilteredDays: 7, failedDays: 7 } }),
  logging: z.object({
    level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    verbose: z
      .object({
        markets: z.boolean().default(false),
        ai: z.boolean().default(false),
        // Provider-level verbosity toggles
        providers: z
          .object({
            polymarket: z.boolean().default(false),
            tokenResolver: z.boolean().default(false)
          })
          .default({ polymarket: false, tokenResolver: false })
      })
      .default({ markets: false, ai: false, providers: { polymarket: false, tokenResolver: false } }),
    redact: z
      .object({
        aiInput: z.boolean().default(false),
        aiOutput: z.boolean().default(false)
      })
      .default({ aiInput: false, aiOutput: false }),
    sampleRate: z.number().min(0).max(1).default(1)
  }),
  prompts: PromptsSchema
});

export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;
export type AgentDefinitionInput = z.infer<typeof AgentDefinitionInputSchema>;
export type AgentDefaults = z.infer<typeof AgentDefaultsSchema>;
export type AgentsConfig = z.infer<typeof AgentsConfigSchema>;
export type AgentsConfigInput = z.infer<typeof AgentsConfigInputSchema>;
export type ResearchProfile = z.infer<typeof ResearchProfileSchema>;
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;
export type CircuitBreaker = z.infer<typeof CircuitBreakerSchema>;
export type PortfolioConfig = z.infer<typeof PortfolioSchema>;
