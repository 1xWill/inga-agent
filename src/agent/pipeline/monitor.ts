import type {
  PolymarketClient,
  OrderBookLevel,
} from "../../clients/polymarket";
import type { RuntimeConfig, AgentDefinition } from "../../config/schema";
import type { AgentRepository } from "../repository";
import type { AgentRepositoryAsync } from "../../storage/types";
import type { PortfolioManager } from "../portfolio";
import type { OpenRouterClient } from "../../clients/openrouter";
import { submitLiveSellWithApprovals, type LiveSellResult } from "./exits";
import { AssetType } from "@polymarket/clob-client";
import { ethers } from "ethers";
import { getContractConfig } from "@polymarket/clob-client/dist/config.js";
import { computeExitPriceForSell } from "./pricing";
import { deriveEffectiveTargets } from "./targets";
import { buildMonitorPrompt } from "../../prompts/monitor";
import { getMinEdgeBpsNet } from "./edge";

type LogFn = (msg: string, data?: unknown) => void;

export interface MonitorTickInput {
  agentId: string;
  runtime: RuntimeConfig;
  repo: AgentRepository | AgentRepositoryAsync;
  portfolio: PortfolioManager;
  polymarket: PolymarketClient;
  openrouter: OpenRouterClient;
  // Optional live trading context: when present and agent is live, monitor may
  // submit real SELL orders (respecting execution.live.dryRun) for risk trims.
  agent?: AgentDefinition;
  liveTrading?: { client: any };
  log?: LogFn;
  // Mode:
  // - "full" (default): risk overlay + LLM monitor decisions.
  // - "riskOnly": run exits + risk_trim overlay only; skip LLM calls entirely.
  mode?: "full" | "riskOnly";
}

// Track consecutive monitor close signals (LLM-driven) per position within process lifetime
const monitorCloseCounts = new Map<string, number>();
function closeKey(agentId: string, marketId: string, optionId: string) {
  return `${agentId}:${marketId}:${optionId}:monitor_close`;
}

function sumTopNotional(
  levels: OrderBookLevel[] | undefined,
  k: number,
): number {
  if (!levels || levels.length === 0 || k <= 0) return 0;
  return levels.slice(0, k).reduce((acc, l) => acc + l.price * l.quantity, 0);
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

function safeParseJson(s: string): any {
  try {
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    const json = s.slice(start, end + 1);
    return JSON.parse(json);
  } catch {
    return {};
  }
}

export async function runMonitorTick(input: MonitorTickInput) {
  const {
    agentId,
    runtime,
    repo,
    portfolio,
    polymarket,
    openrouter,
    log,
    agent,
    liveTrading,
    mode,
  } = input;
  const runtimeMode = (runtime as any)?.agent?.monitor?.mode as
    | "full"
    | "riskOnly"
    | undefined;
  const effectiveMode: "full" | "riskOnly" =
    (mode ?? runtimeMode) === "riskOnly" ? "riskOnly" : "full";
  const isLiveAgent = Boolean(agent && agent.paperTrading === false);

  // Clean up orphan risk_trim instructions (no live_order_id but marked open)
  // so they don't show as perpetually pending in the UI.
  try {
    const recent: any[] =
      typeof (repo as any).listRecentTradeInstructions === "function"
        ? await (repo as any).listRecentTradeInstructions(200, agentId)
        : [];
    for (const t of recent) {
      const st = String(t?.liveStatus ?? "").toLowerCase();
      if (
        t.direction === "sell" &&
        typeof t.reason === "string" &&
        t.reason.includes("monitor risk_trim:") &&
        (!t.liveOrderId || String(t.liveOrderId).length === 0) &&
        (st === "" || st === "open" || st === "pending")
      ) {
        try {
          await (repo as any).setTradeInstructionLiveInfo(t.id, {
            status: "failed",
            error: "missing_live_order_id",
            updatedAt: new Date(),
          });
        } catch {}
      }
    }
  } catch {}

  // Ignore sub-tradeable dust positions (consistently across monitor/capacity/UI)
  const minQty = Math.max(0, (runtime as any)?.ui?.minOpenQuantity ?? 0.01);
  const positionsRaw = await (repo as any).listOpenPositions(agentId);
  const positions = positionsRaw.filter((p: any) => p.quantity >= minQty);
  if (positions.length === 0) return;

  // Mandatory auto-redeem: for any resolved market with balance >= minQty, redeem before anything else.
  // Detect resolution via Gamma slug (from latest evaluation summary) and payout prices (0/1).
  const payoutCache = new Map<string, { resolved: boolean; prices: number[] }>();
  const slugOf = async (marketId: string): Promise<string | undefined> => {
    try {
      const ev = await (repo as any).getLatestEvaluationSummary(marketId);
      const url = (ev as any)?.url as string | undefined;
      if (url) {
        const m = url.match(/\/market\/([a-z0-9\-]+)/i);
        if (m) return m[1];
      }
    } catch {}
    return undefined;
  };
  const getPayout = async (marketId: string, outcomeIdx: number): Promise<number | undefined> => {
    const slug = await slugOf(marketId);
    if (!slug) return undefined;
    let entry = payoutCache.get(slug);
    if (!entry) {
      const arr = await polymarket.getMarketsBySlug(slug);
      const mkt = arr.find((m) => (m as any)?.id === marketId) || arr[0];
      if (!mkt) return undefined;
      const resolved = (mkt as any)?.closed === true && String((mkt as any)?.umaResolutionStatus || '').toLowerCase() === 'resolved';
      const prices = (mkt.outcomes ?? []).map((o) => (typeof o.price === 'number' ? o.price : NaN));
      entry = { resolved, prices };
      payoutCache.set(slug, entry);
    }
    if (!entry.resolved) return undefined;
    const v = entry.prices[outcomeIdx];
    return Number.isFinite(v) ? (v as number) : undefined;
  };

  if (agent && agent.paperTrading === false && liveTrading) {
    // Fetch recent trades once to compute fees associated with the remaining open lots per token
    type T = { side: 'buy'|'sell'; price: number; size: number; tokenId: string; feeRateBps?: number; matchTime?: string };
    let tradesByToken = new Map<string, T[]>();
    try {
      const arr: any[] = await (liveTrading as any).client.getTrades({}, true);
      const mapped: T[] = (arr ?? []).map((t) => ({
        side: (String(t?.side ?? '').toLowerCase() === 'sell' ? 'sell' : 'buy') as 'sell' | 'buy',
        price: Number(t?.price ?? 0),
        size: Number(t?.size ?? 0),
        tokenId: String(t?.asset_id ?? ''),
        feeRateBps: typeof t?.fee_rate_bps === 'number' ? t.fee_rate_bps : undefined,
        matchTime: t?.match_time ? String(t.match_time) : undefined,
      })).filter((x) => x.tokenId && x.price > 0 && x.size > 0);
      // chronological
      mapped.sort((a, b) => (new Date(a.matchTime || 0).getTime() - new Date(b.matchTime || 0).getTime()));
      for (const t of mapped) {
        const arr2 = tradesByToken.get(t.tokenId) ?? [];
        arr2.push(t);
        tradesByToken.set(t.tokenId, arr2);
      }
    } catch {}

    // Compute remaining open-lot fees per token: sum of fees from unmatched buy lots
    const openFeesByToken = new Map<string, number>();
    for (const [token, arr] of tradesByToken.entries()) {
      type Lot = { qty: number; fee: number };
      const lots: Lot[] = [];
      for (const t of arr) {
        const bps = typeof t.feeRateBps === 'number' ? t.feeRateBps : 0;
        const fee = Math.abs(t.price * t.size) * (bps / 10000);
        if (t.side === 'buy') {
          lots.push({ qty: t.size, fee });
        } else {
          // consume oldest buy lots first (FIFO) for simplicity
          let remaining = t.size;
          while (remaining > 1e-12 && lots.length > 0) {
            const lot = lots[0];
            const take = Math.min(remaining, lot.qty);
            lot.qty -= take;
            remaining -= take;
            if (lot.qty <= 1e-12) lots.shift();
          }
        }
      }
      const sumFees = lots.reduce((a, l) => a + l.fee, 0);
      openFeesByToken.set(token, sumFees);
    }
    // In-process de-dupe for concurrent auto-redeems across agents/loops (keyed by conditionId)
    const REDEEM_INFLIGHT: Set<string> = (global as any).__INGA_REDEEM_INFLIGHT__ ||= new Set<string>();
    for (const pos of positions) {
      const tokenIdStr = String(pos.optionId);
      if (!/^\d+$/.test(tokenIdStr)) continue;
      // Check resolution and payout
      let payout: number | undefined = undefined;
      try {
        const idx = await (repo as any).getOutcomeIndexByClobTokenId(pos.marketId, tokenIdStr);
        if (typeof idx === 'number') payout = await getPayout(pos.marketId, idx);
      } catch {}
      if (typeof payout !== 'number') continue;
      // Check on-chain conditional balance to avoid dust and redundant calls
      let shares = 0;
      try {
        const bal = await (liveTrading as any).client.getBalanceAllowance({ asset_type: AssetType.CONDITIONAL, token_id: tokenIdStr });
        const raw = Number(((bal as any)?.balance ?? '0'));
        shares = raw / 1e6;
      } catch {}
      if (shares + 1e-12 < minQty) continue;

      // If payout is 0 (losing outcome), there is no on-chain USDC inflow and
      // redeem is optional from a cash perspective. Still persist the close so
      // CLOSED POSITIONS shows the realized loss immediately.
      if (payout === 0) {
        try {
          const feesPaid = Number(openFeesByToken.get(tokenIdStr) ?? 0);
          await (repo as any).recordClosedPositions(agentId, [{
            marketId: pos.marketId,
            optionId: tokenIdStr,
            quantity: pos.quantity,
            averagePrice: pos.averagePrice,
            exitPrice: 0,
            realizedPnl: (0 - pos.averagePrice) * pos.quantity - feesPaid,
            feesPaid,
            closedAt: new Date().toISOString(),
          }]);
        } catch {}
        try { await (repo as any).closePosition(agentId, pos.marketId, tokenIdStr, new Date()); } catch {}
        continue;
      }

      const alreadyRedeeming = REDEEM_INFLIGHT.has(pos.marketId);
      if (!alreadyRedeeming) REDEEM_INFLIGHT.add(pos.marketId);
      // Redeem now using agent EOA (only once per condition per process). Always persist close for this token.
      try {
        const chainId = Number(process.env.POLY_CHAIN_ID || 137);
        const cfg = getContractConfig(chainId as any) as any;
        const ctfAddr = process.env.POLY_CONDITIONAL_TOKENS || cfg.conditionalTokens;
        const collateral = process.env.POLY_COLLATERAL_TOKEN || cfg.collateral;
        const rpcUrl = process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com';
        const { Wallet } = ethers as any;
        const pk = process.env[agent.walletPrivateKeyEnv as string] as string | undefined;
        const provider = new (ethers as any).providers.JsonRpcProvider(rpcUrl, chainId);
        const wallet = new Wallet(pk && pk.startsWith('0x') ? pk : `0x${pk}`, provider);
        const CTF_ABI = [ 'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external' ];
        const ctf = new (ethers as any).Contract(ctfAddr, CTF_ABI, wallet);
        const parentZero = '0x' + '00'.repeat(32);
        const indexSets = [1, 2];
        const fee = await provider.getFeeData();
        const minPrio = (ethers as any).utils.parseUnits('30', 'gwei');
        const prio = fee.maxPriorityFeePerGas && fee.maxPriorityFeePerGas.gt(minPrio) ? fee.maxPriorityFeePerGas : minPrio;
        const base = fee.gasPrice || (ethers as any).utils.parseUnits('60', 'gwei');
        let max = fee.maxFeePerGas; if (!max || max.lt(prio)) max = base.mul(2).add(prio);
        if (!alreadyRedeeming) {
          const tx = await ctf.redeemPositions(collateral, parentZero, pos.marketId, indexSets, { type: 2, maxPriorityFeePerGas: prio, maxFeePerGas: max });
          if (log) log('Auto-redeem submitted', { marketId: pos.marketId, optionId: tokenIdStr, tx: tx.hash });
          const confs = Math.max(1, Number(process.env.POLY_TX_CONFIRMATIONS || '1'));
          await provider.waitForTransaction(tx.hash, confs, 180_000).catch(() => undefined);
        }
        // Persist closed row; include estimated trading fees for the remaining open lot
        try {
          const feesPaid = Number(openFeesByToken.get(tokenIdStr) ?? 0);
          await (repo as any).recordClosedPositions(agentId, [{
            marketId: pos.marketId,
            optionId: tokenIdStr,
            quantity: pos.quantity,
            averagePrice: pos.averagePrice,
            exitPrice: payout,
            realizedPnl: (payout - pos.averagePrice) * pos.quantity - feesPaid,
            feesPaid,
            closedAt: new Date().toISOString(),
          }]);
        } catch {}
        // Record an Activities entry mirroring numeric exits so UI shows auto‑redeems.
        // No LLM reasoning; simple rationale only. Mark as filled immediately.
        try {
          const instructionId: number = await (repo as any).recordTradeInstruction({
            evaluationId: 0,
            agentId,
            marketId: pos.marketId,
            optionId: tokenIdStr,
            direction: 'sell',
            notional: Math.max(0, (pos.quantity ?? 0) * (payout ?? 0)),
            expectedPrice: payout,
            reason: 'auto-redeem for resolved markets',
            createdAt: new Date(),
          });
          try { await (repo as any).setTradeInstructionLiveInfo(instructionId, { status: 'filled' }); } catch {}
          try { await (repo as any).setTradeInstructionExecutionInfo(instructionId, { executedAt: new Date() }); } catch {}
        } catch {}
        try { await (repo as any).closePosition(agentId, pos.marketId, tokenIdStr, new Date()); } catch {}
      } catch (e) {
        if (log) log('Auto-redeem failed', { marketId: pos.marketId, optionId: tokenIdStr, error: (e as Error).message });
      } finally {
        if (!alreadyRedeeming) REDEEM_INFLIGHT.delete(pos.marketId);
      }
    }
  }
  // Re-read positions after potential auto-redeem (best-effort) so numeric monitor continues on remaining opens
  {
    try {
      const refreshed = await (repo as any).listOpenPositions(agentId);
      const filtered = refreshed.filter((p: any) => p.quantity >= minQty);
      if (filtered.length === 0) return; // nothing left to monitor
      // overwrite local set for the rest of numeric monitor
      (positions as any).length = 0;
      for (const p of filtered) (positions as any).push(p);
    } catch {}
  }

  // Always fetch live orderbook data for execution-critical logic; DB marks are for display/UI only.

  // Near-resolution SELL guard helper (optional): block SELLs within a window around
  // scheduled close, and when Gamma shows closed but not yet resolved. Uses the
  // slugOf() helper above and caches Gamma results per slug for this tick.
  const guardEnabled = Boolean((runtime as any)?.exits?.resolutionGuardEnabled) &&
    typeof (runtime as any)?.exits?.resolutionGuardMinutes === 'number' &&
    (runtime as any).exits.resolutionGuardMinutes > 0;
  const guardMins = (runtime as any)?.exits?.resolutionGuardMinutes ?? 0;
  const metaCache = new Map<string, any[]>();
  const isInResolutionGuardWindow = async (marketId: string): Promise<boolean> => {
    if (!guardEnabled) return false;
    const slug = await slugOf(marketId);
    if (!slug) return false;
    let arr = metaCache.get(slug);
    if (!arr) {
      try { arr = await polymarket.getMarketsBySlug(slug); metaCache.set(slug, arr); } catch { return false; }
    }
    const mkt = Array.isArray(arr) ? (arr.find((m: any) => (m as any)?.id === marketId) || arr[0]) : undefined;
    if (!mkt) return false;
    const resolved = (mkt as any)?.closed === true && String((mkt as any)?.umaResolutionStatus || '').toLowerCase() === 'resolved';
    if ((mkt as any)?.closed === true && !resolved) return true;
    const refIso: string | undefined = (mkt as any)?.closedTime || (mkt as any)?.endDate;
    if (!refIso) return false;
    const ref = new Date(refIso);
    if (!(ref instanceof Date) || isNaN(ref.getTime())) return false;
    const deltaMin = Math.abs((Date.now() - ref.getTime()) / 60000);
    return deltaMin <= guardMins;
  };

  // Build name/title maps for prompts
  const evalsArr: any[] = await (repo as any).listRecentMarketEvaluations(200, agentId);
  const titleMap = new Map<string, string>();
  const nameMap = new Map<string, string>();
  for (const e of evalsArr) {
    titleMap.set(e.marketId, e.title);
    for (const o of e.outcomes as Array<{ id: string; name: string }>) {
      nameMap.set(`${e.marketId}:${o.id}`, o.name);
    }
  }

  const levels = runtime.tradeEvaluation.gating?.liquidityLevels ?? 1;
  const floor = (runtime as any).exits?.priceFloor ?? 0.0;
  const ceiling = (runtime as any).exits?.priceCeiling ?? 1.0;
  const minExitNotional = runtime.exits?.minExitTopBookNotional ?? 0;
  const maxBuyConcurrency = (runtime.polling as any).monitorMaxBuyPerTick ?? 1;
  let buysExecutedThisTick = 0;

  for (const pos of positions) {
    // Hydrate book and compute marks (prefer DB marks when enabled)
    let bestBid: number | undefined;
    let bestAsk: number | undefined;
    let bids: OrderBookLevel[] = [];
    let asks: OrderBookLevel[] = [];
    try {
      const tokenId =
        typeof pos.optionId === "string" && /^\d+$/.test(pos.optionId)
          ? pos.optionId
          : undefined;
      // Avoid CLOB /book for resolved markets — use payout mark when available
      let resolvedPayout: number | undefined = undefined;
      try {
        if (tokenId) {
          const idx = await (repo as any).getOutcomeIndexByClobTokenId(pos.marketId, tokenId);
          if (typeof idx === 'number') {
            // cache per slug in this scope
            const slug = await (async () => {
              try {
                const ev = await (repo as any).getLatestEvaluationSummary(pos.marketId);
                const url = (ev as any)?.url as string | undefined;
                const m = url ? url.match(/\/market\/([a-z0-9\-]+)/i) : undefined;
                return m ? m[1] : undefined;
              } catch { return undefined; }
            })();
            if (slug) {
              const arr = await polymarket.getMarketsBySlug(slug);
              const mkt = arr.find((m) => (m as any)?.id === pos.marketId) || arr[0];
              const resolved = (mkt as any)?.closed === true && String((mkt as any)?.umaResolutionStatus || '').toLowerCase() === 'resolved';
              if (resolved) {
                const prices = (mkt.outcomes ?? []).map((o) => (typeof o.price === 'number' ? o.price : NaN));
                const v = prices[idx];
                resolvedPayout = Number.isFinite(v) ? (v as number) : undefined;
              }
            }
          }
        }
      } catch {}
      const ob = tokenId && typeof resolvedPayout !== 'number' ? await polymarket.getOrderBook(tokenId) : undefined;
      if (ob) {
        bids = [...ob.bids].sort((a, b) => b.price - a.price);
        asks = [...ob.asks].sort((a, b) => a.price - b.price);
        bestBid = bids[0]?.price;
        bestAsk = asks[0]?.price;
      } else if (typeof resolvedPayout === 'number') {
        bestBid = resolvedPayout;
        bestAsk = resolvedPayout;
      }
    } catch {}
    const mid =
      typeof bestBid === "number" && typeof bestAsk === "number"
        ? (bestBid + bestAsk) / 2
        : undefined;
    // Do not write marks here; server refresher is the sole writer for display marks.

    // Skip if no price basis yet
    const priceForThresholds =
      typeof bestBid === "number" ? bestBid : undefined;
    if (
      typeof priceForThresholds !== "number" ||
      priceForThresholds < floor ||
      priceForThresholds > ceiling
    ) {
      continue;
    }

    // Target-first exits using latest entry TP/SL (from trade instructions)
    const recentTrades: any[] = await (repo as any).listRecentTradeInstructions(
      200,
      agentId,
    );
    const lastEntry = recentTrades.find(
      (t) =>
        t.direction === "buy" &&
        t.marketId === pos.marketId &&
        t.optionId === pos.optionId,
    );
    const { tpOrig, slOrig, tpEff, slEff } = deriveEffectiveTargets(
      lastEntry
        ? {
            expectedPrice: lastEntry.expectedPrice,
            takeProfitPrice: lastEntry.takeProfitPrice,
            stopPrice: lastEntry.stopPrice,
          }
        : undefined,
      runtime as any,
    );
    const tp = tpEff;
    const sl = slEff;
    const basis = typeof bestBid === "number" ? bestBid : undefined;
    const openedAgoMs = Date.now() - pos.openedAt.getTime();
    const minHoldMinutes =
      runtime.agent?.monitor?.cooldown?.minHoldingMinutes ??
      runtime.exits?.minHoldingMinutes ??
      0;
    const minHoldMs = Math.max(0, minHoldMinutes) * 60 * 1000;
    const confOverride =
      runtime.agent?.monitor?.cooldown?.highConfidenceOverride ?? 0.8;
    const allowEarlyExit = openedAgoMs >= minHoldMs;
    const canApplyTargets =
      typeof basis === "number" &&
      (typeof tp === "number" || typeof sl === "number");
    if (!isLiveAgent && canApplyTargets) {
      // Block target-first SELL exits within resolution guard window
      try {
        if (await isInResolutionGuardWindow(pos.marketId)) {
          if (log) log('Monitor target exit deferred (resolution guard)', { marketId: pos.marketId, optionId: pos.optionId, minutes: guardMins });
          continue;
        }
      } catch {}
      const hitTp = typeof tp === "number" && basis >= tp - 1e-9;
      const hitSl = typeof sl === "number" && basis <= sl + 1e-9;
      if (hitTp || hitSl) {
        const computed = computeExitPriceForSell({
          bestBid,
          mid,
          averagePrice: pos.averagePrice,
          quantity: pos.quantity,
          exitsConfig: runtime.exits,
        });
        if (!computed) {
          continue;
        }
        const { exitPrice, notional } = computed;
        const instructionId: number = await (repo as any).recordTradeInstruction(
          {
            evaluationId: 0,
            agentId,
            marketId: pos.marketId,
            optionId: pos.optionId,
            direction: "sell",
            notional,
            expectedPrice: exitPrice,
            reason: hitTp
              ? `target TP hit @~${exitPrice.toFixed(3)}`
              : `target SL hit @~${exitPrice.toFixed(3)}`,
            createdAt: new Date(),
          },
        );
        await (portfolio as any).executeTrade({
          tradeInstructionId: instructionId,
          marketId: pos.marketId,
          optionId: pos.optionId,
          direction: "sell",
          price: exitPrice,
          notional,
          metadata: {
            feeBps: (runtime as any)?.fees?.trading?.takerBps ?? 0,
            feeSource: (runtime as any)?.fees?.source ?? "config",
          },
        });
        await (repo as any).clearMarketCooldowns(agentId, pos.marketId);
        if (log)
          log("Monitor executed target exit", {
            marketId: pos.marketId,
            optionId: pos.optionId,
            hit: hitTp ? "tp" : "sl",
            price: exitPrice,
          });
        continue;
      }
    }
    if (isLiveAgent && canApplyTargets) {
      // For live agents, rely on the dedicated exits pipeline to submit real SELLs
      // to avoid duplicate instructions without posted orders.
    }

    // Risk-driven overlay: if current outcome exposure exceeds perMarketMaxPct × equity,
    // proactively trim the position by selling enough notional to move back toward the cap.
    // Treat sub-tradeable over-cap exposure (below ui.minOpenQuantity) as dust and skip.
    if (runtime.risk?.perMarketMaxPct !== undefined) {
      const snapshotRisk = portfolio.snapshot();
      const positionsCostRisk = snapshotRisk.positions.reduce(
        (acc, p) => acc + p.averagePrice * p.quantity,
        0,
      );
      const equityRisk =
        snapshotRisk.cashBalance +
        snapshotRisk.reservedBalance +
        positionsCostRisk;
      const capAbs = Math.max(0, runtime.risk.perMarketMaxPct * equityRisk);
      const outcomeExposure = snapshotRisk.positions
        .filter((p) => p.marketId === pos.marketId && p.optionId === pos.optionId)
        .reduce((acc, p) => acc + p.averagePrice * p.quantity, 0);
      if (log) {
        log("Monitor risk_trim check", {
          marketId: pos.marketId,
          equity: equityRisk,
          capAbs,
          outcomeExposure,
        });
      }
      if (outcomeExposure > capAbs + 1e-9) {
        // Block risk trims within resolution guard window
        try {
          if (await isInResolutionGuardWindow(pos.marketId)) {
            await (repo as any).recordPlanDecision({
              evaluationId: 0,
              agentId,
              marketId: pos.marketId,
              outcomeId: pos.optionId,
              status: 'rejected',
              reason: `monitor[action=risk_trim]; gate: resolution_guard (${guardMins}m)`,
              createdAt: new Date(),
            });
            continue;
          }
        } catch {}
        const over = outcomeExposure - capAbs;
        const posExposure = pos.averagePrice * pos.quantity;
        if (posExposure > 0 && over > 0) {
          const priceInfo = computeExitPriceForSell({
            bestBid,
            mid,
            averagePrice: pos.averagePrice,
            // Quantity here is only used to validate we have a positive
            // executable price; we compute the actual shares below.
            quantity: 1,
            exitsConfig: runtime.exits,
          });
          if (!priceInfo || !(priceInfo.exitPrice > 0)) {
            continue;
          }
          const exitPrice = priceInfo.exitPrice;

          // Dust guard: if the over-cap exposure is smaller than the minimum
          // tradeable notional implied by ui.minOpenQuantity, treat it as dust.
          const minQtyShares = typeof minQty === "number" ? minQty : 0.01;
          const minTrimNotional = exitPrice * minQtyShares;
          if (over + 1e-9 < minTrimNotional) {
            if (log) {
              log("Monitor risk_trim skipped (dust over-cap)", {
                marketId: pos.marketId,
                optionId: pos.optionId,
                equity: equityRisk,
                capAbs,
                outcomeExposure,
                over,
                minTrimNotional,
                minQtyShares,
              });
            }
            continue;
          }

          // Compute desired reduction on this position (at most its full exposure).
          const reduceExposure = Math.min(posExposure, over);
          const qtyToSell = reduceExposure / pos.averagePrice;
          // Guard on depth: do not plan more than top-of-book bid notional.
          const bidTop = sumTopNotional(bids, levels);
          const maxQtyByDepth =
            typeof exitPrice === "number" && exitPrice > 0
              ? bidTop / exitPrice
              : 0;
          const qtyClamped = Math.max(
            0,
            Math.min(qtyToSell, pos.quantity, maxQtyByDepth),
          );
          if (!(qtyClamped > 0)) {
            continue;
          }

          const sharesToSell = qtyClamped;
          // Live CLOB enforces a minimum share size (ui.minOpenQuantity)
          // and 2-decimal precision; avoid emitting dust-sized trims.
          if (!(sharesToSell >= minQtyShares)) {
            if (log) {
              log("Monitor risk_trim skipped (dust shares)", {
                marketId: pos.marketId,
                optionId: pos.optionId,
                equity: equityRisk,
                capAbs,
                outcomeExposure,
                over,
                sharesToSell,
                minQtyShares,
              });
            }
            continue;
          }

          const notional = sharesToSell * exitPrice;
          if (!(notional > 0)) {
            continue;
          }

          const instructionId: number = await (repo as any).recordTradeInstruction(
            {
              evaluationId: 0,
              agentId,
              marketId: pos.marketId,
              optionId: pos.optionId,
              direction: "sell",
              notional,
              expectedPrice: exitPrice,
              reason: `monitor risk_trim: outcomeExposure=${outcomeExposure.toFixed(
                2,
              )} > cap=${capAbs.toFixed(2)}; notional=${notional.toFixed(2)}`,
              createdAt: new Date(),
            },
          );
          let feeBps: number | undefined;
          try {
            const tokenId =
              typeof pos.optionId === "string" && /^\d+$/.test(pos.optionId)
                ? pos.optionId
                : undefined;
            feeBps = tokenId
              ? await polymarket.getFeeRateBps(tokenId)
              : undefined;
          } catch {}
          const feeSource =
            typeof feeBps === "number"
              ? "clob_fee_rate"
              : ((runtime as any)?.fees?.source ?? "config");
          const effectiveFeeBps =
            typeof feeBps === "number"
              ? feeBps
              : ((runtime as any)?.fees?.trading?.takerBps ?? 0);

          // Record decision before executing (numeric-only rationale; no LLM citations).
          await (repo as any).recordPlanDecision({
            evaluationId: 0,
            agentId,
            marketId: pos.marketId,
            outcomeId: pos.optionId,
            status: "accepted",
            reason: `monitor[action=risk_trim] outcomeExposure=${outcomeExposure.toFixed(
              2,
            )} cap=${capAbs.toFixed(2)} notional=${notional.toFixed(2)}`,
            createdAt: new Date(),
          });

          const hasLiveClient =
            !!liveTrading && !!(liveTrading as any).client;
          const tokenIdStr = String(pos.optionId);
          const isNumericToken = /^\d+$/.test(tokenIdStr);

          let submitted = false;
          let liveNotional = 0;
          let resLive: LiveSellResult | undefined;

          if (isLiveAgent && hasLiveClient && isNumericToken && liveTrading && agent) {
            try {
              resLive = await submitLiveSellWithApprovals({
                agentId,
                agent,
                runtime,
                polymarket,
                liveTrading: liveTrading as any,
                marketId: pos.marketId,
                optionId: pos.optionId,
                maxShares: sharesToSell,
                minQty,
                price: exitPrice,
                log,
              });
              liveNotional = resLive.notional;
              submitted = resLive.posted && !!resLive.orderId;
              if (resLive.orderId) {
                try {
                  await (repo as any).setTradeInstructionLiveInfo(
                    instructionId,
                    {
                      orderId: resLive.orderId,
                      status: resLive.dryRun
                        ? "dry_run"
                        : resLive.posted
                          ? "open"
                          : "failed",
                      updatedAt: new Date(),
                    },
                  );
                } catch {}
              } else {
                try {
                  await (repo as any).setTradeInstructionLiveInfo(
                    instructionId,
                    {
                      status: "failed",
                      error: resLive.error ?? "live_sell_not_posted",
                      updatedAt: new Date(),
                    },
                  );
                } catch {}
              }
            } catch (e) {
              if (log)
                log("Monitor risk_trim live submit failed", {
                  marketId: pos.marketId,
                  optionId: pos.optionId,
                  error: (e as Error).message,
                });
              try {
                await (repo as any).setTradeInstructionLiveInfo(
                  instructionId,
                  {
                    status: "failed",
                    error: (e as Error).message,
                    updatedAt: new Date(),
                  },
                );
              } catch {}
              // On hard failure, do not simulate a fill; move to next position.
              continue;
            }
          }

          // For paper mode (and for live when we successfully built/submitted an order or dry-run),
          // update the local portfolio snapshot so downstream gating uses trimmed exposure.
          let notionalForFill = 0;
          if (!isLiveAgent) {
            notionalForFill = notional;
          } else if (
            resLive &&
            (resLive.dryRun || (resLive.posted && resLive.orderId))
          ) {
            notionalForFill = resLive.notional;
          }

          if (notionalForFill > 0) {
            await (portfolio as any).executeTrade({
              tradeInstructionId: instructionId,
              marketId: pos.marketId,
              optionId: pos.optionId,
              direction: "sell",
              price: exitPrice,
              notional: notionalForFill,
              metadata: { feeBps: effectiveFeeBps, feeSource },
            });
          }

          await (repo as any).clearMarketCooldowns(agentId, pos.marketId);
          if (log) {
            if (!isLiveAgent) {
              log("Monitor executed risk_trim sell", {
                marketId: pos.marketId,
                optionId: pos.optionId,
                notional: notionalForFill,
                price: exitPrice,
                liveSubmitted: false,
              });
            } else if (submitted) {
              log("Monitor executed risk_trim sell", {
                marketId: pos.marketId,
                optionId: pos.optionId,
                notional: notionalForFill,
                price: exitPrice,
                liveSubmitted: true,
              });
            } else {
              log("Monitor risk_trim live submit failed", {
                marketId: pos.marketId,
                optionId: pos.optionId,
                error: resLive?.error ?? "live_sell_not_posted",
              });
            }
          }
          // Skip LLM for this position this tick; move to next position after trimming.
          continue;
        }
      }
    }

    const prof: keyof RuntimeConfig["researchProfiles"] = (
      runtime.researchProfiles as any
    ).position
      ? ("position" as any)
      : ("deep" as any);

    // In risk-only mode, skip LLM-based monitor decisions after running exits
    // and risk_trim overlay. This is used by the main agent loop to enforce
    // per-market exposure caps without incurring extra LLM calls.
    if (effectiveMode === "riskOnly") {
      continue;
    }

    // LLM decision for position
    const entryRationaleSnippet = ((): string => {
      const r = lastEntry?.reason ?? "";
      return r.replace(/\s+/g, " ").trim();
    })();
    const theoreticalMaxGain =
      pos.quantity * Math.max(0, 1 - pos.averagePrice);
    const markGain =
      typeof bestBid === "number"
        ? pos.quantity * (bestBid - pos.averagePrice)
        : 0;
    const remainingBestCase = Math.max(
      0,
      theoreticalMaxGain - Math.max(0, markGain),
    );
    const liquidityBidTop = sumTopNotional(bids, levels);
    const liquidityAskTop = sumTopNotional(asks, levels);
    const { system, user } = buildMonitorPrompt({
      runtime,
      marketId: pos.marketId,
      marketTitle: titleMap.get(pos.marketId) ?? pos.marketId,
      outcomeId: pos.optionId,
      outcomeName: nameMap.get(`${pos.marketId}:${pos.optionId}`) ?? pos.optionId,
      position: {
        quantity: pos.quantity,
        averagePrice: pos.averagePrice,
        openedAt: pos.openedAt,
      },
      latest: { bestBid, bestAsk, mid },
      liquidity: {
        bidTop: liquidityBidTop,
        askTop: liquidityAskTop,
        levels,
      },
      costs: {
        cost: pos.quantity * pos.averagePrice,
        theoreticalMaxGain,
        remainingBestCase,
      },
      entryRationale: entryRationaleSnippet,
    });
    const maxRes = Math.max(
      1,
      Math.min(
        15,
        Number(
          (runtime as any)?.research?.webSearch?.monitorMaxResults ??
            (runtime as any)?.research?.webSearch?.quickMaxResults ??
            6,
        ),
      ),
    );
    const profileCfg =
      (runtime.researchProfiles as any)?.[prof]?.openrouter ?? {};
    const pluginMaxOut = Number(profileCfg?.maxTokens ?? 1024);
    const plugin = {
      id: "web",
      engine: "exa",
      max_results: maxRes,
      max_output_tokens: pluginMaxOut,
      search_prompt: `Do at most ${maxRes} search for only the most latest, relevant and accurate results.`,
    } as const;
    const resp1 = await openrouter.complete({
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      profile: prof,
      plugins: [plugin],
    });
    let parsed = safeParseJson(resp1.content);
    if (
      !parsed ||
      typeof parsed.action !== "string" ||
      typeof parsed.confidence !== "number"
    ) {
      // one repair attempt
      const resp2 = await openrouter.complete({
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        profile: prof,
        plugins: [plugin],
      });
      parsed = safeParseJson(resp2.content);
    }

    const action = String(parsed.action ?? "hold") as
      | "hold"
      | "close"
      | "buy_more"
      | "reduce";
    const confidence = Number(parsed.confidence ?? 0);
    // Compact, single-line rationale snippet for activity summaries
    const rationaleRaw =
      typeof parsed.rationale === "string" ? parsed.rationale : "";
    const rationaleSnippet = rationaleRaw
      .replace(/\s+/g, " ")
      .trim();
    const tpPct = typeof parsed.tpPct === "number" ? parsed.tpPct : null;
    const slPct = typeof parsed.slPct === "number" ? parsed.slPct : null;
    const adjustNotional =
      typeof parsed.adjustNotional === "number"
        ? Math.max(0, parsed.adjustNotional)
        : null;
    const spread = computeSpreadPct(bestBid, bestAsk);
    const hasDepth = bids.length > 0 || asks.length > 0;

    // Gate common checks
    if (
      spread !== undefined &&
      runtime.tradeEvaluation.gating &&
      spread > runtime.tradeEvaluation.gating.maxSpreadPct
    ) {
      if (log)
        log("Monitor gate: spread too high", {
          marketId: pos.marketId,
          optionId: pos.optionId,
          spread,
        });
      await (repo as any).recordPlanDecision({
        evaluationId: 0,
        agentId,
        marketId: pos.marketId,
        outcomeId: pos.optionId,
        status: "rejected",
        reason: `monitor[action=${action}, conf=${confidence.toFixed(2)}]; gate: spread>${runtime.tradeEvaluation.gating.maxSpreadPct}`,
        createdAt: new Date(),
        debug: {
          prompt: { system, user },
          output: parsed,
          prices: { bestBid, bestAsk, mid },
          liquidity: {
            bidTop: sumTopNotional(bids, levels),
            askTop: sumTopNotional(asks, levels),
          },
        },
      });
      continue;
    }

    // Execute actions (respect min holding unless confidence very high)
    if (action === "hold") {
      await (repo as any).recordPlanDecision({
        evaluationId: 0,
        agentId,
        marketId: pos.marketId,
        outcomeId: pos.optionId,
        status: "rejected",
        reason: `monitor[action=hold, conf=${confidence.toFixed(2)}]`,
        createdAt: new Date(),
        debug: {
          prompt: { system, user },
          output: parsed,
          prices: { bestBid, bestAsk, mid },
        },
      });
      continue;
    }

    // Reset consecutive counter if action is not a close/reduce
    if (action !== "close" && action !== "reduce") {
      monitorCloseCounts.delete(closeKey(agentId, pos.marketId, pos.optionId));
    }

    if (action === "close" || action === "reduce") {
      if (!allowEarlyExit) {
        await (repo as any).recordPlanDecision({
          evaluationId: 0,
          agentId,
          marketId: pos.marketId,
          outcomeId: pos.optionId,
          status: "rejected",
          reason: `monitor: cooldown active (strict) (${(minHoldMs / 1000) | 0}s)`,
          createdAt: new Date(),
        });
        continue;
      }
      // Block LLM-driven close/reduce within resolution guard window
      try {
        if (await isInResolutionGuardWindow(pos.marketId)) {
          await (repo as any).recordPlanDecision({
            evaluationId: 0,
            agentId,
            marketId: pos.marketId,
            outcomeId: pos.optionId,
            status: 'rejected',
            reason: `monitor[action=${action}, conf=${confidence.toFixed(2)}]; gate: resolution_guard (${guardMins}m)`,
            createdAt: new Date(),
          });
          continue;
        }
      } catch {}
      const bidTop = sumTopNotional(bids, levels);
      if (hasDepth && bidTop + 1e-9 < minExitNotional) {
        if (log)
          log("Monitor: insufficient bid depth to exit", {
            marketId: pos.marketId,
            optionId: pos.optionId,
            bidTop,
            minExitNotional,
          });
        await (repo as any).recordPlanDecision({
          evaluationId: 0,
          agentId,
          marketId: pos.marketId,
          outcomeId: pos.optionId,
          status: "rejected",
          reason: `monitor[action=${action}, conf=${confidence.toFixed(2)}]; gate: bidTop<minExitNotional`,
          createdAt: new Date(),
        });
        continue;
      }
      // Friction guard: do not exit into a small loss within half-spread + fees + buffer
      const bb = typeof bestBid === "number" ? bestBid : undefined;
      const ba = typeof bestAsk === "number" ? bestAsk : undefined;
      const halfSpreadAbs =
        typeof bb === "number" && typeof ba === "number"
          ? Math.max(0, (ba - bb) / 2)
          : 0;
      const feeAbs =
        Math.max(0, (runtime as any)?.fees?.trading?.takerBps ?? 0) / 10000;
      const monitorBufferBps = runtime.agent?.monitor?.exitFrictionBps;
      const fallbackBufferBps = getMinEdgeBpsNet(runtime) ?? 300;
      const bufferAbs =
        Math.max(0, typeof monitorBufferBps === "number" ? monitorBufferBps : fallbackBufferBps) /
        10000;
      const frictionThresh = halfSpreadAbs + feeAbs + bufferAbs;
      const exitPrice =
        typeof bestBid === "number"
          ? bestBid
          : typeof mid === "number"
            ? mid
            : pos.averagePrice;
      const fullNotional = exitPrice * pos.quantity;
      const targetNotional =
        action === "close"
          ? fullNotional
          : Math.min(fullNotional, adjustNotional ?? fullNotional * 0.5);
      if (targetNotional <= 0) continue;
      const lossAbs = Math.max(0, pos.averagePrice - exitPrice);
      if (exitPrice <= pos.averagePrice && lossAbs + 1e-12 < frictionThresh) {
        // Within microstructure friction; reject this exit
        await (repo as any).recordPlanDecision({
          evaluationId: 0,
          agentId,
          marketId: pos.marketId,
          outcomeId: pos.optionId,
          status: "rejected",
          reason: `monitor[action=${action}, conf=${confidence.toFixed(2)}]; gate: within_friction loss=${lossAbs.toFixed(3)} < thresh=${frictionThresh.toFixed(3)} (half=${halfSpreadAbs.toFixed(3)}, fee=${feeAbs.toFixed(3)}, buf=${bufferAbs.toFixed(3)})`,
          createdAt: new Date(),
          debug: {
            prices: { bestBid: bb, bestAsk: ba, avg: pos.averagePrice },
          },
        });
        continue;
      }

      // Require consecutive close signals before execution
      const requiredSignals = Math.max(
        1,
        runtime.agent?.monitor?.consecutiveCloseSignals ?? 2,
      );
      if (requiredSignals > 1) {
        const k = closeKey(agentId, pos.marketId, pos.optionId);
        const prev = monitorCloseCounts.get(k) ?? 0;
        const next = prev + 1;
        if (next < requiredSignals) {
          monitorCloseCounts.set(k, next);
          await (repo as any).recordPlanDecision({
            evaluationId: 0,
            agentId,
            marketId: pos.marketId,
            outcomeId: pos.optionId,
            status: "rejected",
            reason: `monitor: close signal observed (${next}/${requiredSignals}); awaiting confirmation`,
            createdAt: new Date(),
          });
          continue;
        }
        monitorCloseCounts.delete(k);
      }
      // Record accepted decision only when we are going to execute
      // Include confidence and compact rationale for clearer Activity summaries
      await (repo as any).recordPlanDecision({
        evaluationId: 0,
        agentId,
        marketId: pos.marketId,
        outcomeId: pos.optionId,
        status: "accepted",
        reason: rationaleSnippet
          ? `monitor[action=${action}, conf=${confidence.toFixed(2)}]; ${rationaleSnippet}`
          : `monitor[action=${action}, conf=${confidence.toFixed(2)}]`,
        createdAt: new Date(),
        citations: Array.isArray((resp1 as any)?.citations)
          ? ((resp1 as any).citations as string[])
          : undefined,
      });

      const instructionId = await (repo as any).recordTradeInstruction({
        evaluationId: 0,
        agentId,
        marketId: pos.marketId,
        optionId: pos.optionId,
        direction: "sell",
        notional: targetNotional,
        expectedPrice: exitPrice,
        reason:
          `monitor ${action} @~${exitPrice.toFixed(3)} | conf ${confidence.toFixed(2)}` +
          (rationaleSnippet ? `; ${rationaleSnippet}` : "") +
          (tpPct ? ` | TP ${tpPct}` : "") +
          (slPct ? ` | SL ${slPct}` : "") +
          ` | spreadPct=${spread !== undefined ? spread.toFixed(3) : "n/a"} halfAbs=${halfSpreadAbs.toFixed(3)} avg=${pos.averagePrice.toFixed(3)}`,
        createdAt: new Date(),
      });
      // Determine fee from live CLOB for this token when available
      let feeBps: number | undefined;
      try {
        const tokenId =
          typeof pos.optionId === "string" && /^\d+$/.test(pos.optionId)
            ? pos.optionId
            : undefined;
        feeBps = tokenId ? await polymarket.getFeeRateBps(tokenId) : undefined;
      } catch {}
      const feeSource =
        typeof feeBps === "number"
          ? "clob_fee_rate"
          : ((runtime as any)?.fees?.source ?? "config");
      const effectiveFeeBps =
        typeof feeBps === "number"
          ? feeBps
          : ((runtime as any)?.fees?.trading?.takerBps ?? 0);
      const hasLiveClient = !!(liveTrading && (liveTrading as any).client);
      const tokenIdStr = String(pos.optionId);
      const isNumericToken = /^\d+$/.test(tokenIdStr);
      const sharesToSell = exitPrice > 0 ? Math.min(pos.quantity, targetNotional / exitPrice) : 0;

      let resLive: LiveSellResult | undefined;
      let submitted = false;
      if (
        isLiveAgent &&
        hasLiveClient &&
        isNumericToken &&
        liveTrading &&
        agent &&
        sharesToSell >= minQty
      ) {
        try {
          resLive = await submitLiveSellWithApprovals({
            agentId,
            agent,
            runtime,
            polymarket,
            liveTrading: liveTrading as any,
            marketId: pos.marketId,
            optionId: pos.optionId,
            maxShares: sharesToSell,
            minQty,
            price: exitPrice,
            log,
          });
          submitted = resLive.posted && !!resLive.orderId;
          if (resLive.orderId) {
            try {
              await (repo as any).setTradeInstructionLiveInfo(instructionId, {
                orderId: resLive.orderId,
                status: resLive.dryRun ? "dry_run" : submitted ? "open" : "failed",
                updatedAt: new Date(),
              });
            } catch {}
          } else {
            try {
              await (repo as any).setTradeInstructionLiveInfo(instructionId, {
                status: "failed",
                error: resLive.error ?? "live_sell_not_posted",
                updatedAt: new Date(),
              });
            } catch {}
          }
        } catch (e) {
          if (log)
            log("Monitor LLM exit live submit failed", {
              marketId: pos.marketId,
              optionId: pos.optionId,
              error: (e as Error).message,
            });
          try {
            await (repo as any).setTradeInstructionLiveInfo(instructionId, {
              status: "failed",
              error: (e as Error).message,
              updatedAt: new Date(),
            });
          } catch {}
        }
      }

      let notionalForFill = targetNotional;
      if (isLiveAgent) {
        if (resLive && (resLive.dryRun || submitted)) {
          notionalForFill = resLive.notional;
        } else {
          notionalForFill = 0;
        }
      }

      if (notionalForFill > 0) {
        await (portfolio as any).executeTrade({
          tradeInstructionId: instructionId,
          marketId: pos.marketId,
          optionId: pos.optionId,
          direction: "sell",
          price: exitPrice,
          notional: notionalForFill,
          metadata: { feeBps: effectiveFeeBps, feeSource },
        });
      }

      // Clear cooldowns to allow re-entry if needed
      await (repo as any).clearMarketCooldowns(agentId, pos.marketId);
      if (log) {
        if (!isLiveAgent) {
          log("Monitor executed sell", {
            marketId: pos.marketId,
            optionId: pos.optionId,
            notional: targetNotional,
            price: exitPrice,
          });
        } else if (submitted) {
          log("Monitor executed sell", {
            marketId: pos.marketId,
            optionId: pos.optionId,
            notional: resLive?.notional ?? targetNotional,
            price: exitPrice,
            liveSubmitted: true,
          });
        } else if (resLive) {
          log("Monitor LLM exit live submit failed", {
            marketId: pos.marketId,
            optionId: pos.optionId,
            error: resLive.error ?? "live_sell_not_posted",
          });
        }
      }
      continue;
    }

    if (action === "buy_more") {
      if (buysExecutedThisTick >= maxBuyConcurrency) {
        if (log)
          log("Monitor: buy concurrency cap reached", {
            cap: maxBuyConcurrency,
          });
        continue;
      }
      const askTop = sumTopNotional(asks, levels);
      const minEntryNotional = Math.max(
        runtime.execution.sizing?.minNotional ?? 0,
        runtime.tradeEvaluation.gating?.minTopBookNotional ?? 0,
      );
      if (hasDepth && askTop + 1e-9 < minEntryNotional) {
        if (log)
          log("Monitor: insufficient ask depth to buy_more", {
            marketId: pos.marketId,
            optionId: pos.optionId,
            askTop,
            minEntryNotional,
          });
        await (repo as any).recordPlanDecision({
          evaluationId: 0,
          agentId,
          marketId: pos.marketId,
          outcomeId: pos.optionId,
          status: "rejected",
          reason: `monitor[action=buy_more, conf=${confidence.toFixed(2)}]; gate: askTop<minEntryNotional`,
          createdAt: new Date(),
        });
        continue;
      }
      const expectedPrice =
        typeof bestAsk === "number"
          ? bestAsk
          : typeof mid === "number"
            ? mid
            : 0.5;
      const available = portfolio.availableBalance;
      if (adjustNotional == null) {
        await (repo as any).recordPlanDecision({
          evaluationId: 0,
          agentId,
          marketId: pos.marketId,
          outcomeId: pos.optionId,
          status: "rejected",
          reason: "monitor[action=buy_more]: missing adjustNotional",
          createdAt: new Date(),
        });
        continue;
      }
      let notional = Math.max(0, adjustNotional);
      // Risk caps
      const snapshot = portfolio.snapshot();
      const positionsCost = snapshot.positions.reduce(
        (acc, p) => acc + p.averagePrice * p.quantity,
        0,
      );
      const equity =
        snapshot.cashBalance + snapshot.reservedBalance + positionsCost;
      if (runtime.risk?.perTradeMax !== undefined)
        notional = Math.min(notional, runtime.risk.perTradeMax);
      if (runtime.risk?.perRunMaxPct !== undefined) {
        const capAbs = Math.max(0, runtime.risk.perRunMaxPct * equity);
        const headroom = Math.max(0, capAbs - positionsCost);
        if (headroom <= 0) {
          await (repo as any).recordPlanDecision({
            evaluationId: 0,
            agentId,
            marketId: pos.marketId,
            outcomeId: pos.optionId,
            status: "rejected",
            reason: "monitor: per-run exposure cap: no headroom",
            createdAt: new Date(),
          });
          continue;
        }
        notional = Math.min(notional, headroom);
        if (notional <= 0) {
          await (repo as any).recordPlanDecision({
            evaluationId: 0,
            agentId,
            marketId: pos.marketId,
            outcomeId: pos.optionId,
            status: "rejected",
            reason: "monitor: per-run exposure cap: notional clamped to zero",
            createdAt: new Date(),
          });
          continue;
        }
      }
      if (runtime.risk?.perMarketMaxPct !== undefined) {
        const outcomeExposure = snapshot.positions
          .filter(
            (p) =>
              p.marketId === pos.marketId &&
              p.optionId === pos.optionId &&
              p.status === "open",
          )
          .reduce((acc, p) => acc + p.averagePrice * p.quantity, 0);
        if (outcomeExposure + notional > runtime.risk.perMarketMaxPct * equity) {
          await (repo as any).recordPlanDecision({
            evaluationId: 0,
            agentId,
            marketId: pos.marketId,
            outcomeId: pos.optionId,
            status: "rejected",
            reason: "monitor: per-outcome exposure cap",
            createdAt: new Date(),
          });
          continue;
        }
      }
      notional = Math.min(notional, askTop, available);
      if (notional <= 0) continue;
      // Record accepted before executing
      await (repo as any).recordPlanDecision({
        evaluationId: 0,
        agentId,
        marketId: pos.marketId,
        outcomeId: pos.optionId,
        status: "accepted",
        reason: `monitor[action=buy_more, conf=${confidence.toFixed(2)}]`,
        createdAt: new Date(),
        citations: Array.isArray((resp1 as any)?.citations)
          ? ((resp1 as any).citations as string[])
          : undefined,
      });
      const instructionId = await (repo as any).recordTradeInstruction({
        evaluationId: 0,
        agentId,
        marketId: pos.marketId,
        optionId: pos.optionId,
        direction: "buy",
        notional,
        expectedPrice,
        reason: `monitor buy_more @~${expectedPrice.toFixed(3)} notional=${notional.toFixed(2)}`,
        createdAt: new Date(),
      });
      // Determine fee from live CLOB for this token when available
      let buyFeeBps: number | undefined;
      try {
        buyFeeBps = await polymarket.getFeeRateBps(pos.optionId);
      } catch {}
      const buyFeeSource =
        typeof buyFeeBps === "number"
          ? "clob_fee_rate"
          : ((runtime as any)?.fees?.source ?? "config");
      const effectiveBuyFeeBps =
        typeof buyFeeBps === "number"
          ? buyFeeBps
          : ((runtime as any)?.fees?.trading?.takerBps ?? 0);
      await (portfolio as any).executeTrade({
        tradeInstructionId: instructionId,
        marketId: pos.marketId,
        optionId: pos.optionId,
        direction: "buy",
        price: expectedPrice,
        notional,
        metadata: { feeBps: effectiveBuyFeeBps, feeSource: buyFeeSource },
      });
      await (repo as any).clearMarketCooldowns(agentId, pos.marketId);
      buysExecutedThisTick += 1;
      if (log)
        log("Monitor executed buy_more", {
          marketId: pos.marketId,
          optionId: pos.optionId,
          notional,
          price: expectedPrice,
        });
    }
  }
}
