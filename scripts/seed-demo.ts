#!/usr/bin/env tsx
/**
 * Seed local SQLite database with realistic multi-agent demo data so the
 * dashboard can be explored immediately without API keys or live LLM calls.
 *
 * Usage:
 *   npm run demo:seed
 *   npm run demo:seed -- --db data/inga.sqlite
 */
import { resolve } from "node:path";
import { openDatabase, initializeSchema, closeDatabase } from "../src/agent/db";
import { AgentRepository } from "../src/agent/repository";

function parseDbPath(argv: string[]): string {
  for (let i = 2; i < argv.length; i++) {
    if ((argv[i] === "--db" || argv[i] === "-d") && argv[i + 1]) {
      return resolve(process.cwd(), argv[i + 1]);
    }
  }
  return resolve(process.cwd(), process.env.PAPER_DB_FILE || "data/inga.sqlite");
}

type DemoMarket = {
  id: string;
  slug: string;
  title: string;
  yesId: string;
  noId: string;
  yesPrice: number;
  noPrice: number;
  summary: string;
  citations: string[];
};

const MARKETS: DemoMarket[] = [
  {
    id: "0x9a10fed001",
    slug: "fed-rate-cut-next-fomc-meeting",
    title: "Will the Federal Reserve cut interest rates at the next FOMC meeting?",
    yesId: "token_fed_cut_yes",
    noId: "token_fed_cut_no",
    yesPrice: 0.64,
    noPrice: 0.36,
    summary:
      "Core PCE inflation cooled to 2.6% YoY while nonfarm payroll revisions softened; CME FedWatch implies 68% cut odds vs 64c on Polymarket.",
    citations: [
      "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm",
      "https://www.bls.gov/cpi/",
    ],
  },
  {
    id: "0x9a10btc002",
    slug: "bitcoin-above-100k-before-quarter-end",
    title: "Will Bitcoin trade above $100,000 before quarter end?",
    yesId: "token_btc_100k_yes",
    noId: "token_btc_100k_no",
    yesPrice: 0.58,
    noPrice: 0.42,
    summary:
      "Spot ETF net inflows averaged $420M/day over the past 10 sessions with declining exchange reserves and tight perpetual funding.",
    citations: [
      "https://www.sec.gov/edgar/searchedgar/companysearch",
      "https://www.cmegroup.com/markets/cryptocurrencies/bitcoin/bitcoin.html",
    ],
  },
  {
    id: "0x9a10eth003",
    slug: "us-spot-eth-etf-staking-approval",
    title: "Will the SEC approve staking for US spot Ethereum ETFs this quarter?",
    yesId: "token_eth_stake_yes",
    noId: "token_eth_stake_no",
    yesPrice: 0.34,
    noPrice: 0.66,
    summary:
      "Issuers filed amended 19b-4 language addressing slashing and liquidity buffers, but SEC procedural deadlines allow another 45-day extension.",
    citations: ["https://www.sec.gov/rules/sro.shtml"],
  },
  {
    id: "0x9a10nvda004",
    slug: "nvidia-beats-quarterly-datacenter-revenue-consensus",
    title: "Will NVIDIA beat Wall Street consensus for Data Center revenue in its next earnings report?",
    yesId: "token_nvda_beat_yes",
    noId: "token_nvda_beat_no",
    yesPrice: 0.74,
    noPrice: 0.26,
    summary:
      "Hyperscaler CapEx guidance rose +18% QoQ and CoWoS packaging allocation at TSMC remains fully booked through next quarter.",
    citations: ["https://investor.nvidia.com/financial-info/quarterly-results"],
  },
  {
    id: "0x9a10ai005",
    slug: "frontier-llm-passes-85pct-swe-bench-verified",
    title: "Will any publicly released model exceed 85% on SWE-bench Verified this quarter?",
    yesId: "token_swebench_yes",
    noId: "token_swebench_no",
    yesPrice: 0.49,
    noPrice: 0.51,
    summary:
      "Recent test-time compute scaling and tool-use harnesses pushed top leaderboard entries from 71% to 79% within six weeks.",
    citations: ["https://www.swebench.com/"],
  },
  {
    id: "0x9a10oil006",
    slug: "brent-crude-closes-above-85-this-month",
    title: "Will Brent Crude settle above $85/bbl before month end?",
    yesId: "token_brent_85_yes",
    noId: "token_brent_85_no",
    yesPrice: 0.28,
    noPrice: 0.72,
    summary:
      "OPEC+ voluntary unwind schedule and rising non-OPEC supply from Guyana/Brazil cap upside despite Red Sea transit diversions.",
    citations: ["https://www.eia.gov/outlooks/steo/"],
  },
];

type AgentDemoPlan = {
  agentId: string;
  initialCash: number;
  openPositions: Array<{
    marketIdx: number;
    side: "YES" | "NO";
    quantity: number;
    entryPrice: number;
    bestBid: number;
    bestAsk: number;
    tpPrice: number;
    slPrice: number;
    openedHoursAgo: number;
    rationale: string;
  }>;
  closedPosition: {
    marketIdx: number;
    side: "YES" | "NO";
    quantity: number;
    entryPrice: number;
    exitPrice: number;
    closedHoursAgo: number;
    exitReason: string;
  };
  skippedMarketIdx: number;
  curveDrift: number[]; // 19 relative checkpoints across 72h
};

const AGENT_PLANS: AgentDemoPlan[] = [
  {
    agentId: "agent_gpt",
    initialCash: 1000,
    openPositions: [
      {
        marketIdx: 0,
        side: "YES",
        quantity: 220,
        entryPrice: 0.58,
        bestBid: 0.64,
        bestAsk: 0.65,
        tpPrice: 0.76,
        slPrice: 0.48,
        openedHoursAgo: 46,
        rationale:
          "Macro disinflation trend intact; entering YES at 58c with 68% model probability (+1000 bps edge vs ask) and tight 1c book spread.",
      },
      {
        marketIdx: 3,
        side: "YES",
        quantity: 160,
        entryPrice: 0.69,
        bestBid: 0.74,
        bestAsk: 0.75,
        tpPrice: 0.88,
        slPrice: 0.58,
        openedHoursAgo: 28,
        rationale:
          "Cloud CapEx revisions from top-4 buyers confirm Blackwell shipment ramp; buying YES at 69c with depth-verified slippage < 40 bps.",
      },
    ],
    closedPosition: {
      marketIdx: 1,
      side: "YES",
      quantity: 180,
      entryPrice: 0.49,
      exitPrice: 0.61,
      closedHoursAgo: 14,
      exitReason:
        "TP hit: bestBid 0.6100 >= TP 0.6050 (+24.5% vs entry 0.4900); locking in +$21.60 realized P&L.",
    },
    skippedMarketIdx: 5,
    curveDrift: [
      0, 2, 5, 4, 9, 14, 12, 18, 22, 19, 25, 29, 31, 28, 34, 38, 40, 41, 42.8,
    ],
  },
  {
    agentId: "agent_claude",
    initialCash: 1000,
    openPositions: [
      {
        marketIdx: 4,
        side: "YES",
        quantity: 240,
        entryPrice: 0.43,
        bestBid: 0.49,
        bestAsk: 0.5,
        tpPrice: 0.62,
        slPrice: 0.34,
        openedHoursAgo: 52,
        rationale:
          "Multi-agent verification loops on SWE-bench Verified show steep gains; 43c underprices upcoming frontier model releases.",
      },
      {
        marketIdx: 5,
        side: "NO",
        quantity: 190,
        entryPrice: 0.68,
        bestBid: 0.72,
        bestAsk: 0.73,
        tpPrice: 0.85,
        slPrice: 0.57,
        openedHoursAgo: 20,
        rationale:
          "EIA inventory build and OPEC+ spare capacity create strong ceiling below $85/bbl; buying NO at 68c.",
      },
    ],
    closedPosition: {
      marketIdx: 0,
      side: "YES",
      quantity: 150,
      entryPrice: 0.55,
      exitPrice: 0.63,
      closedHoursAgo: 18,
      exitReason:
        "Monitor close: captured 8c repricing post-CPI print; rotating capital into higher-edge catalyst markets.",
    },
    skippedMarketIdx: 2,
    curveDrift: [
      0, 1, 3, 6, 8, 11, 10, 13, 17, 16, 20, 23, 25, 27, 29, 31, 32, 33, 34.0,
    ],
  },
  {
    agentId: "agent_ds",
    initialCash: 1000,
    openPositions: [
      {
        marketIdx: 1,
        side: "YES",
        quantity: 200,
        entryPrice: 0.54,
        bestBid: 0.58,
        bestAsk: 0.59,
        tpPrice: 0.72,
        slPrice: 0.44,
        openedHoursAgo: 40,
        rationale:
          "ETF absorption >4x daily mined issuance; asymmetric upside into quarter-end options expiry.",
      },
    ],
    closedPosition: {
      marketIdx: 3,
      side: "YES",
      quantity: 140,
      entryPrice: 0.66,
      exitPrice: 0.73,
      closedHoursAgo: 10,
      exitReason:
        "TP hit: bestBid 0.7300 >= TP 0.7250 (+10.6% vs entry 0.6600); closed full lot.",
    },
    skippedMarketIdx: 2,
    curveDrift: [
      0, -2, 1, 4, 3, 7, 9, 8, 11, 13, 12, 15, 14, 16, 17, 16, 17, 17.5, 17.8,
    ],
  },
  {
    agentId: "agent_qwen",
    initialCash: 1000,
    openPositions: [
      {
        marketIdx: 2,
        side: "NO",
        quantity: 180,
        entryPrice: 0.64,
        bestBid: 0.66,
        bestAsk: 0.67,
        tpPrice: 0.8,
        slPrice: 0.54,
        openedHoursAgo: 36,
        rationale:
          "SEC statutory review calendar makes final staking rule approval unlikely before quarter end; buying NO at 64c.",
      },
    ],
    closedPosition: {
      marketIdx: 4,
      side: "NO",
      quantity: 160,
      entryPrice: 0.56,
      exitPrice: 0.5,
      closedHoursAgo: 22,
      exitReason:
        "SL hit: bestBid 0.5000 <= SL 0.5040 (-10.7% vs entry 0.5600); cutting position per risk discipline.",
    },
    skippedMarketIdx: 1,
    curveDrift: [
      0, 1, -1, -4, -6, -9, -8, -11, -10, -7, -8, -6, -7, -6, -5, -6, -6, -6, -6.0,
    ],
  },
  {
    agentId: "agent_grok",
    initialCash: 1000,
    openPositions: [
      {
        marketIdx: 2,
        side: "YES",
        quantity: 250,
        entryPrice: 0.39,
        bestBid: 0.34,
        bestAsk: 0.35,
        tpPrice: 0.52,
        slPrice: 0.3,
        openedHoursAgo: 30,
        rationale:
          "Contrarian bet on accelerated SEC staking task-force memo; holding within stop-loss guard at 30c.",
      },
      {
        marketIdx: 1,
        side: "YES",
        quantity: 150,
        entryPrice: 0.56,
        bestBid: 0.58,
        bestAsk: 0.59,
        tpPrice: 0.72,
        slPrice: 0.46,
        openedHoursAgo: 16,
        rationale:
          "Momentum breakout above 94k with Spot CVD leading perp open interest; adding 150 shares YES.",
      },
    ],
    closedPosition: {
      marketIdx: 5,
      side: "YES",
      quantity: 200,
      entryPrice: 0.35,
      exitPrice: 0.28,
      closedHoursAgo: 12,
      exitReason:
        "SL hit: bestBid 0.2800 <= SL 0.2850 (-20.0% vs entry 0.3500); exited geopolitical oil spike trade.",
    },
    skippedMarketIdx: 0,
    curveDrift: [
      0, -3, -5, -2, -8, -12, -10, -15, -18, -14, -19, -22, -20, -25, -24, -22, -23, -23.5, -23.5,
    ],
  },
];

function main() {
  const dbPath = parseDbPath(process.argv);
  const db = openDatabase({ filePath: dbPath });
  initializeSchema(db);

  // Clear previous data for idempotent seeding
  db.exec(`
    DELETE FROM fills;
    DELETE FROM trade_instructions;
    DELETE FROM plan_decisions;
    DELETE FROM market_evaluations;
    DELETE FROM agent_runs;
    DELETE FROM positions;
    DELETE FROM position_marks;
    DELETE FROM closed_positions;
    DELETE FROM portfolio_state;
    DELETE FROM portfolio_history;
    DELETE FROM market_cooldowns;
    DELETE FROM token_resolution_map;
  `);

  const repo = new AgentRepository(db);
  const now = Date.now();
  const hourMs = 60 * 60 * 1000;

  // Seed token resolution map for all demo markets
  for (const m of MARKETS) {
    repo.upsertResolvedClobTokenId({
      marketId: m.id,
      outcomeIndex: 0,
      clobTokenId: m.yesId,
      source: "demo_seed",
      resolvedAt: new Date(now - 72 * hourMs),
    });
    repo.upsertResolvedClobTokenId({
      marketId: m.id,
      outcomeIndex: 1,
      clobTokenId: m.noId,
      source: "demo_seed",
      resolvedAt: new Date(now - 72 * hourMs),
    });
  }

  for (const plan of AGENT_PLANS) {
    const runStart = new Date(now - 68 * hourMs);
    const runId = repo.startRun(plan.agentId, runStart, { mode: "demo_seed" });

    let cash = plan.initialCash;
    let realizedPnl = 0;

    // 1. Seed closed round (entry + exit)
    {
      const c = plan.closedPosition;
      const m = MARKETS[c.marketIdx]!;
      const optionId = c.side === "YES" ? m.yesId : m.noId;
      const openTime = new Date(now - (c.closedHoursAgo + 18) * hourMs);
      const closeTime = new Date(now - c.closedHoursAgo * hourMs);

      const evalId = repo.recordMarketEvaluation({
        runId,
        agentId: plan.agentId,
        marketId: m.id,
        title: m.title,
        outcomes: [
          { id: m.yesId, name: "Yes", price: m.yesPrice },
          { id: m.noId, name: "No", price: m.noPrice },
        ],
        currentPrices: {
          [m.yesId]: m.yesPrice,
          [m.noId]: m.noPrice,
        },
        quickResearchSummary: m.summary,
        trade: true,
        evaluationRationale: `Selected ${c.side} on "${m.title}" with executable book depth and positive expected value.`,
        riskNotes: "Liquidity verified across top 3 book levels; spread within 2% gate.",
        timestamp: openTime,
        status: "accepted",
        debugMarketPayloadJson: [
          {
            id: m.id,
            slug: m.slug,
            url: `https://polymarket.com/market/${m.slug}`,
          },
        ],
        evaluationCitations: m.citations,
      });

      const entryNotional = Number((c.quantity * c.entryPrice).toFixed(2));
      const exitNotional = Number((c.quantity * c.exitPrice).toFixed(2));
      const roundPnl = Number(((c.exitPrice - c.entryPrice) * c.quantity).toFixed(2));

      repo.recordPlanDecision({
        evaluationId: evalId,
        agentId: plan.agentId,
        marketId: m.id,
        outcomeId: optionId,
        status: "accepted",
        reason: "Passed spread, depth, and per-market exposure gates",
        tradeRationale: `Initial entry in ${c.side} at ${(c.entryPrice * 100).toFixed(0)}c based on catalyst timeline.`,
        createdAt: openTime,
        citations: m.citations,
      });

      const buyId = repo.recordTradeInstruction({
        evaluationId: evalId,
        agentId: plan.agentId,
        marketId: m.id,
        optionId,
        direction: "buy",
        notional: entryNotional,
        allocationPct: Number((entryNotional / plan.initialCash).toFixed(3)),
        expectedPrice: c.entryPrice,
        takeProfitPrice: Number(Math.min(0.95, c.entryPrice * 1.24).toFixed(3)),
        stopPrice: Number(Math.max(0.05, c.entryPrice * 0.82).toFixed(3)),
        reason: `Enter ${c.side} @ ${(c.entryPrice * 100).toFixed(0)}c`,
        createdAt: openTime,
      });

      repo.recordFill({
        tradeInstructionId: buyId,
        agentId: plan.agentId,
        marketId: m.id,
        optionId,
        direction: "buy",
        quantity: c.quantity,
        fillPrice: c.entryPrice,
        notional: entryNotional,
        pnl: 0,
        createdAt: openTime,
      });

      const sellId = repo.recordTradeInstruction({
        evaluationId: evalId,
        agentId: plan.agentId,
        marketId: m.id,
        optionId,
        direction: "sell",
        notional: exitNotional,
        expectedPrice: c.exitPrice,
        reason: c.exitReason,
        createdAt: closeTime,
      });

      repo.recordFill({
        tradeInstructionId: sellId,
        agentId: plan.agentId,
        marketId: m.id,
        optionId,
        direction: "sell",
        quantity: c.quantity,
        fillPrice: c.exitPrice,
        notional: exitNotional,
        pnl: roundPnl,
        createdAt: closeTime,
      });

      repo.recordClosedPositions(plan.agentId, [
        {
          marketId: m.id,
          optionId,
          quantity: c.quantity,
          averagePrice: c.entryPrice,
          exitPrice: c.exitPrice,
          realizedPnl: roundPnl,
          feesPaid: 0,
          closedAt: closeTime.toISOString(),
        },
      ]);

      cash += roundPnl;
      realizedPnl += roundPnl;
    }

    // 2. Seed open positions + marks
    let openCost = 0;
    let openUnrealized = 0;

    for (const pos of plan.openPositions) {
      const m = MARKETS[pos.marketIdx]!;
      const optionId = pos.side === "YES" ? m.yesId : m.noId;
      const openTime = new Date(now - pos.openedHoursAgo * hourMs);
      const notional = Number((pos.quantity * pos.entryPrice).toFixed(2));

      const evalId = repo.recordMarketEvaluation({
        runId,
        agentId: plan.agentId,
        marketId: m.id,
        title: m.title,
        outcomes: [
          { id: m.yesId, name: "Yes", price: m.yesPrice },
          { id: m.noId, name: "No", price: m.noPrice },
        ],
        currentPrices: {
          [m.yesId]: m.yesPrice,
          [m.noId]: m.noPrice,
        },
        quickResearchSummary: m.summary,
        trade: true,
        evaluationRationale: pos.rationale,
        riskNotes: "Order book depth > 5x target size; no imminent resolution guard conflict.",
        timestamp: openTime,
        status: "accepted",
        debugMarketPayloadJson: [
          {
            id: m.id,
            slug: m.slug,
            url: `https://polymarket.com/market/${m.slug}`,
          },
        ],
        evaluationCitations: m.citations,
      });

      repo.recordPlanDecision({
        evaluationId: evalId,
        agentId: plan.agentId,
        marketId: m.id,
        outcomeId: optionId,
        status: "accepted",
        reason: "Accepted by planner: net edge > 250 bps and depth sufficient",
        tradeRationale: pos.rationale,
        createdAt: openTime,
        citations: m.citations,
      });

      const instrId = repo.recordTradeInstruction({
        evaluationId: evalId,
        agentId: plan.agentId,
        marketId: m.id,
        optionId,
        direction: "buy",
        notional,
        allocationPct: Number((notional / plan.initialCash).toFixed(3)),
        expectedPrice: pos.entryPrice,
        takeProfitPrice: pos.tpPrice,
        stopPrice: pos.slPrice,
        reason: pos.rationale,
        createdAt: openTime,
      });

      repo.recordFill({
        tradeInstructionId: instrId,
        agentId: plan.agentId,
        marketId: m.id,
        optionId,
        direction: "buy",
        quantity: pos.quantity,
        fillPrice: pos.entryPrice,
        notional,
        pnl: 0,
        createdAt: openTime,
      });

      repo.upsertPosition({
        agentId: plan.agentId,
        marketId: m.id,
        optionId,
        direction: "buy",
        quantity: pos.quantity,
        averagePrice: pos.entryPrice,
        status: "open",
        openedAt: openTime,
      });

      repo.setPositionMark({
        agentId: plan.agentId,
        marketId: m.id,
        optionId,
        bestBid: pos.bestBid,
        bestAsk: pos.bestAsk,
        mid: Number(((pos.bestBid + pos.bestAsk) / 2).toFixed(4)),
        markedAt: new Date(now - 5 * 60 * 1000),
      });

      openCost += notional;
      openUnrealized += (pos.bestBid - pos.entryPrice) * pos.quantity;
    }

    // 3. Seed one rejected/no-trade evaluation for realistic filter views
    {
      const m = MARKETS[plan.skippedMarketIdx]!;
      const skipTime = new Date(now - 6 * hourMs);
      const evalId = repo.recordMarketEvaluation({
        runId,
        agentId: plan.agentId,
        marketId: m.id,
        title: m.title,
        outcomes: [
          { id: m.yesId, name: "Yes", price: m.yesPrice },
          { id: m.noId, name: "No", price: m.noPrice },
        ],
        currentPrices: {
          [m.yesId]: m.yesPrice,
          [m.noId]: m.noPrice,
        },
        quickResearchSummary: m.summary,
        trade: false,
        evaluationRationale:
          "Current market midpoint already reflects consensus probability; net edge after spread is below 250 bps threshold.",
        riskNotes: "Pass — insufficient edge.",
        timestamp: skipTime,
        status: "rejected_policy",
        debugMarketPayloadJson: [
          {
            id: m.id,
            slug: m.slug,
            url: `https://polymarket.com/market/${m.slug}`,
          },
        ],
        evaluationCitations: m.citations,
      });

      repo.recordPlanDecision({
        evaluationId: evalId,
        agentId: plan.agentId,
        marketId: m.id,
        outcomeId: m.yesId,
        status: "rejected",
        reason: "Quick LLM evaluation returned trade=false (net edge < 250 bps)",
        createdAt: skipTime,
      });
    }

    // 4. Persist portfolio state
    const finalCash = Number((cash - openCost).toFixed(2));
    repo.getPortfolioState(plan.agentId, "USDC", plan.initialCash);
    repo.updatePortfolioState(plan.agentId, {
      cashBalance: finalCash,
      reservedBalance: 0,
      realizedPnl: Number(realizedPnl.toFixed(2)),
      baseCurrency: "USDC",
    });

    // 5. Seed 72-hour portfolio history (every 4 hours = 19 points)
    const steps = plan.curveDrift.length;
    const finalEquity = Number((finalCash + openCost + openUnrealized).toFixed(2));
    for (let i = 0; i < steps; i++) {
      const ts = now - (steps - 1 - i) * 4 * hourMs;
      const isLast = i === steps - 1;
      const isFirst = i === 0;
      const equity = isFirst
        ? plan.initialCash
        : isLast
          ? finalEquity
          : Number((plan.initialCash + plan.curveDrift[i]!).toFixed(2));
      const pnlDelta = Number((equity - plan.initialCash).toFixed(2));
      repo.recordPortfolioHistory({
        agentId: plan.agentId,
        ts,
        equity,
        realizedPnl: isLast ? Number(realizedPnl.toFixed(2)) : Number((pnlDelta * 0.4).toFixed(2)),
        unrealizedPnl: isLast ? Number(openUnrealized.toFixed(2)) : Number((pnlDelta * 0.6).toFixed(2)),
      });
    }

    repo.completeRun(runId, "completed", new Date(now - 2 * hourMs));
  }

  closeDatabase(db);
  console.log(`[demo:seed] Seeded 5 agents, ${MARKETS.length} markets, positions, activities, and 72h equity history into ${dbPath}`);
}

main();
