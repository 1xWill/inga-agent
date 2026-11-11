import type { RuntimeConfig } from "../../config/schema";
import type { MarketSummary, OrderBookLevel } from "../../clients/polymarket";
import type { TradeInstructionInsert } from "../types";
import type { PortfolioManager } from "../portfolio";
import { PortfolioManagerLive } from "../portfolio_live";
import { getMinEdgeBpsNet } from "./edge";

export interface PlanTradeInput {
  evaluationId: number;
  agentId: string;
  market: MarketSummary;
  runtime: RuntimeConfig;
  portfolio: PortfolioManager | PortfolioManagerLive;
  // Single-source decision extras
  decision: {
    outcomeId: string;
    subjectiveProb?: number;
    maxPayPrice?: number;
    priceBasis?: "ask" | "mid" | "snapshot";
    edgeBps?: number;
    takerFeeBps?: number;
    spendPct?: number;
    tpPct?: number | null;
    slPct?: number | null;
    direction?: "buy" | "sell";
  };
}

export interface PlanTradeResult {
  instruction?: TradeInstructionInsert; // undefined if no feasible plan
  reservedAmount?: number;
  reservationId?: string;
  rejectedReason?: string; // legacy; prefer `rejected.summary`
  rejected?: {
    code: string;
    summary: string;
    details?: unknown;
  };
}

// Note: outcome selection is performed by the LLM; planner only verifies and executes.

function fmtPct(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function reject(
  code: string,
  summary: string,
  details?: unknown,
): PlanTradeResult {
  return { rejectedReason: summary, rejected: { code, summary, details } };
}

function computeSpreadPct(
  bestBid?: number,
  bestAsk?: number,
): number | undefined {
  if (
    !Number.isFinite(bestBid as number) ||
    !Number.isFinite(bestAsk as number)
  )
    return undefined;
  const mid = ((bestBid as number) + (bestAsk as number)) / 2;
  if (mid <= 0) return undefined;
  return ((bestAsk as number) - (bestBid as number)) / mid;
}

function sumTopNotional(
  levels: OrderBookLevel[] | undefined,
  k: number,
): number | undefined {
  if (!levels || levels.length === 0) return undefined;
  return levels
    .slice(0, Math.max(1, k))
    .reduce((acc, l) => acc + l.price * l.quantity, 0);
}

function estimateFillPrices(
  levels: OrderBookLevel[] | undefined,
  notional: number,
): { average: number; limit: number } | undefined {
  if (!levels || levels.length === 0 || notional <= 0) return undefined;
  let remaining = notional;
  let cost = 0;
  let shares = 0;
  let lastPriceUsed: number | undefined;
  for (const lvl of levels) {
    const maxSpendHere = lvl.price * lvl.quantity;
    const spend = Math.min(remaining, maxSpendHere);
    if (spend > 0) {
      const qty = spend / lvl.price;
      cost += spend;
      shares += qty;
      remaining -= spend;
      lastPriceUsed = lvl.price;
    }
    if (remaining <= 1e-9) break;
  }
  if (shares <= 0) return undefined;
  const limit =
    typeof lastPriceUsed === "number"
      ? lastPriceUsed
      : Number.isFinite(levels[0]?.price)
        ? (levels[0] as OrderBookLevel).price
        : cost / shares;
  return { average: cost / shares, limit };
}

export function planTrade({
  evaluationId,
  agentId,
  market,
  runtime,
  portfolio,
  decision,
}: PlanTradeInput): PlanTradeResult {
  const outcome = market.outcomes.find((o) => o.id === decision.outcomeId);
  if (!outcome) {
    return reject("outcome_not_found", `Reject: outcome not found in market`, {
      marketId: market.id,
      outcomeId: decision.outcomeId,
    });
  }
  const legDirection: "buy" | "sell" =
    decision.direction === "sell" ? "sell" : "buy";

  const ttlMinutes = (() => {
    const iso = (market as any).endDate as string | undefined;
    if (!iso) return undefined;
    const diffMs = Date.parse(iso) - Date.now();
    if (!Number.isFinite(diffMs)) return undefined;
    return Math.round(diffMs / 60000);
  })();
  const ttlHours =
    typeof ttlMinutes === "number"
      ? Number((ttlMinutes / 60).toFixed(1))
      : undefined;
  const ttlReliefBps = (() => {
    if (typeof ttlMinutes !== "number") return 0;
    if (ttlMinutes <= 24 * 60) return 200;
    if (ttlMinutes <= 48 * 60) return 150;
    if (ttlMinutes <= 96 * 60) return 100;
    return 0;
  })();
  const depthReliefFactor = (() => {
    if (typeof ttlMinutes !== "number") return 1;
    if (ttlMinutes <= 24 * 60) return 0.4;
    if (ttlMinutes <= 48 * 60) return 0.5;
    if (ttlMinutes <= 96 * 60) return 0.7;
    return 1;
  })();

  const available = portfolio.availableBalance;

  // Determine notional from LLM sizing (buys) or position size (sells).
  let notional = 0;
  if (legDirection === "buy") {
    if (
      typeof decision.spendPct !== "number" ||
      !Number.isFinite(decision.spendPct)
    ) {
      return reject("missing_spend_pct", "Reject: missing spendPct for buy", {
        outcomeId: outcome.id,
        direction: legDirection,
      });
    }
    const spendPct = Math.max(0, Math.min(1, decision.spendPct));
    notional = spendPct * available;
  } else {
    const pos = portfolio
      .snapshot()
      .positions.find(
        (p) =>
          p.marketId === market.id &&
          p.optionId === outcome.id &&
          p.status === "open",
      );
    if (!pos || pos.quantity <= 0) {
      return reject("no_position_to_sell", "Reject: no open position to sell", {
        marketId: market.id,
        outcomeId: outcome.id,
        direction: legDirection,
      });
    }
    const refPrice =
      (outcome as any).bestBid ??
      (typeof outcome.price === "number"
        ? outcome.price > 1
          ? outcome.price / 100
          : outcome.price
        : 0.5);
    const fullNotional = refPrice * pos.quantity;
    notional = fullNotional;
  }

  // Risk caps (per-trade max)
  if (legDirection === "buy" && runtime.risk?.perTradeMax !== undefined) {
    notional = Math.min(notional, runtime.risk.perTradeMax);
  }

  // Clamp notional to available funds to avoid impossible plans
  if (legDirection === "buy") {
    notional = Math.min(notional, available);
    if (notional <= 0) {
      return reject(
        "notional_zero_after_clamp",
        "Reject: buy size <= $0 after sizing/clamp",
        {
          availableBalance: available,
          spendPct: decision.spendPct ?? null,
          perTradeMax: runtime.risk?.perTradeMax ?? null,
        },
      );
    }
  }

  // Risk gating with portfolio exposures
  const snapshot = portfolio.snapshot();
  const positionsCost = snapshot.positions.reduce(
    (acc, p) => acc + p.averagePrice * p.quantity,
    0,
  );
  const equity =
    snapshot.cashBalance + snapshot.reservedBalance + positionsCost;
  const risk = runtime.risk;

  if (
    risk?.dailyLossLimitPct !== undefined &&
    snapshot.realizedPnl <= -risk.dailyLossLimitPct * equity
  ) {
    return reject(
      "daily_loss_limit",
      `Reject: daily loss limit breached`,
      // `Reject: daily loss limit breached (config: risk.dailyLossLimitPct)`,
      {
        realizedPnl: snapshot.realizedPnl,
        equity,
        dailyLossLimitPct: risk.dailyLossLimitPct,
      },
    );
  }

  if (risk?.perRunMaxPct !== undefined) {
    const capAbs = Math.max(0, risk.perRunMaxPct * equity);
    const headroom = Math.max(0, capAbs - positionsCost);
    if (legDirection === "buy") {
      if (headroom <= 0) {
        return reject(
          "per_run_cap_no_headroom",
          `Reject: no run headroom`,
          // `Reject: no run headroom (config: risk.perRunMaxPct)`,
          { equity, positionsCost, perRunMaxPct: risk.perRunMaxPct, headroom },
        );
      }
      notional = Math.min(notional, headroom);
      if (notional <= 0) {
        return reject(
          "per_run_cap_zeroed",
          `Reject: buy size clamped to $0 by run cap`,
          // `Reject: buy size clamped to $0 by run cap (config: risk.perRunMaxPct)`,
          { equity, positionsCost, perRunMaxPct: risk.perRunMaxPct, headroom },
        );
      }
    }
  }

  // Treat perMarketMaxPct as a per-outcome (per token) cap on exposure vs equity.
  if (risk?.perMarketMaxPct !== undefined) {
    const outcomeExposure = snapshot.positions
      .filter((p) => p.marketId === market.id && p.optionId === outcome.id)
      .reduce((acc, p) => acc + p.averagePrice * p.quantity, 0);
    const capAbs = Math.max(0, risk.perMarketMaxPct * equity);
    const headroom = Math.max(0, capAbs - outcomeExposure);
    if (headroom <= 0) {
      return reject(
        "per_outcome_cap_no_headroom",
        `Reject: no outcome headroom`,
        // `Reject: no outcome headroom (config: risk.perMarketMaxPct)`,
        {
          equity,
          perMarketMaxPct: risk.perMarketMaxPct,
          outcomeExposure,
          capAbs,
          headroom,
        },
      );
    }
    // Clamp buy size to headroom; for sells, notional is based on position and unaffected by cap
    if (legDirection === "buy") {
      notional = Math.min(notional, headroom);
      if (notional <= 0) {
        return reject(
          "per_outcome_cap_zeroed",
          `Reject: buy size clamped to $0 by outcome cap`,
          // `Reject: buy size clamped to $0 by outcome cap (config: risk.perMarketMaxPct)`,
          {
            equity,
            perMarketMaxPct: risk.perMarketMaxPct,
            outcomeExposure,
            capAbs,
            headroom,
          },
        );
      }
    }
  }

  // Gating using spread and liquidity (when available)
  const gating = (runtime.tradeEvaluation.gating ?? {
    maxSpreadPct: 1.0,
    minTopBookNotional: 0,
    liquidityLevels: 1,
    requireFullNotionalAtDepth: true,
  }) as NonNullable<RuntimeConfig["tradeEvaluation"]["gating"]>;
  const spread = computeSpreadPct(
    (outcome as any).bestBid,
    (outcome as any).bestAsk,
  );
  if (gating.requireLiveDepthForPrefilter && spread === undefined) {
    return reject(
      "missing_best_bid_ask",
      "Reject: missing best bid/ask",
      // "Reject: missing best bid/ask (config: tradeEvaluation.gating.requireLiveDepthForPrefilter)",
      {
        bestBid: (outcome as any).bestBid,
        bestAsk: (outcome as any).bestAsk,
        requireLiveDepthForPrefilter: gating.requireLiveDepthForPrefilter,
      },
    );
  }
  if (spread !== undefined && spread > gating.maxSpreadPct) {
    return reject(
      "spread_too_wide",
      `Reject: spread ${fmtPct(spread)} > ${fmtPct(gating.maxSpreadPct)}`,
      // `Reject: spread ${fmtPct(spread)} > ${fmtPct(gating.maxSpreadPct)} (config: tradeEvaluation.gating.maxSpreadPct)`,
      {
        bestBid: (outcome as any).bestBid,
        bestAsk: (outcome as any).bestAsk,
        spreadPct: spread,
        maxSpreadPct: gating.maxSpreadPct,
        ttlHours,
      },
    );
  }

  const askLevels = (outcome as any).askLevels as OrderBookLevel[] | undefined;
  const bidLevels = (outcome as any).bidLevels as OrderBookLevel[] | undefined;
  const sizing = runtime.execution.sizing ?? {
    mode: "fixed",
    minNotional: 0,
    maxDepthLevels: gating.liquidityLevels,
  };
  const depthLevels = Math.max(
    gating.liquidityLevels,
    sizing.maxDepthLevels ?? gating.liquidityLevels,
  );
  const levelsForSide = legDirection === "buy" ? askLevels : bidLevels;
  if (
    gating.requireLiveDepthForPrefilter &&
    (!levelsForSide || levelsForSide.length === 0)
  ) {
    return reject(
      "missing_depth_levels",
      `Reject: missing live ${legDirection === "buy" ? "ask" : "bid"} depth`,
      // `Reject: missing live ${legDirection === "buy" ? "ask" : "bid"} depth (config: tradeEvaluation.gating.requireLiveDepthForPrefilter)`,
      { direction: legDirection, levels: levelsForSide?.length ?? 0 },
    );
  }
  const topNotional = sumTopNotional(levelsForSide, depthLevels);
  if (gating.requireLiveDepthForPrefilter && topNotional === undefined) {
    return reject(
      "missing_top_book",
      "Reject: missing top-of-book notional",
      // "Reject: missing top-of-book notional (config: tradeEvaluation.gating.requireLiveDepthForPrefilter)",
      {
        direction: legDirection,
        levels: levelsForSide?.length ?? 0,
        depthLevels,
      },
    );
  }
  const effectiveMinTop = Math.max(
    0,
    (gating.minTopBookNotional ?? 0) * depthReliefFactor,
  );
  if (topNotional !== undefined) {
    if (
      sizing.mode === "auto_scale_to_depth" &&
      !gating.requireFullNotionalAtDepth
    ) {
      const minDepthNeeded = Math.max(sizing.minNotional ?? 0, effectiveMinTop);
      if (topNotional + 1e-9 < minDepthNeeded) {
        return reject(
          "insufficient_depth_min_notional",
          `Reject: depth ${fmtUsd(topNotional)} < min ${fmtUsd(minDepthNeeded)}`,
          // `Reject: depth ${fmtUsd(topNotional)} < min ${fmtUsd(minDepthNeeded)} (config: tradeEvaluation.gating.minTopBookNotional / execution.sizing.minNotional)`,
          {
            direction: legDirection,
            topNotional,
            minDepthNeeded,
            sizingMode: sizing.mode,
            minTopBookNotional: gating.minTopBookNotional ?? 0,
            sizingMinNotional: sizing.minNotional ?? 0,
            ttlHours,
            depthReliefFactor,
          },
        );
      }
      if (topNotional < notional) {
        notional = topNotional;
      }
    } else {
      const minNeeded = Math.max(effectiveMinTop, notional);
      if (topNotional + 1e-9 < minNeeded) {
        return reject(
          "insufficient_depth_for_notional",
          `Reject: depth ${fmtUsd(topNotional)} < required ${fmtUsd(minNeeded)}`,
          // `Reject: depth ${fmtUsd(topNotional)} < required ${fmtUsd(minNeeded)} (config: tradeEvaluation.gating.minTopBookNotional / sizing)`,
          {
            direction: legDirection,
            topNotional,
            requiredNotional: minNeeded,
            requestedNotional: notional,
            requireFullNotionalAtDepth: gating.requireFullNotionalAtDepth,
            ttlHours,
            depthReliefFactor,
          },
        );
      }
    }
  }

  // Slippage-aware expected price
  const slippage = runtime.execution.slippageModel ?? {
    type: "depth_aware",
    levels: gating.liquidityLevels,
  };
  let expectedPrice: number | undefined;
  let avgFillPrice: number | undefined;
  let expectedPriceSource: "depth_aware" | "midpoint" | "snapshot";
  if (slippage.type === "depth_aware") {
    const normalizedSnap =
      typeof outcome.price === "number"
        ? outcome.price > 1
          ? outcome.price / 100
          : outcome.price
        : undefined;
    const fill = estimateFillPrices(
      legDirection === "buy" ? askLevels : bidLevels,
      notional,
    );
    if (fill) {
      avgFillPrice = fill.average;
      expectedPrice = fill.limit;
    } else if (gating.requireLiveDepthForPrefilter) {
      return reject(
        "cannot_estimate_fill",
        "Reject: cannot estimate fill price from live depth",
        // "Reject: cannot estimate fill price from live depth (config: tradeEvaluation.gating.requireLiveDepthForPrefilter)",
        {
          direction: legDirection,
          notional,
          levels: (legDirection === "buy" ? askLevels : bidLevels)?.length ?? 0,
        },
      );
    } else {
      expectedPrice =
        (legDirection === "buy"
          ? (outcome as any).bestAsk
          : (outcome as any).bestBid) ??
        normalizedSnap ??
        0.5;
    }
    expectedPriceSource = "depth_aware";
  } else {
    const bb = (outcome as any).bestBid as number | undefined;
    const ba = (outcome as any).bestAsk as number | undefined;
    const normalizedSnap =
      typeof outcome.price === "number"
        ? outcome.price > 1
          ? outcome.price / 100
          : outcome.price
        : undefined;
    expectedPrice =
      bb !== undefined && ba !== undefined
        ? (bb + ba) / 2
        : (normalizedSnap ?? 0.5);
    expectedPriceSource = "midpoint";
  }
  if (expectedPrice === (outcome.price ?? 0.5))
    expectedPriceSource = expectedPriceSource ?? "snapshot";

  // Guard: expected price must be within configured price bounds (if provided in exits)
  const floor = (runtime as any).exits?.priceFloor as number | undefined;
  const ceiling = (runtime as any).exits?.priceCeiling as number | undefined;
  const priceForBounds =
    typeof expectedPrice === "number" ? expectedPrice : avgFillPrice;
  if (typeof priceForBounds === "number") {
    if (
      (typeof floor === "number" && priceForBounds < floor) ||
      (typeof ceiling === "number" && priceForBounds > ceiling)
    ) {
      return reject(
        "price_out_of_bounds",
        `Reject: expected price ${priceForBounds.toFixed(3)} outside bounds`,
        // `Reject: expected price ${priceForBounds.toFixed(3)} outside bounds (config: exits.priceFloor/exits.priceCeiling)`,
        {
          expectedPrice: priceForBounds,
          floor: floor ?? null,
          ceiling: ceiling ?? null,
          expectedPriceSource,
        },
      );
    }
  }

  // Guard: respect maxPayPrice from decision when provided (buy only)
  if (
    legDirection === "buy" &&
    typeof decision.maxPayPrice === "number" &&
    typeof expectedPrice === "number" &&
    expectedPrice > decision.maxPayPrice + 1e-9
  ) {
    return reject(
      "max_pay_exceeded",
      `Reject: expected ${expectedPrice.toFixed(3)} > maxPay ${decision.maxPayPrice.toFixed(3)} (LLM)`,
      { expectedPrice, maxPayPrice: decision.maxPayPrice, expectedPriceSource },
    );
  }

  // Guard: large divergence between live expected price and snapshot price suggests mapping/data mismatch; reject conservatively
  const snapNorm =
    typeof outcome.price === "number"
      ? outcome.price > 1
        ? outcome.price / 100
        : outcome.price
      : undefined;
  if (typeof expectedPrice === "number" && typeof snapNorm === "number") {
    const diff = Math.abs(expectedPrice - snapNorm);
    if (diff >= 0.3 && (expectedPrice >= 0.9 || snapNorm <= 0.1)) {
      return reject(
        "live_snapshot_divergence",
        `Reject: live ${expectedPrice.toFixed(3)} diverges from snapshot ${snapNorm.toFixed(3)} (mapping/data mismatch)`,
        { expectedPrice, snapshotPrice: snapNorm, diff, expectedPriceSource },
      );
    }
  }

  // Net-edge guard: require subjective probability to clear friction (half spread) + configured minimum edge (bps) vs expected fill.
  const minNetEdgeBps = getMinEdgeBpsNet(runtime);
  if (
    legDirection === "buy" &&
    typeof decision.subjectiveProb === "number" &&
    typeof expectedPrice === "number"
  ) {
    const bb = (outcome as any).bestBid as number | undefined;
    const ba = (outcome as any).bestAsk as number | undefined;
    const halfSpread =
      typeof bb === "number" && typeof ba === "number"
        ? Math.max(0, (ba - bb) / 2)
        : 0;
    const netEdge = decision.subjectiveProb - expectedPrice; // in price space (0..1)
    const minEdgeBpsEffective = Math.max(
      0,
      (typeof minNetEdgeBps === "number" ? minNetEdgeBps : 0) - ttlReliefBps,
    );
    const minEdgeAbs = minEdgeBpsEffective / 10000; // convert bps to absolute
    const takerAbs =
      Math.max(
        0,
        decision.takerFeeBps ?? (runtime as any)?.fees?.trading?.takerBps ?? 0,
      ) / 10000;
    const friction = halfSpread + takerAbs + minEdgeAbs;
    if (netEdge + 1e-12 < friction) {
      return reject(
        "net_edge_insufficient",
        `Reject: net edge ${fmtPct(netEdge)} < required ${fmtPct(friction)}`,
        // `Reject: net edge ${fmtPct(netEdge)} < required ${fmtPct(friction)} (config: tradeEvaluation.minEdgeBpsNet / fees / maxSpreadPct)`,
        {
          subjectiveProb: decision.subjectiveProb,
          expectedPrice,
          expectedPriceSource,
          netEdge,
          friction,
          frictionBreakdown: {
            halfSpread,
            takerAbs,
            minEdgeAbs,
            minNetEdgeBps,
            ttlReliefBps,
            minEdgeBpsEffective,
          },
          ttlHours,
        },
      );
    }
  }

  // Reserve funds immediately if strategy requires it
  let reservedAmount: number | undefined;
  let reservationId: string | undefined;
  if (legDirection === "buy" && runtime.execution.reserveBalance) {
    const r = portfolio.reserve(notional);
    reservedAmount = r.amount;
    reservationId = r.id;
  }

  // Exit plan thresholds if configured (apply optional max caps; preserve behavior when fields are absent)
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v)); // for SL
  const clampNonNeg = (v: number) => Math.max(0, v); // for TP (allow >100%)
  const tpCandidate = (
    typeof decision.tpPct === "number"
      ? decision.tpPct
      : (runtime as any).exits?.takeProfitPct
  ) as number | undefined;
  const slCandidate = (
    typeof decision.slPct === "number"
      ? decision.slPct
      : (runtime as any).exits?.stopLossPct
  ) as number | undefined;
  const tpCap = (runtime as any).exits?.maxTakeProfitPct as number | undefined;
  const slCap = (runtime as any).exits?.maxStopLossPct as number | undefined;
  const takeProfitPct =
    typeof tpCandidate === "number"
      ? clampNonNeg(
          typeof tpCap === "number"
            ? Math.min(tpCandidate, tpCap)
            : tpCandidate,
        )
      : undefined;
  const stopLossPct =
    typeof slCandidate === "number"
      ? clamp01(
          typeof slCap === "number"
            ? Math.min(slCandidate, slCap)
            : slCandidate,
        )
      : undefined;
  const tpRaw =
    takeProfitPct && expectedPrice
      ? expectedPrice * (1 + takeProfitPct)
      : undefined;
  const slRaw =
    stopLossPct && expectedPrice
      ? expectedPrice * (1 - stopLossPct)
      : undefined;
  const clamp = (v?: number) => {
    if (typeof v !== "number") return undefined;
    const f = (runtime as any).exits?.priceFloor;
    const c = (runtime as any).exits?.priceCeiling;
    const floorB = typeof f === "number" ? f : 0.0;
    const ceilB = typeof c === "number" ? c : 1.0;
    return Math.min(ceilB, Math.max(floorB, v));
  };
  const tp = clamp(tpRaw);
  const sl = clamp(slRaw);

  const instruction: TradeInstructionInsert = {
    evaluationId,
    agentId,
    marketId: market.id,
    optionId: outcome.id,
    direction: legDirection,
    notional,
    expectedPrice: expectedPrice,
    stopPrice: sl,
    takeProfitPrice: tp,
    reason: `${legDirection === "buy" ? "Buy" : "Sell"} ${outcome.name} @~${(avgFillPrice ?? expectedPrice ?? 0).toFixed(3)} (${expectedPriceSource}${
      typeof avgFillPrice === "number" &&
      typeof expectedPrice === "number" &&
      Math.abs(avgFillPrice - expectedPrice) > 1e-6
        ? `, limit≤${expectedPrice.toFixed(3)}`
        : ""
    }); notional=${notional.toFixed(2)}; meta[outcomeId=${decision.outcomeId}, prob=${decision.subjectiveProb !== undefined ? decision.subjectiveProb.toFixed(3) : "n/a"}, maxPay=${decision.maxPayPrice !== undefined ? decision.maxPayPrice.toFixed(3) : "n/a"}, edgeBps=${decision.edgeBps ?? "n/a"}, basis=${decision.priceBasis ?? "n/a"}, ttl=${ttlHours !== undefined ? `${ttlHours}h` : "n/a"}]; gates ok: spread=${spread !== undefined ? spread.toFixed(3) : "n/a"}, topNotional=${topNotional !== undefined ? topNotional.toFixed(2) : "n/a"}@L${depthLevels}${sizing.mode === "auto_scale_to_depth" && !gating.requireFullNotionalAtDepth ? "; autoscaled" : ""}${ttlReliefBps > 0 ? `; ttlRelief=${ttlReliefBps}bps` : ""}`,
    createdAt: new Date(),
  };

  return { instruction, reservedAmount, reservationId };
}
