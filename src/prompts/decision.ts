import type { MarketSummary } from '../clients/polymarket';
import type { RuntimeConfig } from '../config/schema';
import { finalizePromptSections, mergePromptSections, type PromptOverrides } from './utils';

export interface DecisionPromptInput {
  runId: number;
  agentId: string;
  market: MarketSummary;
  quickResearchSummary: string;
  deepResearchSummary?: string;
  runtime: RuntimeConfig;
  profile: keyof RuntimeConfig['researchProfiles'];
  preferred?: boolean;
  priceHistoryByOutcomeId?: Record<string, OutcomePriceHistorySummary>;
  siblingOutcomes?: Array<{
    marketId: string;
    marketTitle: string;
    url?: string;
    id: string;
    name: string;
    price?: number;
    bestBid?: number;
    bestAsk?: number;
    askLevels?: Array<{ price: number; quantity: number }>;
    ttlMinutes?: number | null;
  }>;
  phase?: 'quick' | 'deep';
  portfolioContext?: {
    availableBalance: number;
    positions: Array<{
      marketId: string;
      outcomeId: string;
      marketTitle?: string;
      outcomeName?: string;
      direction: 'buy' | 'sell';
      quantity: number;
      averagePrice: number;
      openedAt: string;
      lastMarkBid?: number;
      unrealizedPnl?: number;
    }>;
  };
  constraints?: {
    maxOpenPositions: number;
    openPositionsCount: number;
  };
  riskHeadroom?: {
    perMarketMaxPct?: number;
    equity?: number;
    marketExposure?: number;
    headroom?: number;
    availableBalance?: number;
    perRunMaxPct?: number;
    runExposure?: number;
    runHeadroom?: number;
  };
  quickDecision?: {
    trade: boolean;
    outcomeId?: string;
    subjectiveProb?: number;
    maxPayPrice?: number;
    edgeBps?: number;
    evaluationRationale?: string;
  };
}

export interface OutcomePriceHistorySummary {
  tokenId: string;
  last: number | null;
  high1m: number | null;
  low1m: number | null;
  pctFromHigh1m: number | null;
  return6hPct: number | null;
  range6hPct: number | null;
  points1m: number;
  points6h: number;
}

interface DecisionPromptRow {
  marketId: string;
  marketTitle: string;
  url?: string;
  slug?: string;
  id: string;
  name: string;
  clobTokenId: string | null;
  snapshotPrice: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  mid: number | null;
  topBookNotional: number;
  ttlMinutes: number | null;
  priceHistory?: OutcomePriceHistorySummary;
}

export interface DecisionPromptOutput {
  system: string;
  user: string;
  rows: DecisionPromptRow[];
  edgeThreshold: number;
  floor: number;
  ceiling: number;
  focusOutcomeIds: Set<string>;
}

const getDecisionOverrides = (
  runtime: RuntimeConfig,
  phase: DecisionPromptInput['phase'],
): PromptOverrides | undefined => {
  const phaseKey = phase === 'deep' ? 'deep' : 'quick';
  return runtime.prompts?.decision?.[phaseKey] as PromptOverrides | undefined;
};

export function buildDecisionPrompt(input: DecisionPromptInput): DecisionPromptOutput {
  const { market, quickResearchSummary, deepResearchSummary, runtime } = input;
  const floor = (runtime as any).exits?.priceFloor ?? 0;
  const ceiling = (runtime as any).exits?.priceCeiling ?? 1;
  const baseEdgeBps =
    (runtime.tradeEvaluation as any).minEdgeBps ??
    runtime.tradeEvaluation.minEdgeBpsNet ??
    150;
  const bonusConfidence = Math.max(
    0,
    Math.min(1, Number((runtime as any)?.bonusConfidence ?? 0.5)),
  );
  const levels = runtime.tradeEvaluation.gating?.liquidityLevels ?? 1;

  const baseRows = market.outcomes.map((o) => {
    const snap =
      typeof o.price === 'number'
        ? o.price > 1
          ? o.price / 100
          : o.price
        : null;
    const bb = (o as any).bestBid as number | undefined;
    const ba = (o as any).bestAsk as number | undefined;
    const mid = bb !== undefined && ba !== undefined ? (bb + ba) / 2 : undefined;
    const asks =
      ((o as any).askLevels as Array<{ price: number; quantity: number }> | undefined) ??
      [];
    const topNotional = asks
      .slice(0, Math.max(1, levels))
      .reduce((acc, l) => acc + Number(l.price) * Number(l.quantity), 0);
    const ttlIso = (market as any).endDate as string | undefined;
    const ttlMinutes = (() => {
      if (!ttlIso) return null;
      const diffMs = Date.parse(ttlIso) - Date.now();
      if (!Number.isFinite(diffMs)) return null;
      const mins = Math.round(diffMs / 60000);
      return Math.max(0, mins);
    })();
    return {
      marketId: market.id,
      marketTitle: market.question,
      url: (market as any).url as string | undefined,
      slug: (market as any).slug as string | undefined,
      id: o.id,
      name: o.name,
      clobTokenId: typeof (o as any).clobTokenId === 'string' ? ((o as any).clobTokenId as string) : null,
      snapshotPrice: snap,
      bestBid: bb ?? null,
      bestAsk: ba ?? null,
      mid: mid ?? null,
      topBookNotional: topNotional,
      ttlMinutes,
      priceHistory: input.priceHistoryByOutcomeId?.[o.id],
    };
  });

  const siblingRows = (input.siblingOutcomes ?? []).map((s) => {
    const snap =
      typeof s.price === 'number'
        ? s.price > 1
          ? s.price / 100
          : s.price
        : null;
    const bb = s.bestBid as number | undefined;
    const ba = s.bestAsk as number | undefined;
    const mid = bb !== undefined && ba !== undefined ? (bb + ba) / 2 : undefined;
    const asks =
      (s.askLevels as Array<{ price: number; quantity: number }> | undefined) ?? [];
    const topNotional = asks
      .slice(0, Math.max(1, levels))
      .reduce((acc, l) => acc + Number(l.price) * Number(l.quantity), 0);
    return {
      marketId: s.marketId,
      marketTitle: s.marketTitle,
      url: (s as any).url as string | undefined,
      slug: (s as any).slug as string | undefined,
      id: s.id,
      name: s.name,
      clobTokenId: null,
      snapshotPrice: snap,
      bestBid: bb ?? null,
      bestAsk: ba ?? null,
      mid: mid ?? null,
      topBookNotional: topNotional,
      ttlMinutes:
        typeof s.ttlMinutes === 'number' && Number.isFinite(s.ttlMinutes)
          ? Math.max(0, s.ttlMinutes)
          : null,
      priceHistory: undefined,
    };
  });

  const rows = [...baseRows, ...siblingRows].filter(
    (r, idx, arr) => arr.findIndex((x) => x.id === r.id) === idx,
  );

  const outcomesFormattedFocus = baseRows
    .map(
      (r) =>
        `- {id:"${r.id}", name:"${r.name}", tokenId:${r.clobTokenId ? `"${r.clobTokenId}"` : 'null'}, snapshot:${r.snapshotPrice ?? 'null'}, bid:${r.bestBid ?? 'null'}, ask:${r.bestAsk ?? 'null'}, mid:${r.mid ?? 'null'}, topNotional:${r.topBookNotional.toFixed(2)}, ttlMinutes:${r.ttlMinutes ?? 'null'}${
          r.priceHistory
            ? `, ph:{last:${r.priceHistory.last ?? 'null'}, high1m:${r.priceHistory.high1m ?? 'null'}, low1m:${r.priceHistory.low1m ?? 'null'}, pctFromHigh1m:${r.priceHistory.pctFromHigh1m ?? 'null'}, return6hPct:${r.priceHistory.return6hPct ?? 'null'}, range6hPct:${r.priceHistory.range6hPct ?? 'null'}, pts1m:${r.priceHistory.points1m}, pts6h:${r.priceHistory.points6h}}`
            : ''
        }}`,
    )
    .join('\n');
  const siblingFormatted = siblingRows
    .map(
      (r) =>
        `- {marketId:"${r.marketId}", id:"${r.id}", name:"${r.name}", snapshot:${r.snapshotPrice ?? 'null'}, bid:${r.bestBid ?? 'null'}, ask:${r.bestAsk ?? 'null'}, mid:${r.mid ?? 'null'}, ttlMinutes:${r.ttlMinutes ?? 'null'}}`,
    )
    .join('\n');

  const nearExpiryRows = rows.filter(
    (r) => typeof r.ttlMinutes === 'number' && r.ttlMinutes >= 0 && r.ttlMinutes <= 96 * 60,
  );
  const soonestMinutes =
    nearExpiryRows.length > 0
      ? nearExpiryRows.reduce(
          (min, r) => Math.min(min, r.ttlMinutes as number),
          Number.MAX_SAFE_INTEGER,
        )
      : undefined;
  const soonestHours =
    typeof soonestMinutes === 'number'
      ? Number((soonestMinutes / 60).toFixed(1))
      : undefined;
  let edgeThreshold = baseEdgeBps;
  if (typeof soonestMinutes === 'number') {
    if (soonestMinutes <= 24 * 60) edgeThreshold = Math.min(edgeThreshold, 10);
    else if (soonestMinutes <= 48 * 60) edgeThreshold = Math.min(edgeThreshold, 25);
    else if (soonestMinutes <= 96 * 60) edgeThreshold = Math.min(edgeThreshold, 50);
  }
  if (input.preferred === true) {
    const relaxed = Math.round(baseEdgeBps * (1 - 0.6 * bonusConfidence));
    const edgeThresholdPreferred = Math.max(10, relaxed);
    edgeThreshold = Math.min(edgeThreshold, edgeThresholdPreferred);
  }
  const ttlGuidance = nearExpiryRows.length
    ? `- Endgame focus: ${nearExpiryRows.length} outcomes resolve within 96h (soonest ~${soonestHours ?? '?'}h). Edge floor auto-adjusted to ${edgeThreshold} bps. Consider "Endgame Sweep" buys (ask ≥ 0.95) when your subjective probability still clears spread+fees; capture the final 1-5% by holding to resolution.`
    : `- No outcomes expire within 96h. Build a catalyst-backed thesis (earnings, court dates, macro events) before trading.`;
  const takerBps = Number((runtime as any)?.fees?.trading?.takerBps ?? 0);

  const isDeep = input.phase === 'deep';
  const atCapacity = Boolean(
    input.constraints && input.constraints.openPositionsCount >= input.constraints.maxOpenPositions,
  );
  const systemLines: string[] = [
    'Return ONLY JSON, no markdown/backticks/prose outside braces.',
    "You are Inga's deterministic trading agent. Evaluate the provided Polymarket event snapshot and decide whether to submit a single or multi-leg plan in strict JSON only.",
    'No-trade means: set trade=false.',
    '',
    'Guidance:',
    ttlGuidance,
    '- Yield math: estimate spendPct × AVAILABLE BALANCE × net edge in dollars and mention it. Use this to discuss capital efficiency, but do NOT auto-reject based on a fixed dollar floor.',
    '- Endgame/free-profit rule: when TTLMinutes ≤ 96h OR strong dated evidence shows the real-world outcome is effectively locked-in and settlement is likely, it is acceptable to take small positive-edge near-dollar trades. Explain you are capturing the final cents into resolution.',
    '- Capital-efficiency rule: when TTLMinutes is long and net edge is tiny, prefer trade=false unless there is a concrete near-term catalyst or the trade clearly upgrades the portfolio versus alternatives.',
    '- Evidence rule: cite at least one up-to-date external source (filing, docket, whale wallet, reputable news) for macro/policy/election/regulation markets (rate cuts, weed reschedule, ETFs, court rulings). If nothing new exists, say so and set trade=false.',
    '',
    'Rules:',
    (() => {
      const ex = (((runtime as any)?.research as any)?.webSearch as any)?.excludeDomains as
        | string[]
        | undefined;
      const list = Array.isArray(ex) && ex.length ? ex.join(', ') : '';
      return list
        ? `- MUST exclude -site: ${list} for any search queries or resources in your research/analysis/citations as they are not regarded as independent/external/objective sources.`
        : '';
    })(),
    '- All markets you see here are currently open on Polymarket (Gamma reports closed=false). Treat them as unresolved forecasts, not settled facts.',
    '- TTLMinutes semantics: values > 0 mean the scheduled event/resolution time is in the future; TTLMinutes = 0 means the scheduled end has passed or is at hand but the market is still open and unresolved.',
    '- When TTLMinutes > 0, do NOT state that the event has already occurred or that the market is resolved; frame your reasoning in terms of probabilities and future outcomes.',
    '- Resolution-lag exception: if you find strong, dated evidence that the real-world outcome is already decided (official result, filing, announcement) while the market remains open, you MAY treat it as effectively resolved and trade the mispricing. State the evidence, set subjectiveProb near 0/1, and note any settlement/mechanics risk.',
    '- ALWAYS research the latest and most relevant resources/clues that might help you evaluate this event\'s future outcome.',
    '- Cite concrete, recent signals with source summaries (filings, court calendars, trusted outlets with dates); do not include URLs directly (they are only in annotations). Always name your chosen price basis (ask|mid|snapshot), the net edge after spread/fees, and mention TTL when <96h or when proposing endgame moves.',
    `- Baseline edge rule: if edge < ${edgeThreshold} bps vs your chosen basis, you should return trade=false for simple BUY-only plans. Rotation at the run exposure cap is a separate case described below.`,
    `- Do NOT select any outcome whose executable basis (ask if available else mid) is < ${floor}. If all candidates are < ${floor}, return trade=false.`,
    `- Respect price bounds [${floor}, ${ceiling}] for entry; maxPayPrice must be within these bounds.`,
    '- P&L note: a fresh long can show small unrealized loss at bid due to spread/fees; this is expected friction. Use bid-side executable prices for exits/TP/SL and risk checks.',
  ];
  // Explicit brevity budget to reduce JSON truncation (esp. smaller token limits).
  if (isDeep) {
    systemLines.push(
      '- Brevity budget (deep): rationale ≤ 900 chars; riskNotes ≤ 300 chars; evidence ≤ 4 items; keep each evidence item to one sentence. Never paste long article/PDF text.',
    );
  } else {
    systemLines.push(
      '- Brevity budget (quick): rationale ≤ 500 chars; evidence ≤ 3 items; keep each evidence item to one sentence. Never paste long article/PDF text.',
    );
  }
  if (input.preferred === true) {
    systemLines.push(
      `- Preferred bias: This market was fetched via keyword search. The edge floor is set to ${edgeThreshold} bps for preferred candidates.`,
      `- Preferred tie-break: when evidence is borderline but net edge ≥ ${edgeThreshold} bps, lean slightly toward trade without violating bounds or fee/spread constraints.`,
    );
  }
  systemLines.push(
    '- Required fields: If trade=true you MUST include a concrete outcomeId (and marketId if different from the prompt market).',
    "- For multi-leg (deep phase), if you propose multiple legs, include a non-empty 'trades' array and each leg MUST include {marketId, outcomeId}.",
    '- Price-history guardrails: Outcomes may include ph:{last, high1m, low1m, pctFromHigh1m, return6hPct, range6hPct}. Use them.',
    '- Momentum spike guard: if ph.pctFromHigh1m ≤ 5 AND ph.return6hPct ≥ +15 (or ph.range6hPct ≥ 25), you MUST return trade=false. These are classic pump/chop conditions where edge is easy to hallucinate and hard to monetize.',
    '- Evidence format: when trade=true, include an "evidence" array of objects like {sourceType:"official|wire|reputable|market|other", sourceName:string, timestampIso:string, credibility:"high|medium|low", summary:string}.',
    '- Evidence quality: do not overstate certainty. When evidence is weak/old/rumor-based, reduce subjectiveProb and spendPct or return trade=false.',
    '- Multi-candidate/race markets: if the event is a race (multiple plausible candidates/outcomes), you MUST explicitly compare at least 2 alternatives in rationale and set guards.multiCandidateChecked=true. Otherwise set guards.multiCandidateChecked=false and bias toward trade=false.',
    '- Microstructure/manipulation note: always comment on spread/depth and recent volatility (ph) when trading; thin books + spikes are a red flag.',
  );
  if (!isDeep) {
    systemLines.push(
      '- Output schema (quick): {trade:boolean, outcomeId:string, subjectiveProb:number, maxPayPrice:number, rationale:string, riskNotes:string|null, evidence?:Array, guards?:{momentumSpike:boolean, evidenceQuality:"weak"|"medium"|"strong", multiCandidateChecked:boolean}}',
      '- Example: {"trade":true,"outcomeId":"<ID>","subjectiveProb":0.73,"maxPayPrice":0.52,"rationale":"…","riskNotes":null,"evidence":[{"sourceType":"reputable","sourceName":"WSJ","timestampIso":"2025-01-02T12:00:00Z","credibility":"medium","summary":"…"}],"guards":{"momentumSpike":false,"evidenceQuality":"medium","multiCandidateChecked":true}}',
    );
  } else {
    systemLines.push(
      '- Output schema (deep): {trade:boolean, outcomeId:string, subjectiveProb:number, maxPayPrice:number, spendPct:number, tpPct:number|null, slPct:number|null, rationale:string, riskNotes:string|null, evidence?:Array, guards?:{momentumSpike:boolean, evidenceQuality:"weak"|"medium"|"strong", multiCandidateChecked:boolean}, trades?:Array}',
      '- Example: {"trade":true,"outcomeId":"<ID>","subjectiveProb":0.73,"maxPayPrice":0.52,"spendPct":0.1,"tpPct":null,"slPct":null,"rationale":"…","riskNotes":null,"evidence":[{"sourceType":"reputable","sourceName":"WSJ","timestampIso":"2025-01-02T12:00:00Z","credibility":"medium","summary":"…"}],"guards":{"momentumSpike":false,"evidenceQuality":"medium","multiCandidateChecked":true}}',
    );
  }
  if (isDeep) {
    systemLines.push(
      '- Final phase role: quick phase has already done the high-level market evaluation and picked the best outcome.',
      '- Your job in this deep phase is to refine the trade plan: choose spendPct/size, TP/SL levels, and any BUY/SELL legs (trades[]), and explain why this strategy/size/exits/rotation are appropriate.',
      '- You MAY set trade=false in deep if a guardrail triggers (momentum spike, insufficient evidence quality/recency) or numeric constraints fail (no executable price basis, edge below threshold, price outside bounds, or no capacity/balance).',
    );
    if (input.quickDecision && input.quickDecision.trade) {
      const qd = input.quickDecision;
      const qEdge = typeof qd.edgeBps === 'number' ? `${qd.edgeBps}` : 'n/a';
      const qProb =
        typeof qd.subjectiveProb === 'number' ? qd.subjectiveProb.toFixed(3) : 'n/a';
      const qMax =
        typeof qd.maxPayPrice === 'number' ? qd.maxPayPrice.toFixed(3) : 'n/a';
      const qOutcome = qd.outcomeId ?? 'n/a';
      systemLines.push(
        `- Quick decision context: quick phase set trade=true on outcomeId=${qOutcome} with subjectiveProb≈${qProb}, maxPayPrice≈${qMax}, edge≈${qEdge}bps.`,
        '- Unless numeric constraints now fail (no executable price basis, edge below the configured threshold, price outside bounds, or no capacity/balance), keep trade=true on that outcome and focus your rationale on why the chosen sizing/TP/SL/legs are appropriate.',
      );
    }
  }
  systemLines.push(
    '- If your primary leg targets an outcome that is already open in the portfolio, treat it as an add-on:',
    '  • Make it clear in rationale that you are adding to an existing position.',
    '  • Justify why add again now: new evidence since last entry, improved edge versus average entry, better liquidity/price, or imminent catalyst/TTL.',
    '  • Prefer a smaller spendPct for add-ons unless conviction and edge have increased materially; if nothing material changed, return trade=false.',
    '  • Reference current position stats concisely (qty, avg entry, latest bid) when explaining the add-on.',
  );
  if (isDeep) {
    systemLines.push(
      '- spendPct is a fraction of AVAILABLE BALANCE (0..1). Suggest realistic tpPct/slPct (0..1) when useful.',
      "- Set tpPct/slPct a bit conservatively. Take profit once gains are sufficient — don’t wait for prices to reach 1 or 0 unless resolution is near or confidence is very high to make you hold. Preserve capital and consistency over chasing full-resolution wins.",
      '- Hedging is allowed when a positive edge exists and all gates (spread/liquidity/bounds) pass; otherwise skip.',
      '- Optional: you MAY include a multi-leg plan via "trades": [{marketId,outcomeId,maxPayPrice?,spendPct?,direction?}], where direction can be "sell" to reduce/exit an existing position. Keep the top-level fields consistent with your primary leg.',
    );
    if ((input.siblingOutcomes?.length ?? 0) > 0) {
      systemLines.push(
        '- Group decision across siblings: Pick at most one YES among provided sibling outcomes unless a clear under-rounding/hedge exists (combined implied probability < 1 minus fees).',
        '- Prefer the single highest-expected-value leg; only propose multiple legs when a hedge is explicit, and include explicit {marketId,outcomeId} for each trade in "trades".',
      );
    }
  }
  if (!isDeep) {
    systemLines.push(
      '- Target selection (quick): If trade=true you MUST choose exactly one outcomeId from the Outcomes list above (THIS market only). Do not invent ids and do not choose from sibling markets. Copy the id literally.',
      '- MUST include all required fields in your JSON output.',
    );
  }
  if (isDeep && atCapacity) {
    systemLines.push(
      `- Capacity rule: max open positions = ${input.constraints!.maxOpenPositions}; currently open = ${input.constraints!.openPositionsCount}. You may NOT add a new distinct position unless you also set "replaceOutcomeId" to the outcomeId of an existing open position to fully close. Choose the weakest existing position L based on forward-looking expected ROI/PnL (not just current PnL), and only proceed if the new candidate N is better than L in the near term. If N is not better than all existing positions, return trade=false. If the candidate outcome is already open (same outcomeId), you may add to it without replacement.`,
    );
  }
  const rotationCfg = (runtime as any)?.execution?.rotationWhenNoHeadroom;
  const rotationEnabled =
    rotationCfg && typeof rotationCfg.enabled === 'boolean'
      ? rotationCfg.enabled
      : true;
  const rotationPreferredOnly =
    rotationCfg && typeof rotationCfg.preferredOnly === 'boolean'
      ? rotationCfg.preferredOnly
      : true;
  const runHeadroom =
    typeof input.riskHeadroom?.runHeadroom === 'number'
      ? Math.max(0, input.riskHeadroom.runHeadroom)
      : undefined;
  const runAtCap = typeof runHeadroom === 'number' ? runHeadroom <= 0 : false;

  if (
    !isDeep &&
    rotationEnabled &&
    runAtCap &&
    (!rotationPreferredOnly || input.preferred === true)
  ) {
    systemLines.push(
      `- Preferred rotation candidate: run-level headroom is 0 (per-run exposure cap reached). Treat this market as a potential rotation target instead of defaulting to trade=false solely because of the cap.`,
      `- If your research shows that this ${input.preferred === true ? 'preferred ' : ''}market has non-negative net edge after spread/fees and clearly better forward-looking risk/reward than at least one existing open position, you should set trade=true so a later step can propose SELL+BUY rotation.`,
      '- Do not rotate into a negative-edge market; if all possible rotations would worsen expected portfolio quality, return trade=false.',
    );
  }

  if (
    isDeep &&
    rotationEnabled &&
    runAtCap &&
    (!rotationPreferredOnly || input.preferred === true)
  ) {
    systemLines.push(
      `- Rotation at exposure cap: You are at or above the per-run exposure cap (no remaining run-level headroom). You may only propose NEW BUY exposure when you also include SELL legs (or replaceOutcomeId) that reduce total exposure so that it stays ≤ the cap.`,
      `- When rotation is appropriate: focus on cases where the candidate trade in this ${input.preferred === true ? 'preferred ' : ''}market has non-negative net edge after spread/fees and clearly better near-term risk/reward vs at least one existing open position. Prefer stronger edges (≥ ${edgeThreshold} bps, especially for preferred markets), but you may rotate on smaller positive edge when you are clearly upgrading the portfolio.`,
      '- How to rotate: propose SELL legs in trades[] for one or more weaker existing positions (markets/outcomes with inferior forward-looking ROI/catalyst) and a BUY leg for the stronger candidate. Clearly explain in rationale which positions you are rotating out of and why the new position is superior.',
      '- If you cannot identify any existing position that is clearly weaker than the new candidate on a forward-looking basis, or if net edge is negative, you MUST return trade=false instead of forcing rotation.',
    );
  }
  const rotationNoBalanceEnabled = Boolean(
    (runtime as any)?.execution?.rotationWhenNoBalance?.enabled ?? true,
  );
  const availBal =
    input.portfolioContext?.availableBalance ??
    input.riskHeadroom?.availableBalance ??
    undefined;
  if (typeof availBal === 'number' && availBal <= 0 && rotationNoBalanceEnabled) {
    if (isDeep) {
      systemLines.push(
        '- You currently have no available balance (B=0). You may propose a buy only if you also set replaceOutcomeId to fully or partially close one or more existing positions to free cash. Replace only when the proposed trade has superior near-term ROI/catalyst vs the position(s) you close. If you cannot justify replacement, return trade=false.',
      );
    } else {
      systemLines.push(
        '- No available balance to buy new markets (B=0). Do not propose a trade unless replacing an existing position is clearly warranted; the deep decision may close one open position to free cash.',
      );
    }
  }
  const portfolioLinesFinal = (() => {
    if (!input.portfolioContext) return '';
    const header = `Available balance: ${input.portfolioContext.availableBalance.toFixed(2)}${
      isDeep && atCapacity ? `\nCAPACITY: maxOpen=${input.constraints!.maxOpenPositions}, openNow=${input.constraints!.openPositionsCount}` : ''
    }\nOpen positions:`;
    const rowsText = input.portfolioContext.positions
      .map((p) => {
        const label = `${p.marketTitle ? p.marketTitle : p.marketId} :: ${p.outcomeName ? p.outcomeName : p.outcomeId}`;
        return `- {${label}, dir:${p.direction}, qty:${p.quantity.toFixed(2)}, avg:${p.averagePrice.toFixed(3)}${typeof p.lastMarkBid === 'number' ? `, markBid:${p.lastMarkBid.toFixed(3)}` : ''}${typeof p.unrealizedPnl === 'number' ? `, uPnl:${p.unrealizedPnl.toFixed(2)}` : ''}, openedAt:${p.openedAt}}`;
      })
      .join('\n');
    return `${header}\n${rowsText || '- none'}`;
  })();

  const portfolioLinesBrief = (() => {
    if (!input.portfolioContext) return '';
    const rowsText = input.portfolioContext.positions
      .map((p) => {
        const label = `${p.marketTitle ? p.marketTitle : p.marketId} :: ${p.outcomeName ? p.outcomeName : p.outcomeId}`;
        return `- {${label}, qty:${p.quantity.toFixed(2)}, avg:${p.averagePrice.toFixed(3)}${typeof p.lastMarkBid === 'number' ? `, bid:${p.lastMarkBid.toFixed(3)}` : ''}}`;
      })
      .join('\n');
    return `Open positions (brief):\n${rowsText || '- none'}`;
  })();

  const headroomLine = (() => {
    const ctx = input.riskHeadroom;
    const pmax =
      typeof ctx?.perMarketMaxPct === 'number' ? ctx!.perMarketMaxPct : undefined;
    const eq = typeof ctx?.equity === 'number' ? ctx!.equity : undefined;
    const m = typeof ctx?.marketExposure === 'number' ? ctx!.marketExposure : undefined;
    const h =
      typeof ctx?.headroom === 'number' ? Math.max(0, ctx!.headroom!) : undefined;
    const b = typeof availBal === 'number' ? Math.max(0, availBal) : undefined;
    const pr =
      typeof ctx?.perRunMaxPct === 'number' ? ctx!.perRunMaxPct : undefined;
    const runExp =
      typeof ctx?.runExposure === 'number' ? ctx!.runExposure : undefined;
    const runHead =
      typeof ctx?.runHeadroom === 'number' ? Math.max(0, ctx!.runHeadroom!) : undefined;
    if (
      pmax === undefined ||
      eq === undefined ||
      m === undefined ||
      h === undefined ||
      b === undefined
    )
      return '';
    const mPct = eq > 0 ? (m / eq) * 100 : 0;
    const hPct = eq > 0 ? (h / eq) * 100 : 0;
    const spendPctMax = b > 0 ? Math.max(0, Math.min(1, h / b)) : 0;
    const lines: string[] = [];
    lines.push(
      `Per-market cap: max = ${(pmax * 100).toFixed(
        1,
      )}%. Current exposure ≈ ${mPct.toFixed(1)}% of equity. Headroom ≈ ${hPct.toFixed(1)}% (≈ $${h.toFixed(
        2,
      )}). Available balance ≈ $${b.toFixed(
        2,
      )}. Keep spendPct ≤ ${(spendPctMax * 100).toFixed(
        1,
      )}% of balance to respect the cap.`,
    );
    if (
      typeof pr === 'number' &&
      typeof runExp === 'number' &&
      typeof runHead === 'number'
    ) {
      const runCapAbs = Math.max(0, pr * eq);
      const runExpPct = eq > 0 ? (runExp / eq) * 100 : 0;
      const runHeadPct = eq > 0 ? (runHead / eq) * 100 : 0;
      lines.push(
        `Per-run cap: max = ${(pr * 100).toFixed(
          1,
        )}% of equity (≈ $${runCapAbs.toFixed(
          2,
        )}). Current total exposure ≈ ${runExpPct.toFixed(
          1,
        )}% (≈ $${runExp.toFixed(
          2,
        )}). Remaining headroom at run level ≈ ${runHeadPct.toFixed(
          1,
        )}% (≈ $${runHead.toFixed(
          2,
        )}). New BUYs must keep total exposure ≤ this cap; consider SELL legs to free room when run headroom is near or at zero.`,
      );
    }
    return lines.join('\n');
  })();

  const quickDecisionBlock = (() => {
    if (!isDeep || !input.quickDecision) return '';
    const qd = input.quickDecision;
    const raw = (qd.evaluationRationale ?? '').trim();
    const short = raw.length > 480 ? `${raw.slice(0, 480)}…` : raw || 'n/a';
    const edge = typeof qd.edgeBps === 'number' ? `${qd.edgeBps}` : 'n/a';
    const prob =
      typeof qd.subjectiveProb === 'number' ? qd.subjectiveProb.toFixed(3) : 'n/a';
    const maxPay =
      typeof qd.maxPayPrice === 'number' ? qd.maxPayPrice.toFixed(3) : 'n/a';
    const outcomeId = qd.outcomeId ?? 'n/a';
    return `\nQuick decision summary (prior phase):\n- trade: ${qd.trade}\n- chosenOutcomeId: ${outcomeId}\n- subjectiveProb: ${prob}\n- maxPayPrice: ${maxPay}\n- edgeBps: ${edge}\n- rationaleSummary: ${short}`;
  })();

  const userBlock = `Market: ${market.question}
Outcomes (this market):\n${outcomesFormattedFocus}
${isDeep && siblingFormatted ? `\nSibling context (read-only):\n${siblingFormatted}` : ''}
Quick Research:\n${quickResearchSummary || 'n/a'}
Deep Research:\n${deepResearchSummary || 'n/a'}
${quickDecisionBlock}
${headroomLine ? `\n${headroomLine}` : ''}
${input.portfolioContext ? (isDeep ? `\nPortfolio:\n${portfolioLinesFinal}` : `\n${portfolioLinesBrief}`) : ''}
\nNow: ${new Date().toISOString()}

Definitions:
- Edge bps = (subjectiveProb - priceBasis) * 10000; priceBasis is your chosen comparison (ask, mid, or snapshot).
- Net edge (for planner) must exceed spread/2 plus a safety buffer; only buy when edge >= ${edgeThreshold} bps and liquidity is reasonable.
${isDeep && atCapacity ? `- Replacement rule: pick L = weakest open position by expected near-term ROI. If N > L, set trade=true and also set "replaceOutcomeId" to L.outcomeId; otherwise trade=false.` : ''}

Return JSON now:`;

  const merged = mergePromptSections(
    { system: systemLines, user: [userBlock] },
    getDecisionOverrides(runtime, input.phase),
  );
  const { system, user } = finalizePromptSections(merged);

  return {
    system,
    user,
    rows,
    edgeThreshold,
    floor,
    ceiling,
    focusOutcomeIds: new Set(baseRows.map((r) => String(r.id))),
  };
}
