import { createHttpClient } from "../http/client";
import { createPolymarketClient } from "../clients/polymarket";
import { createClobClientForAgent, fetchUsdcBalance } from "../clients/polymarket_live";
import type { MarketSummary, PriceHistoryPoint } from "../clients/polymarket";
import { resolveClobTokenIdsForMarket } from "../clients/token-resolver";
import { createOpenRouterClient } from "../clients/openrouter";
import { loadAgentsConfig, loadRuntimeConfig } from "../config";
import { syncLivePositionsFromSnapshot } from "./livePositions";
import { PortfolioManagerLive } from "./portfolio_live";
import { getRepository as getAsyncRepository } from "../storage";
import { openDatabase, initializeSchema, closeDatabase } from "./db";
import { AgentRepository } from "./repository";
import { PortfolioManager } from "./portfolio";
import { selectMarketsForEvaluation } from "./pipeline/market";
import { getSharedDiscovery, buildSharedDiscovery, ensureSharedDiscovery } from './pipeline/discovery_shared';
import { prepareEventContext, type Cand } from './pipeline/event_prep';
import { evaluateMarket } from "./pipeline/decision";
import { planTrade } from "./pipeline/planner";
import { shouldSkipMarket } from "./cooldown";
import { formatLiveOrderError, manageExits, submitLiveOrderWithPreflight } from "./pipeline/exits";
import { runMonitorTick } from "./pipeline/monitor";

function summarizePriceHistory(history: PriceHistoryPoint[]): { first?: number; last?: number; min?: number; max?: number } {
  const pts = Array.isArray(history) ? history.filter((h) => h && Number.isFinite(h.p as number)) : [];
  if (pts.length === 0) return {};
  const first = Number(pts[0]!.p);
  const last = Number(pts[pts.length - 1]!.p);
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const h of pts) {
    const p = Number(h.p);
    if (!Number.isFinite(p)) continue;
    if (p < min) min = p;
    if (p > max) max = p;
  }
  return { first, last, min: Number.isFinite(min) ? min : undefined, max: Number.isFinite(max) ? max : undefined };
}

function pct(a?: number, b?: number): number | undefined {
  if (!Number.isFinite(a as number) || !Number.isFinite(b as number)) return undefined;
  if ((a as number) === 0) return undefined;
  return (((b as number) - (a as number)) / (a as number)) * 100;
}

export interface RunOnceOptions {
  baseDir?: string;
  agentId?: string; // defaults to the first enabled agent
  log?: (msg: string, data?: unknown) => void;
  sessionId?: string; // optional shared session id across agents
  inject?: Partial<{
    http: ReturnType<typeof createHttpClient>;
    polymarket: ReturnType<typeof createPolymarketClient>;
    openrouter: ReturnType<typeof createOpenRouterClient>;
  }>;
  dbFilePath?: string; // when provided, use on-disk SQLite
}

export async function runAgentOnce(options: RunOnceOptions = {}) {
  const baseDir = options.baseDir ?? process.cwd();
  const log =
    options.log ??
    ((m: string, d?: unknown) => {
      if (d !== undefined) {
        // eslint-disable-next-line no-console
        console.log(m, d);
      } else {
        // eslint-disable-next-line no-console
        console.log(m);
      }
    });

  const runtime = await loadRuntimeConfig(baseDir);
  const postDecisionCooldownMinutes = Math.max(
    0,
    Number((runtime as any)?.cooldowns?.postDecisionMinutes ?? 0),
  );
  const postDecisionCooldownMs = postDecisionCooldownMinutes * 60 * 1000;
  const schedulePostDecisionCooldown = () =>
    postDecisionCooldownMinutes > 0
      ? new Date(Date.now() + postDecisionCooldownMs)
      : undefined;
  const agentsConfig = await loadAgentsConfig(baseDir);
  const agent = agentsConfig.agents.find(
    (a) => a.enabled && (!options.agentId || a.id === options.agentId),
  );
  if (!agent) throw new Error("No enabled agent found");

  // Clients
  const http = options.inject?.http ?? createHttpClient(runtime.http as any);
  const clobOv = (runtime.http as any)?.hostOverrides?.['clob.polymarket.com'] ?? {};
  const enablePolyLogsAgent = Boolean((runtime as any)?.logging?.verbose?.providers?.polymarket ?? false);
  const polymarket = options.inject?.polymarket ?? createPolymarketClient({ httpClient: http, marketConfig: runtime.marketData, memoize: { orderBookTtlMs: (runtime.http as any)?.memoize?.clobOrderBookTtlMs, feeRateTtlMs: (runtime.http as any)?.memoize?.clobFeeRateTtlMs }, concurrency: { maxConcurrent: clobOv?.maxConcurrent }, excludeTags: (runtime as any)?.excludeTags ?? [], logger: enablePolyLogsAgent ? log : undefined });

  

  const modelApiKey = process.env.OPENROUTER_API_KEY;
  let hasModelKey = Boolean(modelApiKey);
  if (!hasModelKey)
    throw new Error("Missing OPENROUTER_API_KEY for LLM decisions");
  const openrouter =
    options.inject?.openrouter ??
    createOpenRouterClient({
      httpClient: http,
      apiKey: modelApiKey || "stub-key",
      defaultModel: agent.model,
      researchProfiles: runtime.researchProfiles,
    });
  if (options.inject?.openrouter) {
    hasModelKey = true;
  }

  // Persistence / portfolio
  // Repository selection: SQLite for paper; Postgres (async) for live
  const dbFilePath = options.dbFilePath ?? process.env.PAPER_DB_FILE;
  // When an explicit SQLite file is provided, force paper mode regardless of
  // the agent's configured paperTrading flag. This keeps local/test runs
  // deterministic and avoids requiring Postgres for test suites.
  const paperMode = Boolean(options.dbFilePath) || agent.paperTrading !== false;
  let repo: any;
  let db: any | undefined;
  if (paperMode) {
    db = openDatabase(dbFilePath ? { filePath: dbFilePath } : { inMemory: true });
    initializeSchema(db);
    repo = new AgentRepository(db);
  } else {
    const driver = String(process.env.DB_DRIVER || '').toLowerCase();
    if (driver !== 'postgres' && driver !== 'pg') {
      throw new Error('Live mode requires Postgres. Set DB_DRIVER=postgres and provide DATABASE_URL. SQLite is not supported in production.');
    }
    repo = await getAsyncRepository();
  }
  // Determine execution mode and optionally prepare live client
  const liveTrading = !paperMode ? createClobClientForAgent(agent) : undefined;
  if (!paperMode && !liveTrading) {
    const suffix = (agent.walletPrivateKeyEnv.match(/_(\w+)$/)?.[1]) || (agent.walletAddressEnv.match(/_(\w+)$/)?.[1]) || 'AGENT';
    const required = [
      agent.walletPrivateKeyEnv,
      agent.walletAddressEnv,
      `POLY_API_KEY_${suffix} or POLY_API_KEY`,
      `POLY_API_SECRET_${suffix} or POLY_API_SECRET`,
      `POLY_API_PASSPHRASE_${suffix} or POLY_API_PASSPHRASE`,
      'POLY_CHAIN_ID (default 137)',
      'POLY_CLOB_HOST (default https://clob.polymarket.com)'
    ];
    throw new Error(`Live trading requested but credentials are missing for agent ${agent.id}. Set: ${required.join(', ')}`);
  }
  // Seed live cash balance and open positions before constructing the live portfolio
  if (!paperMode && liveTrading) {
    try {
      const usdc = await fetchUsdcBalance(liveTrading.client);
      const current = await (repo as any).getPortfolioState(
        agent.id,
        runtime.portfolio.baseCurrency,
        runtime.portfolio.initialBalance,
      );
      await (repo as any).updatePortfolioState(agent.id, {
        cashBalance: usdc,
        reservedBalance: 0,
        realizedPnl: current.realizedPnl,
        baseCurrency: runtime.portfolio.baseCurrency,
      });
    } catch (e) {
      log("Live balance fetch failed; using last known state", {
        error: (e as Error).message,
      });
    }
  }

  let portfolio: any;
  if (paperMode) {
    portfolio = new PortfolioManager(repo, {
      agentId: agent.id,
      initialBalance: runtime.portfolio.initialBalance,
      baseCurrency: runtime.portfolio.baseCurrency,
    });
  } else {
    // Ensure DB open positions reflect live trades, then seed live portfolio
    await syncLivePositionsFromSnapshot({ agent: agent as any, runtime: runtime as any, repo, log });
    const state = await (repo as any).getPortfolioState(
      agent.id,
      runtime.portfolio.baseCurrency,
      runtime.portfolio.initialBalance,
    );
    const seedPositions = await (repo as any).listOpenPositions(agent.id);
    portfolio = new PortfolioManagerLive({
      agentId: agent.id,
      baseCurrency: runtime.portfolio.baseCurrency,
      initialCash: state.cashBalance,
      seedPositions,
    });
  }

  // Explicit cycle markers for logs/observability
  log("Agent cycle start", {
    agent: agent.id,
    mode: paperMode ? "paper" : "live",
    sessionId: options.sessionId,
  });

  // Pre-run monitor: always run numeric + LLM monitor on existing positions
  // before beginning discovery (quick/deep phases) so that exits and exposure
  // trims are applied first.
  try {
    await runMonitorTick({
      agentId: agent.id,
      runtime,
      repo,
      portfolio,
      polymarket,
      openrouter,
      log,
      agent,
      liveTrading,
    });
  } catch (e) {
    log("Embedded monitor tick failed", { error: (e as Error).message });
  }

  const preDiscoverySnapshot = portfolio.snapshot();
  const prePositionsCost = preDiscoverySnapshot.positions.reduce(
    (acc: number, p: any) => acc + (p.averagePrice ?? 0) * (p.quantity ?? 0),
    0,
  );
  const preEquity =
    preDiscoverySnapshot.cashBalance +
    preDiscoverySnapshot.reservedBalance +
    prePositionsCost;
  const dailyLossLimitPct = runtime.risk?.dailyLossLimitPct;
  const dailyLossLimitBreached =
    typeof dailyLossLimitPct === "number" &&
    dailyLossLimitPct > 0 &&
    preDiscoverySnapshot.realizedPnl <= -dailyLossLimitPct * preEquity;
  if (dailyLossLimitBreached) {
    log("Daily loss limit breached; skipping new evaluations", {
      agent: agent.id,
      realizedPnl: preDiscoverySnapshot.realizedPnl,
      equity: preEquity,
      limitPct: dailyLossLimitPct,
    });
  }

  // In-run helpers -------------------------------------------------------------
  // Track evaluation ids per market to avoid duplicate records within the same run
  const evalIdByMarketGlobal = new Map<string, number>();
  // Lightweight retry wrapper around evaluateMarket to improve robustness when
  // the model returns trade=true but omits actionable fields (outcomeId/trades),
  // or when parsing fails. Uses a short backoff across up to 3 attempts.
  const missingActionable = (res: any): boolean => {
    if (!res || !res.evaluation || res.evaluation.trade !== true) return false;
    const hasOutcome = typeof res.outcomeId === 'string' && res.outcomeId.length > 0;
    const hasLeg = Array.isArray(res.trades) && res.trades.some((t: any) => t && typeof t.outcomeId === 'string' && t.outcomeId.length > 0);
    return !hasOutcome && !hasLeg;
  };
  // `evaluateMarket` already performs a strict JSON "repair" attempt. Retrying
  // again on parse failures just burns latency and cost; only retry when the
  // model says trade=true but omitted actionable fields (outcomeId/legs).
  const shouldRetry = (res: any): boolean => missingActionable(res);
  async function evaluateWithRetries(
    client: ReturnType<typeof createOpenRouterClient>,
    input: Parameters<typeof evaluateMarket>[1],
    phaseLabel: 'quick' | 'deep'
  ) {
    const delays = [0, 500, 1000];
    let last: any = undefined;
    for (let i = 0; i < delays.length; i++) {
      if (delays[i] > 0) await new Promise((r) => setTimeout(r, delays[i]));
      const res = await evaluateMarket(client, input as any);
      last = res;
      if (!shouldRetry(res)) return res;
      log?.('Decision retry', { phase: phaseLabel, attempt: i + 1, reason: 'missing_actionable' });
    }
    return last;
  }

  async function buildPriceHistoryByOutcomeId(market: MarketSummary) {
    const outcomes = Array.isArray(market?.outcomes) ? market.outcomes : [];
    const entries = await Promise.all(
      outcomes.map(async (o) => {
        const tokenId = typeof (o as any).clobTokenId === "string" ? String((o as any).clobTokenId) : "";
        if (!/^\d+$/.test(tokenId)) return undefined;
        const [hist1m, hist6h] = await Promise.all([
          polymarket.getPriceHistory({ tokenId, interval: "1m", fidelityMinutes: 240 }),
          polymarket.getPriceHistory({ tokenId, interval: "6h", fidelityMinutes: 5 }),
        ]);
        const s1m = summarizePriceHistory(hist1m);
        const s6h = summarizePriceHistory(hist6h);
        const last = (s6h.last ?? s1m.last);
        const high1m = s1m.max;
        const low1m = s1m.min;
        const pctFromHigh1m =
          Number.isFinite(high1m as number) && Number.isFinite(last as number) && (high1m as number) > 0
            ? (((high1m as number) - (last as number)) / (high1m as number)) * 100
            : undefined;
        const return6hPct = pct(s6h.first, s6h.last);
        const range6hPct =
          Number.isFinite(s6h.min as number) && Number.isFinite(s6h.max as number) && (s6h.min as number) > 0
            ? (((s6h.max as number) - (s6h.min as number)) / (s6h.min as number)) * 100
            : undefined;
        return {
          outcomeId: o.id,
          summary: {
            tokenId,
            last: typeof last === "number" ? last : null,
            high1m: typeof high1m === "number" ? high1m : null,
            low1m: typeof low1m === "number" ? low1m : null,
            pctFromHigh1m: typeof pctFromHigh1m === "number" ? pctFromHigh1m : null,
            return6hPct: typeof return6hPct === "number" ? return6hPct : null,
            range6hPct: typeof range6hPct === "number" ? range6hPct : null,
            points1m: Array.isArray(hist1m) ? hist1m.length : 0,
            points6h: Array.isArray(hist6h) ? hist6h.length : 0,
          },
        };
      }),
    );
    return Object.fromEntries(entries.filter(Boolean).map((e: any) => [e.outcomeId, e.summary]));
  }

  const runId = await (repo as any).startRun(agent.id, new Date(), {
    mode: paperMode ? "paper" : "live",
  });
  log(`Agent run started`, {
    runId,
    agent: agent.id,
    sessionId: options.sessionId,
  });

  try {
    // Then, manage exits on existing positions to free capital
    await manageExits({
      agentId: agent.id,
      runtime,
      repo,
      portfolio,
      polymarket,
      agent,
      liveTrading,
      log,
    });

    // Shared discovery cache: single-source market fetch + expansion/prefilter per tick
    const sharedEnabled = Boolean((runtime as any)?.discovery?.shared ?? true);
    let markets: Awaited<ReturnType<typeof selectMarketsForEvaluation>>['markets'];
    let preferredSet = new Set<string>();
    let preparedByMarketId: Record<string, { snapshotText: string; includedQuick: Cand[]; eventMarkets: MarketSummary[]; prefilterInfo?: any } > = {} as any;
    let pagesUsed = 0;
    let counts: any = undefined;

    if (sharedEnabled) {
      const data = await ensureSharedDiscovery({ client: polymarket as any, runtime, repo: repo as any, log });
      markets = data.selectedMarkets;
      preferredSet = new Set<string>(data.preferredMarketIds ?? []);
      // map prepared to local shape
      preparedByMarketId = Object.fromEntries(
        Object.entries(data.preparedByMarketId).map(([k, v]) => [
          k,
          {
            snapshotText: v.snapshotText,
            includedQuick: v.includedQuick,
            eventMarkets: v.eventMarkets as any,
            prefilterInfo: (v as any).prefilterInfo,
          },
        ])
      );
      log(`Fetched markets (shared)`, { count: markets.length });
    } else {
      const res = await selectMarketsForEvaluation({
        client: polymarket,
        runtime,
        repo: repo as any,
        agentId: agent.id,
      });
      markets = res.markets;
      pagesUsed = res.pagesUsed;
      counts = res.counts;
      preferredSet = new Set<string>(res.preferredMarketIds ?? []);
      log(`Fetched markets`, { count: markets.length, pagesUsed, counts });
    }
    if (runtime.logging.verbose.markets) {
      const preview = markets.map((m) => ({
        id: m.id,
        title: m.question,
        outcomes: m.outcomes.map((o) => ({
          id: o.id,
          name: o.name,
          snap: o.price,
        })),
      }));
      log("Market fetch snapshot", { markets: preview });
    }

    // If the entire discovered batch gets eliminated by event pre-filter (0 survivors),
    // retry discovery to fetch fresh markets up to polling.marketRefillMaxTries.
    const refillMaxTries = Math.max(
      0,
      Number((runtime.polling as any)?.marketRefillMaxTries ?? 0),
    );
    if (!sharedEnabled && refillMaxTries > 0) {
      const ensurePrepared = async (ms: MarketSummary[]) => {
        for (const m of ms) {
          if (!m?.id || preparedByMarketId[m.id]) continue;
          const pe = await prepareEventContext({ market: m, polymarket, runtime, repo, log });
          if (!pe) continue;
          preparedByMarketId[m.id] = {
            snapshotText: pe.snapshotText,
            includedQuick: pe.includedQuick,
            eventMarkets: pe.eventMarkets as any,
            prefilterInfo: (pe as any).prefilterInfo,
          };
        }
      };
      const countSurvivors = () =>
        Object.values(preparedByMarketId).reduce(
          (acc, p) => acc + (p.includedQuick?.length ?? 0),
          0,
        );

      await ensurePrepared(markets as any);
      let survivors = countSurvivors();
      for (let attempt = 0; attempt < refillMaxTries && survivors === 0; attempt++) {
        log("Discovery refill", {
          agent: agent.id,
          attempt: attempt + 1,
          maxTries: refillMaxTries,
        });
        const r = await selectMarketsForEvaluation({
          client: polymarket,
          runtime,
          repo: repo as any,
          agentId: agent.id,
        });
        const existing = new Set(markets.map((m) => m.id));
        const added: MarketSummary[] = [];
        for (const m of r.markets) {
          if (!m?.id || existing.has(m.id)) continue;
          existing.add(m.id);
          markets.push(m);
          added.push(m);
        }
        for (const id of r.preferredMarketIds ?? []) preferredSet.add(id);
        await ensurePrepared(added);
        survivors = countSurvivors();
        log("Discovery refill result", {
          agent: agent.id,
          attempt: attempt + 1,
          added: added.length,
          survivors,
        });
        if (added.length === 0) break;
      }
    }

      const quickProfile = agent.research
      .quickProfile as keyof typeof runtime.researchProfiles;
      const deepProfile = agent.research
      .deepProfile as keyof typeof runtime.researchProfiles;

    const promptLogged = { quick: false, deep: false };
    const candidates: Array<{
      market: (typeof markets)[number];
      evalId: number;
      evaluation: any;
      quickSummary: string;
      decision: {
        marketId: string;
        outcomeId: string;
        subjectiveProb?: number;
        maxPayPrice?: number;
        edgeBps?: number;
        priceBasis?: "ask" | "mid" | "snapshot";
        spendPct?: number;
        tpPct?: number | null;
        slPct?: number | null;
      };
    }> = [];

    function dedupCandidatesInPlace() {
      // Key by marketId:outcomeId
      const pick = new Map<string, number>();
      const score = (c: typeof candidates[number]) => {
        const eb = typeof (c.decision as any).edgeBps === 'number' ? (c.decision as any).edgeBps : -1;
        const sp = typeof (c.decision as any).spendPct === 'number' ? 1 : 0;
        return eb * 10 + sp; // prefer higher edge; tie-break when spend present
      };
      const next: typeof candidates = [] as any;
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i]!;
        const key = `${c.market.id}:${c.decision.outcomeId}`;
        if (!pick.has(key)) {
          pick.set(key, next.length);
          next.push(c);
        } else {
          const idx = pick.get(key)!;
          if (score(c) > score(next[idx]!)) {
            next[idx] = c;
          }
        }
      }
      if (next.length !== candidates.length) {
        if (runtime.logging.verbose.markets) {
          log('Dedup candidates', { before: candidates.length, after: next.length });
        }
        candidates.splice(0, candidates.length, ...next);
      }
    }

    for (const market of markets) {
      const preferred = preferredSet.has(market.id);
      const skipKw = (((runtime as any)?.skipCooldownForKeywords ?? true) === true);
      const skipDecisionCooldown = preferred && skipKw;
      if (dailyLossLimitBreached) {
        const evaluationRecord = {
          runId,
          agentId: agent.id,
          marketId: market.id,
          title: market.question,
          outcomes: market.outcomes.map((o) => ({
            id: o.id,
            name: o.name,
            price: o.price,
          })),
          currentPrices: Object.fromEntries(
            market.outcomes.map((o) => [o.id, o.price]),
          ),
          quickResearchSummary: "",
          trade: false,
          evaluationRationale: "Daily loss limit breached",
          riskNotes: undefined,
          timestamp: new Date(),
          status: "rejected_risk_limit" as const,
        };
        await (repo as any).recordMarketEvaluation(evaluationRecord);
        continue;
      }
      if (
        await shouldSkipMarket(
          repo,
          agent.id,
          market.id,
          postDecisionCooldownMinutes,
          { skipDecisionCooldown },
        )
      ) {
        // Record a non-trade evaluation for observability (skipped by cooldown)
        const evaluationRecord = {
          runId,
          agentId: agent.id,
          marketId: market.id,
          title: market.question,
          outcomes: market.outcomes.map((o) => ({
            id: o.id,
            name: o.name,
            price: o.price,
          })),
          currentPrices: Object.fromEntries(
            market.outcomes.map((o) => [o.id, o.price]),
          ),
          quickResearchSummary: "",
          trade: false,
          evaluationRationale:
            postDecisionCooldownMinutes > 0
              ? `Skipped due to cooldown (${postDecisionCooldownMinutes}m)`
              : "Skipped due to cooldown",
          riskNotes: undefined,
          timestamp: new Date(),
          status: 'rejected_cooldown' as const,
        } as const;
        await (repo as any).recordMarketEvaluation(evaluationRecord);
        log("Skipping due to cooldown", { marketId: market.id });
        continue;
      }
      // Prepare event context: use shared-prepared when present else compute once
      let eventMarkets: typeof market[] = [market];
      let eventSnapshotText = '';
      let includedQuick: Cand[] = [];
      let prefilterInfo: any = undefined;

      const prepared = preparedByMarketId[market.id];
      if (prepared) {
        eventMarkets = prepared.eventMarkets as any;
        eventSnapshotText = prepared.snapshotText;
        includedQuick = prepared.includedQuick;
        prefilterInfo = (prepared as any).prefilterInfo;
      } else {
        const pe = await prepareEventContext({ market, polymarket, runtime, repo, log });
        if (!pe) continue;
        eventMarkets = pe.eventMarkets as any;
        eventSnapshotText = pe.snapshotText;
        includedQuick = pe.includedQuick;
      }

      if (runtime.logging.verbose.markets) {
        log("Event snapshot", { marketId: market.id, rows: eventSnapshotText.split("\n").slice(0, 10) });
      }

      const researchSummary = `Event snapshot:\n${eventSnapshotText}`;
      const deepSummary = `Event snapshot:\n${eventSnapshotText}`;

      if (includedQuick.length === 0) {
        // Build concise, informative reason using prefilterInfo if available
        let prefilterReason = `Event pre-filter: 0 survivors`;
        if (prefilterInfo && typeof prefilterInfo === 'object') {
          const cand = prefilterInfo.candidates;
          const cnt = prefilterInfo.counts || {};
          const thr = prefilterInfo.thresholds || {};
          const caps = prefilterInfo.caps || {};
          const fmtPct = (v?: number) => (typeof v === 'number' ? `${Math.round(v * 1000) / 10}%` : 'n/a');
          const fmtUsd = (v?: number) => (typeof v === 'number' ? `$${Math.round(v)}` : 'n/a');
          const boundsStr = (() => {
            const f = thr.bounds?.floor;
            const c = thr.bounds?.ceiling;
            if (typeof f === 'number' || typeof c === 'number') {
              const fS = typeof f === 'number' ? `${Math.round(f * 1000) / 10}%` : 'n/a';
              const cS = typeof c === 'number' ? `${Math.round(c * 1000) / 10}%` : 'n/a';
              return `[${fS}–${cS}]`;
            }
            return 'n/a';
          })();
          prefilterReason = `Event pre-filter: 0/${cand} survivors — depth<${fmtUsd(thr.minTopBookNotional ?? thr.minNotional)}:${cnt.depthFails ?? 0}, spread>${fmtPct(thr.maxSpreadPct)}:${cnt.spreadFails ?? 0}, bounds${boundsStr}:${cnt.boundsFails ?? 0}; caps ${caps.in ?? 'n/a'}→${caps.out ?? 'n/a'}; ttlRelief:${thr.ttlRelief ? 'on' : 'off'}; requireDepth:${thr.requireLiveDepthForPrefilter ? 'on' : 'off'}`;
        }
        const payloadRows: any[] = [
          { url: (market as any).url as string | undefined, slug: (market as any).slug as string | undefined },
        ];
        if (prefilterInfo) {
          payloadRows.push({ prefilter: prefilterInfo });
        }
        const evaluationRecord = {
          runId,
          agentId: agent.id,
          marketId: market.id,
          title: market.question,
          outcomes: market.outcomes.map((o) => ({ id: o.id, name: o.name, price: o.price })),
          currentPrices: Object.fromEntries(market.outcomes.map((o) => [o.id, o.price])),
          quickResearchSummary: prefilterReason,
          trade: false,
          evaluationRationale: prefilterReason,
          riskNotes: undefined,
          timestamp: new Date(),
          status: 'rejected_prefilter' as const,
          debugMarketPayloadJson: payloadRows
        } as const;
        // Respect persistence knob for prefiltered
        if (((runtime as any)?.evaluations?.persist?.prefiltered ?? true) !== false) {
          await (repo as any).recordMarketEvaluation(evaluationRecord);
        }
        if (runtime.logging.verbose.markets) {
          log("Pre-filter rejection", { marketId: market.id, survivors: 0 });
        }
        continue;
      }

      const strategy = (runtime as any)?.research?.quick?.evaluationStrategy ?? 'per_sibling';
      if (runtime.logging.verbose.markets) {
        const ttlSample = includedQuick
          .map((c) => c.ttlMinutes)
          .filter((v): v is number => typeof v === "number")
          .map((v) => Number((v / 60).toFixed(2)));
        log("Event candidates", {
          marketId: market.id,
          includedQuick: includedQuick.length,
          derivation: 'shared',
          ttlHoursSample: ttlSample.slice(0, 6),
        });
      }

      if (strategy === 'per_sibling') {
        const acceptedOutcomeIdsSoFar = new Set<string>();
        for (const cand of includedQuick) {
          const focusMarket = eventMarkets.find((m) => m.id === cand.marketId) || market;
          try {
            // Build per‑sibling quick summary without independent web search
            const researchSummaryLocal = `Event snapshot:\n${eventSnapshotText}`;
            // Quick-phase decision; include a brief portfolio context so the model can recognize add-ons
            const snapQuick = portfolio.snapshot();
      const marksQuick = await (repo as any).getPositionMarks(agent.id);
            const Bquick = snapQuick.cashBalance - snapQuick.reservedBalance;
            const minQtyQuick = Math.max(0, (runtime as any)?.ui?.minOpenQuantity ?? 0.01);
            const pMax = (runtime as any)?.risk?.perMarketMaxPct as number | undefined;
            const pRun = (runtime as any)?.risk?.perRunMaxPct as number | undefined;
            // Eq (prompt): cash + sum(bestBid * qty) using marks; fallback to avg when bid missing
            const eqQuick = ((): number => {
              const open = snapQuick.positions.filter((p: any) => p.status === 'open' && p.quantity >= minQtyQuick);
              let sumBid = 0;
              for (const p of open) {
                const m = marksQuick.get(`${p.marketId}:${p.optionId}`);
                const bid = typeof m?.bestBid === 'number' ? m!.bestBid! : p.averagePrice;
                sumBid += bid * p.quantity;
              }
              return snapQuick.cashBalance + sumBid;
            })();
            const positionsCostQuick = snapQuick.positions
              .filter((p: any) => p.status === 'open' && p.quantity >= minQtyQuick)
              .reduce((acc: number, p: any) => acc + p.averagePrice * p.quantity, 0);
            // Market exposure M at average price for this market
            const mktExposureQuick = snapQuick.positions
              .filter((p: any) => p.status === 'open' && p.quantity >= minQtyQuick && p.marketId === focusMarket.id)
              .reduce((acc: number, p: any) => acc + p.averagePrice * p.quantity, 0);
            const headroomQuick = typeof pMax === 'number' ? Math.max(0, pMax * eqQuick - mktExposureQuick) : undefined;
            const headroomRunQuick =
              typeof pRun === 'number'
                ? Math.max(0, pRun * eqQuick - positionsCostQuick)
                : undefined;

            // Pre-LLM gating to avoid wasted calls
            const minEntryNotional = Math.max(
              Number((runtime.execution as any)?.sizing?.minNotional ?? 0),
              Number(((runtime as any)?.risk?.perTradeMin) ?? 0),
              0,
            );
            const rotationEnabled = Boolean((runtime as any)?.execution?.rotationWhenNoBalance?.enabled ?? true);
            if ((Bquick <= 0 || Bquick < minEntryNotional) && !rotationEnabled) {
              const reason = Bquick <= 0
                ? 'No available balance; rotation disabled.'
                : `Available balance $${Bquick.toFixed(2)} < min entry $${minEntryNotional.toFixed(2)}; rotation disabled.`;
              const evaluationRecordLocal = {
                runId,
                agentId: agent.id,
                marketId: focusMarket.id,
                title: focusMarket.question,
                outcomes: focusMarket.outcomes.map((o) => ({ id: o.id, name: o.name, price: o.price })),
                currentPrices: Object.fromEntries(focusMarket.outcomes.map((o) => [o.id, o.price])),
                quickResearchSummary: reason,
                trade: false,
                evaluationRationale: reason,
                riskNotes: undefined,
                timestamp: new Date(),
                status: 'rejected_balance' as const
              } as const;
              if (((runtime as any)?.evaluations?.persist?.failed ?? true) !== false) {
          await (repo as any).recordMarketEvaluation(evaluationRecordLocal);
              }
              log('Skipping LLM due to no balance/min entry and rotation disabled', { marketId: focusMarket.id });
              continue;
            }
            const quickPositions = snapQuick.positions
              .filter((p: any) => p.status === 'open' && p.quantity >= minQtyQuick)
              .map((p: any) => {
                const key = `${p.marketId}:${p.optionId}`;
                const mm = marksQuick.get(key);
                const lastBid = mm?.bestBid;
                const uPnl = typeof lastBid === 'number' ? (lastBid - p.averagePrice) * p.quantity : undefined;
                return {
                  marketId: p.marketId,
                  outcomeId: p.optionId,
                  // names are optional in quick; ids are sufficient for add-on detection
                  marketTitle: undefined,
                  outcomeName: undefined,
                  direction: p.direction,
                  quantity: p.quantity,
                  averagePrice: p.averagePrice,
                  openedAt: p.openedAt.toISOString(),
                  lastMarkBid: lastBid,
                  unrealizedPnl: uPnl,
                };
              });
            const quickRes = await evaluateWithRetries(openrouter, {
              runId,
              agentId: agent.id,
              market: focusMarket,
              quickResearchSummary: researchSummaryLocal,
              runtime,
              profile: quickProfile,
              priceHistoryByOutcomeId: await buildPriceHistoryByOutcomeId(focusMarket),
              // Quick phase remains per-sibling; siblingOutcomes are advisory only
              siblingOutcomes: eventMarkets
                .filter((m) => m.id !== focusMarket.id)
                .flatMap((m) => m.outcomes.map((o) => ({
                  marketId: m.id,
                  marketTitle: m.question,
                  url: m.url,
                  slug: (m as any).slug,
                  id: o.id,
                  name: o.name,
                  price: o.price,
                  bestBid: (o as any).bestBid as number | undefined,
                  bestAsk: (o as any).bestAsk as number | undefined,
                  askLevels: ((o as any).askLevels as Array<{ price: number; quantity: number }> | undefined) ?? [],
                }))),
              phase: "quick",
              preferred: preferredSet.has(focusMarket.id),
              portfolioContext: {
                availableBalance: Bquick,
                positions: quickPositions,
              },
              riskHeadroom: {
                perMarketMaxPct: pMax,
                equity: eqQuick,
                marketExposure: mktExposureQuick,
                headroom: headroomQuick,
                availableBalance: Bquick,
                perRunMaxPct: pRun,
                runExposure: positionsCostQuick,
                runHeadroom: headroomRunQuick,
              },
            }, 'quick');
            let evaluationRecordLocal: any = quickRes.evaluation;
            // Ensure the user-visible quick summary shows the model's human rationale
            if (typeof evaluationRecordLocal?.evaluationRationale === 'string' && evaluationRecordLocal.evaluationRationale.length > 0) {
              evaluationRecordLocal.quickResearchSummary = evaluationRecordLocal.evaluationRationale;
            }
            // Classify parse/format failures as AI errors for filtering
            if (quickRes.parsedOk === false) {
              const msg = `Decision parse_error: invalid/empty JSON after repair; no-trade.`;
              evaluationRecordLocal.status = 'rejected_ai_error';
              evaluationRecordLocal.quickResearchSummary = msg;
              evaluationRecordLocal.evaluationRationale = msg;
            } else {
              evaluationRecordLocal.status = 'accepted';
            }
            // Remove preferred label on first rejection in quick phase
            const runAtCapQuick =
              typeof headroomRunQuick === 'number' && headroomRunQuick <= 0;
            if (
              !evaluationRecordLocal?.trade &&
              preferredSet.has(focusMarket.id) &&
              !runAtCapQuick
            ) {
              preferredSet.delete(focusMarket.id);
            }

            // Enforce actionable outputs: if trade=true but outcomeId/trades missing, flip to no-trade conservatively
            let decisionExtrasLocal: any = {
              marketId: quickRes.marketId,
              outcomeId: quickRes.outcomeId,
              subjectiveProb: quickRes.subjectiveProb,
              maxPayPrice: quickRes.maxPayPrice,
              edgeBps: quickRes.edgeBps,
              priceBasis: quickRes.priceBasis,
              debugAiInput: quickRes.debugAiInput,
              debugAiOutput: quickRes.debugAiOutput,
              promptHash: quickRes.promptHash,
            };
            if (evaluationRecordLocal.trade && typeof decisionExtrasLocal.outcomeId === 'string' && decisionExtrasLocal.outcomeId.length > 0) {
              acceptedOutcomeIdsSoFar.add(String(decisionExtrasLocal.outcomeId));
            }
            // Do NOT demote here; allow deep phase to recover missing fields
            if (!promptLogged.quick) {
              promptLogged.quick = true;
              log("Decision prompt signature", {
                agent: agent.id,
                phase: "quick",
                promptHash: quickRes.promptHash,
              });
            }
            if (runtime.logging.verbose.ai) {
              if (decisionExtrasLocal.debugAiInput && !runtime.logging.redact.aiInput)
                log("AI input", decisionExtrasLocal.debugAiInput as any);
              if (
                decisionExtrasLocal.debugAiOutput &&
                !runtime.logging.redact.aiOutput
              )
                log("AI output", decisionExtrasLocal.debugAiOutput as any);
            }
            // If quick recommends trade, run the deep decision (only when quick provided a valid outcome)
            if (evaluationRecordLocal.trade && decisionExtrasLocal.outcomeId) {
              const snapshot = portfolio.snapshot();
              const marks = await (repo as any).getPositionMarks(agent.id);
              const Bdeep = snapshot.cashBalance - snapshot.reservedBalance;
              const pMaxDeep = (runtime as any)?.risk?.perMarketMaxPct as number | undefined;
              const eqDeep = ((): number => {
                const minQtyDeepEq = Math.max(0, (runtime as any)?.ui?.minOpenQuantity ?? 0.01);
                const open = snapshot.positions.filter((p: any) => p.status === 'open' && p.quantity >= minQtyDeepEq);
                let sumBid = 0;
                for (const p of open) {
                  const m = marks.get(`${p.marketId}:${p.optionId}`);
                  const bid = typeof m?.bestBid === 'number' ? m!.bestBid! : p.averagePrice;
                  sumBid += bid * p.quantity;
                }
                return snapshot.cashBalance + sumBid;
              })();
              const minQtyDeepMx = Math.max(0, (runtime as any)?.ui?.minOpenQuantity ?? 0.01);
              const mktExposureDeep = snapshot.positions
                .filter((p: any) => p.status === 'open' && p.quantity >= minQtyDeepMx && p.marketId === focusMarket.id)
                .reduce((acc: number, p: any) => acc + p.averagePrice * p.quantity, 0);
            const headroomDeep = typeof pMaxDeep === 'number' ? Math.max(0, pMaxDeep * eqDeep - mktExposureDeep) : undefined;
            const openPositionsCount = snapshot.positions.filter((p: any) => p.status === 'open' && p.quantity >= minQtyDeepMx).length;
              const positionsCostDeep = snapshot.positions
                .filter((p: any) => p.status === 'open' && p.quantity >= minQtyDeepMx)
                .reduce((acc: number, p: any) => acc + p.averagePrice * p.quantity, 0);
              const pRunDeep = (runtime as any)?.risk?.perRunMaxPct as number | undefined;
              const headroomRunDeep =
                typeof pRunDeep === 'number'
                  ? Math.max(0, pRunDeep * eqDeep - positionsCostDeep)
                  : undefined;
              // Optional readability: enrich with marketTitle and outcomeName from recent evaluations
              const evals = await (repo as any).listRecentMarketEvaluations(200, agent.id);
              const titleMap = new Map<string, string>();
              const nameMap = new Map<string, string>();
              for (const e of evals) {
                titleMap.set(e.marketId, e.title);
                for (const o of e.outcomes as Array<{ id: string; name: string }>) {
                  nameMap.set(`${e.marketId}:${o.id}`, o.name);
                }
              }
              
              const deepSummaryLocal = `Event snapshot:\n${eventSnapshotText}`;

              const deepRes = await evaluateWithRetries(openrouter, {
                runId,
                agentId: agent.id,
                market: focusMarket,
                quickResearchSummary: researchSummaryLocal,
                deepResearchSummary: deepSummaryLocal,
                runtime,
                profile: deepProfile,
                priceHistoryByOutcomeId: await buildPriceHistoryByOutcomeId(focusMarket),
                // Deep phase: only include other siblings that already passed quick (accepted) so far
                siblingOutcomes: eventMarkets
                  .filter((m) => m.id !== focusMarket.id)
                  .flatMap((m) => m.outcomes)
                  .filter((o) => acceptedOutcomeIdsSoFar.has(String(o.id)) && String(o.id) !== String(decisionExtrasLocal.outcomeId))
                  .map((o) => ({
                    marketId: (eventMarkets.find((mm) => mm.outcomes.some((oo) => oo.id === o.id)) || focusMarket).id,
                    marketTitle: (eventMarkets.find((mm) => mm.outcomes.some((oo) => oo.id === o.id)) || focusMarket).question,
                    url: (eventMarkets.find((mm) => mm.outcomes.some((oo) => oo.id === o.id)) || focusMarket).url,
                    slug: (eventMarkets.find((mm) => mm.outcomes.some((oo) => oo.id === o.id)) as any)?.slug,
                    id: o.id,
                    name: o.name,
                    price: o.price,
                    bestBid: (o as any).bestBid as number | undefined,
                    bestAsk: (o as any).bestAsk as number | undefined,
                    askLevels: ((o as any).askLevels as Array<{ price: number; quantity: number }> | undefined) ?? [],
                  })),
                phase: "deep",
                preferred: preferredSet.has(focusMarket.id),
                quickDecision: {
                  trade: Boolean(evaluationRecordLocal.trade),
                  outcomeId: decisionExtrasLocal.outcomeId,
                  subjectiveProb: decisionExtrasLocal.subjectiveProb,
                  maxPayPrice: decisionExtrasLocal.maxPayPrice,
                  edgeBps: decisionExtrasLocal.edgeBps,
                  evaluationRationale:
                    typeof evaluationRecordLocal.evaluationRationale === "string"
                      ? evaluationRecordLocal.evaluationRationale
                      : undefined,
                },
                portfolioContext: {
                  availableBalance:
                    snapshot.cashBalance - snapshot.reservedBalance,
                  positions: snapshot.positions
                    .filter((p: any) => p.status === 'open' && p.quantity >= minQtyDeepMx)
                    .map((p: any) => {
                    const key = `${p.marketId}:${p.optionId}`;
                    const mm = marks.get(key);
                    const lastMark = mm?.bestBid;
                    const uPnl = typeof lastMark === 'number' ? (lastMark - p.averagePrice) * p.quantity : undefined;
                    return {
                    marketId: p.marketId,
                    outcomeId: p.optionId,
                    marketTitle: titleMap.get(p.marketId),
                    outcomeName: nameMap.get(key),
                    direction: p.direction,
                    quantity: p.quantity,
                    averagePrice: p.averagePrice,
                    openedAt: p.openedAt.toISOString(),
                    lastMarkBid: lastMark,
                    unrealizedPnl: uPnl,
                  };
                  }),
                },
                riskHeadroom: {
                  perMarketMaxPct: pMaxDeep,
                  equity: eqDeep,
                  marketExposure: mktExposureDeep,
                  headroom: headroomDeep,
                  availableBalance: Bdeep,
                  perRunMaxPct: pRunDeep,
                  runExposure: positionsCostDeep,
                  runHeadroom: headroomRunDeep,
                },
                constraints: {
                  maxOpenPositions: agent.execution.maxOpenPositions,
                  openPositionsCount,
                },
              }, 'deep');
              // Deep can veto the quick trade. Carry deep evaluation fields forward for persistence/execution.
              evaluationRecordLocal.trade = deepRes.evaluation.trade;
              evaluationRecordLocal.evaluationRationale = deepRes.evaluation.evaluationRationale;
              evaluationRecordLocal.quickResearchSummary = deepRes.evaluation.evaluationRationale;
              evaluationRecordLocal.riskNotes = deepRes.evaluation.riskNotes;
              evaluationRecordLocal.debugAiInputJson = deepRes.evaluation.debugAiInputJson;
              evaluationRecordLocal.debugAiOutputJson = deepRes.evaluation.debugAiOutputJson;
              evaluationRecordLocal.evaluationCitations = deepRes.evaluation.evaluationCitations;
              evaluationRecordLocal.timestamp = deepRes.evaluation.timestamp;
              // Prefer deep decision fields when provided
              decisionExtrasLocal = {
                marketId: deepRes.marketId ?? decisionExtrasLocal.marketId,
                outcomeId: deepRes.outcomeId ?? decisionExtrasLocal.outcomeId,
                subjectiveProb:
                  deepRes.subjectiveProb ?? decisionExtrasLocal.subjectiveProb,
                maxPayPrice: deepRes.maxPayPrice ?? decisionExtrasLocal.maxPayPrice,
                edgeBps: deepRes.edgeBps ?? decisionExtrasLocal.edgeBps,
                priceBasis: deepRes.priceBasis ?? decisionExtrasLocal.priceBasis,
                spendPct: deepRes.spendPct,
                tpPct: deepRes.tpPct ?? null,
                slPct: deepRes.slPct ?? null,
                // @ts-ignore allow extra for downstream logic
                replaceOutcomeId: (deepRes as any).replaceOutcomeId,
                // @ts-ignore optional multi-leg legs
                trades: (deepRes as any).trades,
                // Human-first rationale from the deep decision
                tradeRationale: deepRes.tradeRationale,
                debugAiInput: deepRes.debugAiInput,
                debugAiOutput: deepRes.debugAiOutput,
                promptHash: deepRes.promptHash,
                citations: Array.isArray((deepRes as any).citations) ? (deepRes as any).citations : undefined
              };
              if (!promptLogged.deep) {
                promptLogged.deep = true;
                log("Decision prompt signature", {
                  agent: agent.id,
                  phase: "deep",
                  promptHash: deepRes.promptHash,
                });
              }
              // Remove preferred label if deep produced no actionable trade
              const deepNoActionHere = !(deepRes && (deepRes.outcomeId || (Array.isArray((deepRes as any).trades) && (deepRes as any).trades.length > 0)));
              if (deepNoActionHere && preferredSet.has(focusMarket.id)) {
                preferredSet.delete(focusMarket.id);
              }
            }

            // Determine legs BEFORE persisting evaluation(s)
            let legsLocal: Array<{ marketId: string; outcomeId: string; spendPct?: number; maxPayPrice?: number; direction?: 'buy' | 'sell' }> = [];
            if (evaluationRecordLocal.trade) {
              legsLocal = (runtime.execution.multiLeg && Array.isArray((decisionExtrasLocal as any).trades))
                ? ((decisionExtrasLocal as any).trades as any[]).map((t: any) => ({ marketId: String(t.marketId ?? focusMarket.id), outcomeId: String(t.outcomeId), spendPct: typeof t.spendPct === 'number' ? t.spendPct : undefined, maxPayPrice: typeof t.maxPayPrice === 'number' ? t.maxPayPrice : undefined, direction: (typeof t.direction === 'string' && t.direction.toLowerCase().startsWith('s')) ? 'sell' : 'buy' }))
                : (decisionExtrasLocal.outcomeId ? [{
                    marketId: (decisionExtrasLocal.marketId ?? focusMarket.id) as string,
                    outcomeId: decisionExtrasLocal.outcomeId,
                    spendPct: typeof decisionExtrasLocal.spendPct === 'number' ? decisionExtrasLocal.spendPct : undefined,
                    maxPayPrice: typeof decisionExtrasLocal.maxPayPrice === 'number' ? decisionExtrasLocal.maxPayPrice : undefined,
                    direction: 'buy'
                  }] : []);
              // Prefilter: drop sell legs for outcomes not currently held above ui.minOpenQuantity.
              // This avoids planner-level rejections like "No open position to sell" while keeping buys unchanged.
              const minQtyPref = Math.max(0, (runtime as any)?.ui?.minOpenQuantity ?? 0.01);
              const snapshotForFilter = portfolio.snapshot();
              const openOutcomeIds = new Set(
                snapshotForFilter.positions
                  .filter((p: any) => p.status === 'open' && p.quantity >= minQtyPref)
                  .map((p: any) => String(p.optionId))
              );
              legsLocal = legsLocal.filter((leg) => leg.direction !== 'sell' || openOutcomeIds.has(String(leg.outcomeId)));
            }
            const evalIdsByMarket = new Map<string, number>();
            // Harden: only persist trade=true when we actually have actionable legs (after deep attempt)
            if (evaluationRecordLocal.trade && legsLocal.length === 0) {
              // As a last resort, demote to no-trade only after giving deep a chance to produce legs
              evaluationRecordLocal.trade = false;
              const note = 'no actionable legs after quick+deep';
              if (typeof evaluationRecordLocal.evaluationRationale === 'string' && evaluationRecordLocal.evaluationRationale.length > 0) {
                evaluationRecordLocal.evaluationRationale = `${evaluationRecordLocal.evaluationRationale} | ${note}`;
              } else {
                (evaluationRecordLocal as any).evaluationRationale = note;
              }
            }
            // Persist evaluation(s): only mark trade=true when actionable legs exist
            if (evaluationRecordLocal.trade && legsLocal.length > 0) {
              const resolvedLegs = legsLocal.map((leg) => {
                let chosenMarket = (leg.marketId && eventMarkets.find((m) => m.id === leg.marketId)) || focusMarket;
                if (!chosenMarket.outcomes.some((o) => o.id === leg.outcomeId)) {
                  const alt = eventMarkets.find((m) => m.outcomes.some((o) => o.id === leg.outcomeId));
                  if (alt) chosenMarket = alt;
                }
                return { ...leg, marketId: chosenMarket.id, __market: chosenMarket } as any;
              });
              const uniqueMarkets: Array<typeof market> = Array.from(new Map(resolvedLegs.map((rl: any) => [rl.__market.id, rl.__market])).values());
              for (const mkt of uniqueMarkets) {
                const evalForChosen = {
                  ...evaluationRecordLocal,
                  marketId: mkt.id,
                  title: mkt.question,
                  outcomes: mkt.outcomes.map((o) => ({ id: o.id, name: o.name, price: o.price })),
                  currentPrices: Object.fromEntries(mkt.outcomes.map((o) => [o.id, o.price]))
                };
                const existing = evalIdByMarketGlobal.get(mkt.id);
                if (existing) {
                  evalIdsByMarket.set(mkt.id, existing);
                } else {
                  const id = await (repo as any).recordMarketEvaluation(evalForChosen);
                  evalIdsByMarket.set(mkt.id, id);
                  evalIdByMarketGlobal.set(mkt.id, id);
                  log("Evaluated market", { marketId: mkt.id, trade: evalForChosen.trade });
                  if (postDecisionCooldownMinutes > 0) {
                    if (evalForChosen.trade) {
                      await (repo as any).clearMarketCooldowns(agent.id, mkt.id, "evaluation:no-trade");
                    } else {
                      const expires = schedulePostDecisionCooldown();
                      if (expires) {
                        await (repo as any).upsertMarketCooldown({ agentId: agent.id, marketId: mkt.id, reason: "evaluation:no-trade", expiresAt: expires });
                      }
                    }
                  }
                }
              }
              legsLocal = resolvedLegs as any;
            } else {
              // Harden: demote trade flag when no actionable legs were produced
              if (evaluationRecordLocal.trade && legsLocal.length === 0) {
                evaluationRecordLocal.trade = false;
                const note = 'no actionable legs from decision';
                if (
                  typeof evaluationRecordLocal.evaluationRationale === 'string' &&
                  evaluationRecordLocal.evaluationRationale.length > 0
                ) {
                  evaluationRecordLocal.evaluationRationale = `${evaluationRecordLocal.evaluationRationale} | ${note}`;
                } else {
                  (evaluationRecordLocal as any).evaluationRationale = note;
                }
                evaluationRecordLocal.status = 'rejected_ai_error';
              }
              const existing = evalIdByMarketGlobal.get(focusMarket.id);
              if (existing) {
                evalIdsByMarket.set(focusMarket.id, existing);
              } else {
                const evalId = await (repo as any).recordMarketEvaluation(evaluationRecordLocal);
                evalIdsByMarket.set(focusMarket.id, evalId);
                evalIdByMarketGlobal.set(focusMarket.id, evalId);
                log("Evaluated market", { marketId: focusMarket.id, trade: evaluationRecordLocal.trade });
                if (postDecisionCooldownMinutes > 0) {
                  if (evaluationRecordLocal.trade) {
                    await (repo as any).clearMarketCooldowns(agent.id, focusMarket.id, "evaluation:no-trade");
                  } else {
                    const expires = schedulePostDecisionCooldown();
                    if (expires) {
                      await (repo as any).upsertMarketCooldown({ agentId: agent.id, marketId: focusMarket.id, reason: "evaluation:no-trade", expiresAt: expires });
                    }
                  }
                }
              }
            }

            if (evaluationRecordLocal.trade && legsLocal.length > 0) {
              for (const leg of legsLocal) {
                const chosenMarket = eventMarkets.find((m) => m.id === leg.marketId) || focusMarket;
                const decisionForLeg = { ...decisionExtrasLocal, marketId: chosenMarket.id, outcomeId: leg.outcomeId, spendPct: leg.spendPct, maxPayPrice: leg.maxPayPrice, direction: leg.direction } as any;
                const evalIdForLeg = evalIdsByMarket.get(chosenMarket.id) ?? Array.from(evalIdsByMarket.values())[0]!;
                const evaluationForLeg = {
                  ...evaluationRecordLocal,
                  marketId: chosenMarket.id,
                  title: chosenMarket.question,
                  outcomes: chosenMarket.outcomes.map((o) => ({ id: o.id, name: o.name, price: o.price })),
                  currentPrices: Object.fromEntries(chosenMarket.outcomes.map((o) => [o.id, o.price]))
                };
                candidates.push({ market: chosenMarket, evalId: evalIdForLeg, evaluation: evaluationForLeg, quickSummary: researchSummary, decision: decisionForLeg });
              }
              // Remove duplicate legs for the same outcome across siblings
              dedupCandidatesInPlace();
            }
          } catch (e) {
            const err = e as any;
            let code = 'unknown';
            const detail = (err?.message as string) || String(err);
            if (detail.includes('timed out')) code = 'timeout';
            else if (detail.includes('429') || err?.status === 429) code = 'rate_limit';
            else if (/5\d\d/.test(String(err?.status))) code = 'server_error';
            else if (detail.includes('CircuitOpen')) code = 'circuit_open';
            else if (detail.includes('fetch failed') || detail.includes('network')) code = 'network_error';
            else if (detail.toLowerCase().includes('json')) code = 'parse_error';
            const errMsg = `Decision failed: ${code}${err?.status ? ` (status ${err.status})` : ''}; ${detail}`;
            const evaluationRecordLocal = {
              runId,
              agentId: agent.id,
              marketId: cand.marketId,
              title: (eventMarkets.find((m) => m.id === cand.marketId) || market).question,
              outcomes: (eventMarkets.find((m) => m.id === cand.marketId) || market).outcomes.map((o) => ({ id: o.id, name: o.name, price: o.price })),
              currentPrices: Object.fromEntries((eventMarkets.find((m) => m.id === cand.marketId) || market).outcomes.map((o) => [o.id, o.price])),
              quickResearchSummary: errMsg,
              trade: false,
              evaluationRationale: errMsg,
              riskNotes: "AI decision error; conservative no-trade",
              timestamp: new Date(),
              status: 'rejected_ai_error' as const
            };
            if (((runtime as any)?.evaluations?.persist?.failed ?? true) !== false) {
              await (repo as any).recordMarketEvaluation(evaluationRecordLocal);
            }
            log("OpenRouter decision error; recorded no-trade", { marketId: cand.marketId, error: detail });
            continue;
          }
        }
        // We've already persisted and enqueued candidates per-sibling; skip the single-eval path
        continue;
      }

      let evaluationRecord: any;
      let decisionExtras: {
        marketId?: string;
        outcomeId?: string;
        subjectiveProb?: number;
        maxPayPrice?: number;
        edgeBps?: number;
        priceBasis?: "ask" | "mid" | "snapshot";
        spendPct?: number;
        tpPct?: number | null;
        slPct?: number | null;
        tradeRationale?: string;
        debugAiInput?: unknown;
        debugAiOutput?: unknown;
        replaceOutcomeId?: string;
        trades?: Array<{ marketId: string; outcomeId: string; spendPct?: number; maxPayPrice?: number; direction?: 'buy' | 'sell' }>;
        citations?: string[];
        promptHash?: string;
      } = {};
      let priceHistoryByOutcomeId: any = undefined;
      if (hasModelKey) {
        try {
          // Quick-phase decision; include a brief portfolio context so the model can recognize add-ons
          const snapQuick = portfolio.snapshot();
            const marksQuick = await (repo as any).getPositionMarks(agent.id);
          const Bquick = snapQuick.cashBalance - snapQuick.reservedBalance;
          const minQtyQuick2 = Math.max(0, (runtime as any)?.ui?.minOpenQuantity ?? 0.01);
          const pMax = (runtime as any)?.risk?.perMarketMaxPct as number | undefined;
          // Eq (prompt): cash + sum(bestBid * qty) using marks; fallback to avg when bid missing
          const eqQuick = ((): number => {
            const open = snapQuick.positions.filter((p: any) => p.status === 'open' && p.quantity >= minQtyQuick2);
            let sumBid = 0;
            for (const p of open) {
              const m = marksQuick.get(`${p.marketId}:${p.optionId}`);
              const bid = typeof m?.bestBid === 'number' ? m!.bestBid! : p.averagePrice;
              sumBid += bid * p.quantity;
            }
            return snapQuick.cashBalance + sumBid;
          })();
          // Market exposure M at average price
          const mktExposureQuick = snapQuick.positions
            .filter((p: any) => p.status === 'open' && p.quantity >= minQtyQuick2 && p.marketId === market.id)
            .reduce((acc: number, p: any) => acc + p.averagePrice * p.quantity, 0);
          const headroomQuick = typeof pMax === 'number' ? Math.max(0, pMax * eqQuick - mktExposureQuick) : undefined;

          // Pre-LLM gating to avoid wasted calls
          const minEntryNotional = Math.max(
            Number((runtime.execution as any)?.sizing?.minNotional ?? 0),
            Number(((runtime as any)?.risk?.perTradeMin) ?? 0),
            0,
          );
          const rotationEnabled = Boolean((runtime as any)?.execution?.rotationWhenNoBalance?.enabled ?? true);
          if ((Bquick <= 0 || Bquick < minEntryNotional) && !rotationEnabled) {
            const reason = Bquick <= 0
              ? 'No available balance; rotation disabled.'
              : `Available balance $${Bquick.toFixed(2)} < min entry $${minEntryNotional.toFixed(2)}; rotation disabled.`;
            const evaluationRecordLocal = {
              runId,
              agentId: agent.id,
              marketId: market.id,
              title: market.question,
              outcomes: market.outcomes.map((o) => ({ id: o.id, name: o.name, price: o.price })),
              currentPrices: Object.fromEntries(market.outcomes.map((o) => [o.id, o.price])),
              quickResearchSummary: reason,
              trade: false,
              evaluationRationale: reason,
              riskNotes: undefined,
              timestamp: new Date(),
            } as const;
            await (repo as any).recordMarketEvaluation(evaluationRecordLocal);
            log('Skipping LLM due to no balance/min entry and rotation disabled', { marketId: market.id });
            continue;
          }
          const minQty2 = Math.max(0, (runtime as any)?.ui?.minOpenQuantity ?? 0.01);
          const quickPositions = snapQuick.positions
            .filter((p: any) => p.status === 'open' && p.quantity >= minQty2)
            .map((p: any) => {
            const key = `${p.marketId}:${p.optionId}`;
            const mm = marksQuick.get(key);
            const lastBid = mm?.bestBid;
            const uPnl = typeof lastBid === 'number' ? (lastBid - p.averagePrice) * p.quantity : undefined;
            return {
              marketId: p.marketId,
              outcomeId: p.optionId,
              // names are optional in quick; ids are sufficient for add-on detection
              marketTitle: undefined,
              outcomeName: undefined,
              direction: p.direction,
              quantity: p.quantity,
              averagePrice: p.averagePrice,
              openedAt: p.openedAt.toISOString(),
              lastMarkBid: lastBid,
              unrealizedPnl: uPnl,
            };
          });
          priceHistoryByOutcomeId = await buildPriceHistoryByOutcomeId(market);
          const quickRes = await evaluateWithRetries(openrouter, {
            runId,
            agentId: agent.id,
            market,
            quickResearchSummary: researchSummary,
            runtime,
            profile: quickProfile,
            priceHistoryByOutcomeId,
            // Keep quick per-sibling; do not include siblings as selection targets
            siblingOutcomes: [],
            phase: "quick",
            preferred: preferredSet.has(market.id),
            portfolioContext: {
              availableBalance: Bquick,
              positions: quickPositions,
            },
            riskHeadroom: {
              perMarketMaxPct: pMax,
              equity: eqQuick,
              marketExposure: mktExposureQuick,
              headroom: headroomQuick,
              availableBalance: Bquick,
            },
          }, 'quick');
          evaluationRecord = quickRes.evaluation;
          // Ensure the user-visible quick summary shows the model's human rationale
          if (typeof evaluationRecord?.evaluationRationale === 'string' && evaluationRecord.evaluationRationale.length > 0) {
            evaluationRecord.quickResearchSummary = evaluationRecord.evaluationRationale;
          }
          // Attach basic search telemetry for verbose API if available in debug (non-blocking)
          if (evaluationRecord.debugAiInputJson && typeof evaluationRecord.debugAiInputJson === 'object') {
            try {
          
            } catch {}
          }
          // Attach all contributing citations for non per‑sibling evaluation
          
          // Classify parse/format failures as AI errors for filtering
          if (quickRes.parsedOk === false) {
            const msg = `Decision parse_error: invalid/empty JSON after repair; no-trade.`;
            evaluationRecord.status = 'rejected_ai_error';
            evaluationRecord.quickResearchSummary = msg;
            evaluationRecord.evaluationRationale = msg;
          } else {
            evaluationRecord.status = 'accepted';
          }
          // Remove preferred label on first rejection in quick phase
          if (!evaluationRecord?.trade && preferredSet.has(market.id)) {
            preferredSet.delete(market.id);
          }
          decisionExtras = {
            marketId: quickRes.marketId,
            outcomeId: quickRes.outcomeId,
            subjectiveProb: quickRes.subjectiveProb,
            maxPayPrice: quickRes.maxPayPrice,
            edgeBps: quickRes.edgeBps,
            priceBasis: quickRes.priceBasis,
            debugAiInput: quickRes.debugAiInput,
            debugAiOutput: quickRes.debugAiOutput,
            promptHash: quickRes.promptHash,
          };
          // Do NOT demote here; allow deep phase to recover missing fields
          if (!promptLogged.quick) {
            promptLogged.quick = true;
            log("Decision prompt signature", {
              agent: agent.id,
              phase: "quick",
              promptHash: quickRes.promptHash,
            });
          }
          if (runtime.logging.verbose.ai) {
            if (decisionExtras.debugAiInput && !runtime.logging.redact.aiInput)
              log("AI input", decisionExtras.debugAiInput as any);
            if (
              decisionExtras.debugAiOutput &&
              !runtime.logging.redact.aiOutput
            )
              log("AI output", decisionExtras.debugAiOutput as any);
          }
          // If quick recommends trade, run the deep decision only when quick provided a valid outcome
          if (evaluationRecord.trade && decisionExtras.outcomeId) {
            // Track accepted outcome for sibling context in later deep runs
            // Note: only siblings already accepted earlier will appear for later markets
            // (partial set is intentional per requirements).
            // For this code path, we do not build a global set here due to different control flow.
            const snapshot = (await (portfolio as any).snapshot?.()) ?? (portfolio as any).snapshot();
            const marks = await (repo as any).getPositionMarks(agent.id);
            const Bdeep = snapshot.cashBalance - snapshot.reservedBalance;
            const pMaxDeep = (runtime as any)?.risk?.perMarketMaxPct as number | undefined;
            const eqDeep = ((): number => {
              const minQtyDeep2 = Math.max(0, (runtime as any)?.ui?.minOpenQuantity ?? 0.01);
              const open = snapshot.positions.filter((p: any) => p.status === 'open' && p.quantity >= minQtyDeep2);
              let sumBid = 0;
              for (const p of open) {
                const m = marks.get(`${p.marketId}:${p.optionId}`);
                const bid = typeof m?.bestBid === 'number' ? m!.bestBid! : p.averagePrice;
                sumBid += bid * p.quantity;
              }
              return snapshot.cashBalance + sumBid;
            })();
            const minQtyDeep2B = Math.max(0, (runtime as any)?.ui?.minOpenQuantity ?? 0.01);
            const mktExposureDeep = snapshot.positions
              .filter((p: any) => p.status === 'open' && p.quantity >= minQtyDeep2B && p.marketId === market.id)
              .reduce((acc: number, p: any) => acc + p.averagePrice * p.quantity, 0);
            const headroomDeep = typeof pMaxDeep === 'number' ? Math.max(0, pMaxDeep * eqDeep - mktExposureDeep) : undefined;
            const openPositionsCount = snapshot.positions.filter((p: any) => p.status === 'open' && p.quantity >= minQtyDeep2B).length;
            // Optional readability: enrich with marketTitle and outcomeName from recent evaluations
            const evals = await (repo as any).listRecentMarketEvaluations(200, agent.id);
            const titleMap = new Map<string, string>();
            const nameMap = new Map<string, string>();
            for (const e of evals) {
              titleMap.set(e.marketId, e.title);
              for (const o of e.outcomes as Array<{ id: string; name: string }>) {
                nameMap.set(`${e.marketId}:${o.id}`, o.name);
              }
            }
            const deepRes = await evaluateWithRetries(openrouter, {
              runId,
              agentId: agent.id,
              market,
              quickResearchSummary: researchSummary,
              deepResearchSummary: deepSummary,
              runtime,
              profile: deepProfile,
              priceHistoryByOutcomeId,
              siblingOutcomes: includedQuick.filter(
                (c) => c.marketId !== market.id,
              ),
              phase: "deep",
              preferred: preferredSet.has(market.id),
              quickDecision: {
                trade: Boolean(evaluationRecord.trade),
                outcomeId: decisionExtras.outcomeId,
                subjectiveProb: decisionExtras.subjectiveProb,
                maxPayPrice: decisionExtras.maxPayPrice,
                edgeBps: decisionExtras.edgeBps,
                evaluationRationale:
                  typeof evaluationRecord.evaluationRationale === "string"
                    ? evaluationRecord.evaluationRationale
                    : undefined,
              },
              portfolioContext: {
                availableBalance:
                  snapshot.cashBalance - snapshot.reservedBalance,
                positions: snapshot.positions
                  .filter((p: any) => p.status === 'open' && p.quantity >= minQtyDeep2B)
                  .map((p: any) => {
                  const key = `${p.marketId}:${p.optionId}`;
                  const mm = marks.get(key);
                  const lastBid = mm?.bestBid;
                  const uPnl = typeof lastBid === 'number' ? (lastBid - p.averagePrice) * p.quantity : undefined;
                  return {
                  marketId: p.marketId,
                  outcomeId: p.optionId,
                  marketTitle: titleMap.get(p.marketId),
                  outcomeName: nameMap.get(key),
                  direction: p.direction,
                  quantity: p.quantity,
                  averagePrice: p.averagePrice,
                  openedAt: p.openedAt.toISOString(),
                  lastMarkBid: lastBid,
                  unrealizedPnl: uPnl,
                };
                }),
              },
              riskHeadroom: {
                perMarketMaxPct: pMaxDeep,
                equity: eqDeep,
                marketExposure: mktExposureDeep,
                headroom: headroomDeep,
                availableBalance: Bdeep,
              },
              constraints: {
                maxOpenPositions: agent.execution.maxOpenPositions,
                openPositionsCount,
              },
            }, 'deep');
            // Deep can veto the quick trade. Carry deep evaluation fields forward for persistence/execution.
            evaluationRecord.trade = deepRes.evaluation.trade;
            evaluationRecord.evaluationRationale = deepRes.evaluation.evaluationRationale;
            evaluationRecord.quickResearchSummary = deepRes.evaluation.evaluationRationale;
            evaluationRecord.riskNotes = deepRes.evaluation.riskNotes;
            evaluationRecord.debugAiInputJson = deepRes.evaluation.debugAiInputJson;
            evaluationRecord.debugAiOutputJson = deepRes.evaluation.debugAiOutputJson;
            evaluationRecord.evaluationCitations = deepRes.evaluation.evaluationCitations;
            evaluationRecord.timestamp = deepRes.evaluation.timestamp;
            // Prefer deep decision fields when provided
            decisionExtras = {
              marketId: deepRes.marketId ?? decisionExtras.marketId,
              outcomeId: deepRes.outcomeId ?? decisionExtras.outcomeId,
              subjectiveProb:
                deepRes.subjectiveProb ?? decisionExtras.subjectiveProb,
              maxPayPrice: deepRes.maxPayPrice ?? decisionExtras.maxPayPrice,
              edgeBps: deepRes.edgeBps ?? decisionExtras.edgeBps,
              priceBasis: deepRes.priceBasis ?? decisionExtras.priceBasis,
              spendPct: deepRes.spendPct,
              tpPct: deepRes.tpPct ?? null,
              slPct: deepRes.slPct ?? null,
              // @ts-ignore allow extra for downstream logic
              replaceOutcomeId: (deepRes as any).replaceOutcomeId,
              // @ts-ignore optional multi-leg legs
              trades: (deepRes as any).trades,
              // Human-first rationale from the deep decision
              tradeRationale: deepRes.tradeRationale,
              debugAiInput: deepRes.debugAiInput,
              debugAiOutput: deepRes.debugAiOutput,
              promptHash: deepRes.promptHash,
              citations: Array.isArray((deepRes as any).citations) ? (deepRes as any).citations : undefined,
            };
            if (!promptLogged.deep) {
              promptLogged.deep = true;
              log("Decision prompt signature", {
                agent: agent.id,
                phase: "deep",
                promptHash: deepRes.promptHash,
              });
            }
            // Remove preferred label if deep produced no actionable trade
            const deepNoAction = !(deepRes && (deepRes.outcomeId || (Array.isArray((deepRes as any).trades) && (deepRes as any).trades.length > 0)));
            if (deepNoAction && preferredSet.has(market.id)) {
              preferredSet.delete(market.id);
            }
          }
        } catch (e) {
          const err = e as any;
          let code = 'unknown';
          const detail = (err?.message as string) || String(err);
          if (detail.includes('timed out')) code = 'timeout';
          else if (detail.includes('429') || err?.status === 429) code = 'rate_limit';
          else if (/5\d\d/.test(String(err?.status))) code = 'server_error';
          else if (detail.includes('CircuitOpen')) code = 'circuit_open';
          else if (detail.includes('fetch failed') || detail.includes('network')) code = 'network_error';
          else if (detail.toLowerCase().includes('json')) code = 'parse_error';
          const errMsg = `Decision failed: ${code}${err?.status ? ` (status ${err.status})` : ''}; ${detail}`;
          evaluationRecord = {
            runId,
            agentId: agent.id,
            marketId: market.id,
            title: market.question,
            outcomes: market.outcomes.map((o) => ({
              id: o.id,
              name: o.name,
              price: o.price,
            })),
            currentPrices: Object.fromEntries(
              market.outcomes.map((o) => [o.id, o.price]),
            ),
            quickResearchSummary: errMsg,
            trade: false,
            evaluationRationale: errMsg,
            riskNotes: "AI decision error; conservative no-trade",
            timestamp: new Date(),
            status: 'rejected_ai_error' as const,
          };
          if (((runtime as any)?.evaluations?.persist?.failed ?? true) === false) {
            // Skip persisting if disabled; rethrow to preserve flow to next market
          } else {
            // will persist below via common path
          }
          log("OpenRouter decision error; recorded no-trade", { marketId: market.id, error: detail });
        }
      } else {
        const noKeyMsg = "LLM key missing; skipping trade in paper-run.";
        evaluationRecord = {
          runId,
          agentId: agent.id,
          marketId: market.id,
          title: market.question,
          outcomes: market.outcomes.map((o) => ({
            id: o.id,
            name: o.name,
            price: o.price,
          })),
          currentPrices: Object.fromEntries(
            market.outcomes.map((o) => [o.id, o.price]),
          ),
          quickResearchSummary: noKeyMsg,
          trade: false,
          evaluationRationale: noKeyMsg,
          riskNotes: "Provide model API key to enable decisions.",
          timestamp: new Date(),
          status: 'rejected_ai_error' as const,
        };
        log("LLM key missing; recorded non-trade evaluation", {
          marketId: market.id,
        });
      }

      // Determine legs BEFORE persisting evaluation(s) so we can align market ids and titles
      let legs: Array<{ marketId: string; outcomeId: string; spendPct?: number; maxPayPrice?: number; direction?: 'buy' | 'sell' }> = [];
      if (evaluationRecord.trade) {
        legs = (runtime.execution.multiLeg && Array.isArray((decisionExtras as any).trades))
          ? ((decisionExtras as any).trades as any[]).map((t) => ({ marketId: String(t.marketId ?? market.id), outcomeId: String(t.outcomeId), spendPct: typeof t.spendPct === 'number' ? t.spendPct : undefined, maxPayPrice: typeof t.maxPayPrice === 'number' ? t.maxPayPrice : undefined, direction: (typeof t.direction === 'string' && t.direction.toLowerCase().startsWith('s')) ? 'sell' : 'buy' }))
          : (decisionExtras.outcomeId ? [{
              marketId: (decisionExtras.marketId ?? market.id) as string,
              outcomeId: decisionExtras.outcomeId,
              spendPct: typeof decisionExtras.spendPct === 'number' ? decisionExtras.spendPct : undefined,
              maxPayPrice: typeof decisionExtras.maxPayPrice === 'number' ? decisionExtras.maxPayPrice : undefined,
              direction: 'buy'
            }] : []);
        // Prefilter: drop sell legs for outcomes not currently held above ui.minOpenQuantity.
        const minQtyPref2 = Math.max(0, (runtime as any)?.ui?.minOpenQuantity ?? 0.01);
        const snapshotForFilter2 = portfolio.snapshot();
        const openOutcomeIds2 = new Set(
          snapshotForFilter2.positions
            .filter((p: any) => p.status === 'open' && p.quantity >= minQtyPref2)
            .map((p: any) => String(p.optionId))
        );
        legs = legs.filter((leg) => leg.direction !== 'sell' || openOutcomeIds2.has(String(leg.outcomeId)));
      }

      // Persist evaluation(s): if trade=true and chosen market differs, record evaluation under resolved chosen market(s)
      const evalIdsByMarket = new Map<string, number>();
      // Harden: only persist trade=true when we actually have actionable legs
      if (evaluationRecord.trade && legs.length === 0) {
        evaluationRecord.trade = false;
        const note = 'no actionable legs from decision';
        if (typeof evaluationRecord.evaluationRationale === 'string' && evaluationRecord.evaluationRationale.length > 0) {
          evaluationRecord.evaluationRationale = `${evaluationRecord.evaluationRationale} | ${note}`;
        } else {
          (evaluationRecord as any).evaluationRationale = note;
        }
        (evaluationRecord as any).status = 'rejected_ai_error';
      }
      if (evaluationRecord.trade && legs.length > 0) {
        // Resolve each leg to the concrete market that actually contains the outcome
        const resolvedLegs = legs.map((leg) => {
          let chosenMarket = (leg.marketId && eventMarkets.find((m) => m.id === leg.marketId)) || market;
          if (!chosenMarket.outcomes.some((o) => o.id === leg.outcomeId)) {
            const alt = eventMarkets.find((m) => m.outcomes.some((o) => o.id === leg.outcomeId));
            if (alt) chosenMarket = alt;
          }
          return { ...leg, marketId: chosenMarket.id, __market: chosenMarket } as any;
        });
        const uniqueMarkets: Array<typeof market> = Array.from(new Map(resolvedLegs.map((rl: any) => [rl.__market.id, rl.__market])).values());
        for (const mkt of uniqueMarkets) {
          const evalForChosen = {
            ...evaluationRecord,
            marketId: mkt.id,
            title: mkt.question,
            outcomes: mkt.outcomes.map((o) => ({ id: o.id, name: o.name, price: o.price })),
            currentPrices: Object.fromEntries(mkt.outcomes.map((o) => [o.id, o.price]))
          };
          const existing = evalIdByMarketGlobal.get(mkt.id);
          if (existing) {
            evalIdsByMarket.set(mkt.id, existing);
          } else {
            const id = await (repo as any).recordMarketEvaluation(evalForChosen);
            evalIdsByMarket.set(mkt.id, id);
            evalIdByMarketGlobal.set(mkt.id, id);
            log("Evaluated market", { marketId: mkt.id, trade: evalForChosen.trade });
            if (postDecisionCooldownMinutes > 0) {
              if (evalForChosen.trade) {
                await (repo as any).clearMarketCooldowns(agent.id, mkt.id, "evaluation:no-trade");
              } else {
                const expires = schedulePostDecisionCooldown();
                if (expires) {
                  await (repo as any).upsertMarketCooldown({ agentId: agent.id, marketId: mkt.id, reason: "evaluation:no-trade", expiresAt: expires });
                }
              }
            }
          }
        }
        // Replace legs with resolved versions so downstream planning uses the same market ids we persisted
        legs = resolvedLegs as any;
      } else {
        // Respect persistence knobs for failed classes
        if (evaluationRecord.status === 'rejected_ai_error' && ((runtime as any)?.evaluations?.persist?.failed ?? true) === false) {
          // skip persisting
        } else if (evaluationRecord.status === 'rejected_prefilter' && ((runtime as any)?.evaluations?.persist?.prefiltered ?? true) === false) {
          // skip persisting
        } else {
          const existing = evalIdByMarketGlobal.get(market.id);
          if (existing) {
            evalIdsByMarket.set(market.id, existing);
          } else {
            const evalId = await (repo as any).recordMarketEvaluation(evaluationRecord);
            evalIdsByMarket.set(market.id, evalId);
            evalIdByMarketGlobal.set(market.id, evalId);
            log("Evaluated market", { marketId: market.id, trade: evaluationRecord.trade });
            if (postDecisionCooldownMinutes > 0) {
              if (evaluationRecord.trade) {
                await (repo as any).clearMarketCooldowns(agent.id, market.id, "evaluation:no-trade");
              } else {
                const expires = schedulePostDecisionCooldown();
                if (expires) {
                  await (repo as any).upsertMarketCooldown({ agentId: agent.id, marketId: market.id, reason: "evaluation:no-trade", expiresAt: expires });
                }
              }
            }
          }
        }
      }

      // Build candidates from legs (trade=true) or from single decision (trade=false: none)
      if (evaluationRecord.trade && legs.length > 0) {
        for (const leg of legs) {
          const chosenMarket = eventMarkets.find((m) => m.id === leg.marketId) || market;
          const decisionForLeg = { ...decisionExtras, marketId: chosenMarket.id, outcomeId: leg.outcomeId, spendPct: leg.spendPct, maxPayPrice: leg.maxPayPrice, direction: leg.direction } as any;
          const evalIdForLeg = evalIdsByMarket.get(chosenMarket.id) ?? Array.from(evalIdsByMarket.values())[0]!;
          const evaluationForLeg = {
            ...evaluationRecord,
            marketId: chosenMarket.id,
            title: chosenMarket.question,
            outcomes: chosenMarket.outcomes.map((o) => ({ id: o.id, name: o.name, price: o.price })),
            currentPrices: Object.fromEntries(chosenMarket.outcomes.map((o) => [o.id, o.price]))
          };
          candidates.push({ market: chosenMarket, evalId: evalIdForLeg, evaluation: evaluationForLeg, quickSummary: researchSummary, decision: decisionForLeg });
        }
        dedupCandidatesInPlace();
      }
    }

    // Optional event-level coherence: prune multiple YES buys from the same event
    const groupCfg = ((runtime as any)?.research?.groupDecisions ?? { enabled: true });
    if (groupCfg && groupCfg.enabled === true && candidates.length > 1) {
      const byEvent = new Map<string, typeof candidates>();
      const getEventKey = (m: any) => (m?.eventSlug as string | undefined) || (m?.eventTitle as string | undefined) || m?.questionId || m?.id;
      for (const c of candidates) {
        const key = getEventKey(c.market) ?? c.market.id;
        const arr = byEvent.get(key) ?? ([] as typeof candidates);
        arr.push(c);
        byEvent.set(key, arr);
      }
      const kept: typeof candidates = [] as any;
      const rejected: { c: typeof candidates[number]; reason: string }[] = [];
      for (const [key, arr] of byEvent.entries()) {
        // Separate buys and sells; only constrain buys
        const buys = arr.filter((x) => ((x.decision as any).direction ?? 'buy') !== 'sell');
        const sells = arr.filter((x) => ((x.decision as any).direction ?? 'buy') === 'sell');
        if (buys.length <= 1) {
          kept.push(...arr);
          continue;
        }
        // Score: prefer highest edgeBps, then spendPct
        const score = (x: typeof arr[number]) => {
          const eb = typeof (x.decision as any).edgeBps === 'number' ? (x.decision as any).edgeBps : -1;
          const sp = typeof (x.decision as any).spendPct === 'number' ? (x.decision as any).spendPct : 0;
          return eb * 1000 + sp * 10;
        };
        const sorted = [...buys].sort((a, b) => score(b) - score(a));
        const winner = sorted[0]!;
        kept.push(winner, ...sells);
        for (let i = 1; i < sorted.length; i++) {
          const lose = sorted[i]!;
          const wOut = winner.market.outcomes.find((o) => o.id === (winner.decision as any).outcomeId);
          const lOut = lose.market.outcomes.find((o) => o.id === (lose.decision as any).outcomeId);
          const wTitle = winner.market.question;
          const lTitle = lose.market.question;
          const wName = wOut?.name ?? String((winner.decision as any).outcomeId);
          const lName = lOut?.name ?? String((lose.decision as any).outcomeId);
          const wEdge = (winner.decision as any).edgeBps ?? 'n/a';
          const reason = `group_decision: per-event cap; kept "${wTitle}" [${wName}] edge=${wEdge}; reject "${lTitle}" [${lName}]`;
          rejected.push({ c: lose, reason });
        }
      }
      if (rejected.length > 0) {
        if (runtime.logging.verbose.markets) {
          log('Group prune by event', { pruned: rejected.length, kept: kept.length });
        }
        // Record planner rejections for pruned candidates for observability
        for (const r of rejected) {
          try {
            await (repo as any).recordPlanDecision({
              evaluationId: r.c.evalId,
              agentId: agent.id,
              marketId: r.c.market.id,
              outcomeId: r.c.decision.outcomeId,
              status: 'rejected',
              reason: r.reason,
              createdAt: new Date(),
            });
          } catch {}
        }
        candidates.splice(0, candidates.length, ...kept);
      }
    }

    for (const c of candidates) {
      // Optional price/orderbook refresh for chosen outcome to avoid staleness
      if (runtime.execution.priceRefresh.enabled) {
        // Refresh only the chosen outcome from decision
        const selected =
          c.market.outcomes.find((o) => o.id === c.decision.outcomeId) ??
          c.market.outcomes[0];
        try {
          const tokenId = (selected as any).clobTokenId ?? (typeof selected.id === 'string' && /^\d+$/.test(selected.id) ? selected.id : undefined);
          const ob = tokenId ? await polymarket.getOrderBook(tokenId) : undefined;
          if (ob) {
            const levels = runtime.tradeEvaluation.gating?.liquidityLevels ?? 1;
            const depthLevels = Math.max(
              levels,
              runtime.execution.sizing?.maxDepthLevels ?? levels,
            );
            const idx = c.market.outcomes.findIndex(
              (o) => o.id === selected.id,
            );
            if (idx >= 0) {
              const bestBid = ob.bids.length
                ? Math.max(...ob.bids.map((l) => l.price))
                : undefined;
              const bestAsk = ob.asks.length
                ? Math.min(...ob.asks.map((l) => l.price))
                : undefined;
              (c.market.outcomes[idx] as any).bestBid = Number.isFinite(
                bestBid as number,
              )
                ? (bestBid as number)
                : (c.market.outcomes[idx] as any).bestBid;
              (c.market.outcomes[idx] as any).bestAsk = Number.isFinite(
                bestAsk as number,
              )
                ? (bestAsk as number)
                : (c.market.outcomes[idx] as any).bestAsk;
              (c.market.outcomes[idx] as any).bidLevels = ob.bids.slice(
                0,
                depthLevels,
              );
              (c.market.outcomes[idx] as any).askLevels = ob.asks.slice(
                0,
                depthLevels,
              );
            }
          }
        } catch (e) {
          log("Order book refresh failed; proceeding with last snapshot", {
            marketId: c.market.id,
            error: (e as Error).message,
          });
        }
      }

      // Capacity enforcement: respect maxOpenPositions with optional replacement
      const minQtyCap = Math.max(0, (runtime as any)?.ui?.minOpenQuantity ?? 0.01);
      let openNow = (await (repo as any).listOpenPositions(agent.id)).filter((p: any) => p.quantity >= minQtyCap);
      let atCap = openNow.length >= (agent.execution.maxOpenPositions ?? Number.MAX_SAFE_INTEGER);
      const alreadyOpen = openNow.some((p: any) => p.optionId === c.decision.outcomeId);

      const snapshotNow = await (portfolio as any).snapshot?.() ?? (portfolio as any).snapshot();
      const balanceNow = snapshotNow.cashBalance - snapshotNow.reservedBalance;
      let didReplacementSell = false;
      if (balanceNow <= 0) {
        const replaceOutcomeIdB0 = (c.decision as any).replaceOutcomeId as string | undefined;
        if (replaceOutcomeIdB0 && typeof replaceOutcomeIdB0 === 'string') {
          const target = openNow.find((p: any) => p.optionId === replaceOutcomeIdB0);
          if (target) {
            let exitPrice: number | undefined;
            try {
              const tokenId = typeof target.optionId === 'string' && /^\d+$/.test(target.optionId) ? target.optionId : undefined;
              const ob = tokenId ? await polymarket.getOrderBook(tokenId) : undefined;
              exitPrice = ob?.bids?.[0]?.price;
            } catch {}
            const ep = typeof exitPrice === 'number' ? exitPrice : target.averagePrice;
            const fullNotional = ep * target.quantity;
            await (repo as any).recordPlanDecision({
              evaluationId: c.evalId,
              agentId: agent.id,
              marketId: target.marketId,
              outcomeId: target.optionId,
              status: 'accepted',
              reason: `balance=0: replace L=${target.optionId} to free cash for N=${c.decision.outcomeId}`,
              createdAt: new Date(),
            });
            const sellId = await (repo as any).recordTradeInstruction({
              evaluationId: c.evalId,
              agentId: agent.id,
              marketId: target.marketId,
              optionId: target.optionId,
              direction: 'sell',
              notional: fullNotional,
              expectedPrice: ep,
              reason: `balance=0 replacement: close ${target.optionId} @~${ep.toFixed(3)} notional=${fullNotional.toFixed(2)}`,
              createdAt: new Date(),
            });
            let capFeeBps: number | undefined;
            try {
              const tokenId = typeof target.optionId === 'string' && /^\d+$/.test(target.optionId) ? target.optionId : undefined;
              capFeeBps = tokenId ? await polymarket.getFeeRateBps(tokenId) : undefined;
            } catch {}
            await (portfolio as any).executeTrade({
              tradeInstructionId: sellId,
              marketId: target.marketId,
              optionId: target.optionId,
              direction: 'sell',
              price: exitPrice,
              notional: fullNotional,
              metadata: { feeBps: typeof capFeeBps === 'number' ? capFeeBps : ((runtime as any)?.fees?.trading?.takerBps ?? 0), feeSource: typeof capFeeBps === 'number' ? 'clob_fee_rate' : ((runtime as any)?.fees?.source ?? 'config') },
            });
            await (repo as any).clearMarketCooldowns(agent.id, target.marketId);
            didReplacementSell = true;
            // refresh capacity and open list
            openNow = (await (repo as any).listOpenPositions(agent.id)).filter((p: any) => p.quantity >= minQtyCap);
            atCap = openNow.length >= (agent.execution.maxOpenPositions ?? Number.MAX_SAFE_INTEGER);
          } else {
            await (repo as any).recordPlanDecision({
              evaluationId: c.evalId,
              agentId: agent.id,
              marketId: c.market.id,
              outcomeId: c.decision.outcomeId,
              status: 'rejected',
              reason: `balance=0: requested replacement ${replaceOutcomeIdB0} not in open positions` ,
              createdAt: new Date(),
            });
            continue;
          }
        }
      }
      if (atCap && !alreadyOpen && !didReplacementSell) {
        const replaceOutcomeId = (c.decision as any).replaceOutcomeId as string | undefined;
        if (replaceOutcomeId && typeof replaceOutcomeId === 'string') {
          const target = openNow.find((p: any) => p.optionId === replaceOutcomeId);
          if (target) {
            // Fetch bestBid for target to execute sell
            let exitPrice: number | undefined;
            try {
              const tokenId = typeof target.optionId === 'string' && /^\d+$/.test(target.optionId) ? target.optionId : undefined;
              const ob = tokenId ? await polymarket.getOrderBook(tokenId) : undefined;
              exitPrice = ob?.bids?.[0]?.price;
            } catch {}
            const ep2 = typeof exitPrice === 'number' ? exitPrice : target.averagePrice; // conservative fallback
            const fullNotional = ep2 * target.quantity;
            // Record acceptance for replacement
            await (repo as any).recordPlanDecision({
              evaluationId: c.evalId,
              agentId: agent.id,
              marketId: target.marketId,
              outcomeId: target.optionId,
              status: 'accepted',
              reason: `capacity: replace L=${target.optionId} to free slot for N=${c.decision.outcomeId}`,
              createdAt: new Date(),
            });
            const sellId = await (repo as any).recordTradeInstruction({
              evaluationId: c.evalId,
              agentId: agent.id,
              marketId: target.marketId,
              optionId: target.optionId,
              direction: 'sell',
              notional: fullNotional,
              expectedPrice: ep2,
              reason: `capacity replacement: close ${target.optionId} @~${ep2.toFixed(3)} notional=${fullNotional.toFixed(2)}`,
              createdAt: new Date(),
            });
            // Resolve live fee bps for sell leg when available
            let capFeeBps: number | undefined;
            try {
              const tokenId = typeof target.optionId === 'string' && /^\d+$/.test(target.optionId) ? target.optionId : undefined;
              capFeeBps = tokenId ? await polymarket.getFeeRateBps(tokenId) : undefined;
            } catch {}
            portfolio.executeTrade({
              tradeInstructionId: sellId,
              marketId: target.marketId,
              optionId: target.optionId,
              direction: 'sell',
              price: ep2,
              notional: fullNotional,
              metadata: { feeBps: typeof capFeeBps === 'number' ? capFeeBps : ((runtime as any)?.fees?.trading?.takerBps ?? 0), feeSource: typeof capFeeBps === 'number' ? 'clob_fee_rate' : ((runtime as any)?.fees?.source ?? 'config') },
            });
            await (repo as any).clearMarketCooldowns(agent.id, target.marketId);
          } else {
            // Replacement target not found; reject this candidate
            await (repo as any).recordPlanDecision({
              evaluationId: c.evalId,
              agentId: agent.id,
              marketId: c.market.id,
              outcomeId: c.decision.outcomeId,
              status: 'rejected',
              reason: `capacity: requested replacement ${replaceOutcomeId} not in open positions` ,
              createdAt: new Date(),
            });
            continue;
          }
        } else {
          // No replacement suggested by AI; reject due to cap
          await (repo as any).recordPlanDecision({
            evaluationId: c.evalId,
            agentId: agent.id,
            marketId: c.market.id,
            outcomeId: c.decision.outcomeId,
            status: 'rejected',
            reason: 'capacity: maxOpenPositions reached; no replacement proposed',
            createdAt: new Date(),
          });
          // Optional: set a short cooldown on planner rejections
          if (postDecisionCooldownMinutes > 0) {
            const expires = schedulePostDecisionCooldown();
            if (expires) {
              await (repo as any).upsertMarketCooldown({
                agentId: agent.id,
                marketId: c.market.id,
                reason: 'planner:rejected',
                expiresAt: expires,
              });
            }
          }
          continue;
        }
      }

      // Fetch live taker fee bps for planner friction when available
      let takerFeeBpsPlan: number | undefined;
      try {
        const sel = c.market.outcomes.find((o) => o.id === c.decision.outcomeId);
        const tokenId = sel && (sel as any).clobTokenId && /^\d+$/.test((sel as any).clobTokenId) ? (sel as any).clobTokenId as string : undefined;
        takerFeeBpsPlan = tokenId ? await polymarket.getFeeRateBps(tokenId) : undefined;
      } catch {}

      if (((runtime as any)?.fees?.requireLiveFeeRate === true) && typeof takerFeeBpsPlan !== 'number') {
        await (repo as any).recordPlanDecision({
          evaluationId: c.evalId,
          agentId: agent.id,
          marketId: c.market.id,
          outcomeId: c.decision.outcomeId,
          status: 'rejected',
          reason: 'planner: fee_rate_unavailable',
          createdAt: new Date()
        });
        log('Plan rejected', { marketId: c.market.id, reason: 'fee_rate_unavailable' });
        continue;
      }

      let plan = planTrade({
        evaluationId: c.evalId,
        agentId: agent.id,
        market: c.market,
        runtime,
        portfolio,
        decision: {
          outcomeId: c.decision.outcomeId!,
          subjectiveProb: c.decision.subjectiveProb,
          maxPayPrice: c.decision.maxPayPrice,
          edgeBps: c.decision.edgeBps,
          priceBasis: c.decision.priceBasis,
          spendPct: c.decision.spendPct,
          tpPct: c.decision.tpPct,
          slPct: c.decision.slPct,
          direction: (c.decision as any).direction as any,
          takerFeeBps: takerFeeBpsPlan,
        },
      });
      if (!plan.instruction) {
        // Record gating rejection reason for observability (concise reason; full details in debug_json)
        const rejectionSummary =
          plan.rejected?.summary ??
          plan.rejectedReason ??
          'Reject: planner returned no instruction';
        await (repo as any).recordPlanDecision({
          evaluationId: c.evalId,
          agentId: agent.id,
          marketId: c.market.id,
          outcomeId: c.decision.outcomeId,
          status: "rejected",
          reason: rejectionSummary,
          debug: {
            stage: 'planner',
            rejected: plan.rejected ?? { code: 'unknown', summary: rejectionSummary, details: undefined },
            decisionMeta: {
              outcomeId: c.decision.outcomeId,
              subjectiveProb: c.decision.subjectiveProb ?? null,
              maxPayPrice: c.decision.maxPayPrice ?? null,
              edgeBps: c.decision.edgeBps ?? null,
              priceBasis: c.decision.priceBasis ?? null,
              spendPct: (c.decision as any).spendPct ?? null,
              tpPct: (c.decision as any).tpPct ?? null,
              slPct: (c.decision as any).slPct ?? null,
              direction: ((c.decision as any).direction ?? 'buy') as string,
              takerFeeBps: (c.decision as any).takerFeeBps ?? null,
            },
          },
          createdAt: new Date(),
        });
        if (postDecisionCooldownMinutes > 0) {
          const expires = schedulePostDecisionCooldown();
          if (expires) {
            await (repo as any).upsertMarketCooldown({
              agentId: agent.id,
              marketId: c.market.id,
              reason: "planner:rejected",
              expiresAt: expires,
            });
          }
        }
        log("Plan rejected", {
          marketId: c.market.id,
          reason: rejectionSummary,
        });
        continue;
      }
      await (repo as any).recordPlanDecision({
        evaluationId: c.evalId,
        agentId: agent.id,
        marketId: c.market.id,
        outcomeId: plan.instruction.optionId,
        status: "accepted",
        reason: `Gates passed; meta[outcomeId=${c.decision.outcomeId}, prob=${c.decision.subjectiveProb ?? "n/a"}, maxPay=${c.decision.maxPayPrice ?? "n/a"}, edgeBps=${c.decision.edgeBps ?? "n/a"}, basis=${c.decision.priceBasis ?? "n/a"}]`,
        tradeRationale: (c.decision as any).tradeRationale ?? undefined,
        citations: Array.isArray((c.decision as any).citations) ? (c.decision as any).citations : undefined,
        createdAt: new Date(),
      });
      if (postDecisionCooldownMinutes > 0) {
        await (repo as any).clearMarketCooldowns(agent.id, c.market.id, "planner:rejected");
      }
      // Keep instruction.reason as returned by planner (numeric/gates/meta for SHOW DECISIONS)
      const instruction = { ...plan.instruction } as NonNullable<typeof plan.instruction>;

      const tradeId = await (repo as any).recordTradeInstruction(instruction);

      // immediate execution strategy: simulate fill at expectedPrice
      // Fee policy: fetch CLOB fee-rate for both buys and sells; fallback to config only if unavailable.
      let feeBps: number | undefined;
      try {
        const tokenId = typeof instruction.optionId === 'string' && /^\d+$/.test(instruction.optionId) ? instruction.optionId : undefined;
        feeBps = tokenId ? await polymarket.getFeeRateBps(tokenId) : undefined;
      } catch {}
      const feeSource = typeof feeBps === 'number' ? 'clob_fee_rate' : ((runtime as any)?.fees?.source ?? 'config');
      const effectiveFeeBps = typeof feeBps === 'number' ? feeBps : ((runtime as any)?.fees?.trading?.takerBps ?? 0);

      if (paperMode) {
        const fill = portfolio.executeTrade({
          tradeInstructionId: tradeId,
          marketId: c.market.id,
          optionId: instruction.optionId,
          direction: instruction.direction,
          price: instruction.expectedPrice ?? 0.5,
          notional: instruction.notional,
          reservationId: plan.reservationId,
          metadata: { feeBps: effectiveFeeBps, feeSource },
        });
        // Any fill clears all suppression to allow re-entry
        await (repo as any).clearMarketCooldowns(agent.id, c.market.id);
        const so = c.market.outcomes.find((o) => o.id === instruction.optionId);
        log("Executed paper trade", {
          tradeInstructionId: tradeId,
          marketId: c.market.id,
          marketTitle: c.market.question,
          optionId: instruction.optionId,
          outcomeName: so?.name,
          price: instruction.expectedPrice ?? 0.5,
          notional: instruction.notional,
          quantity: fill.quantity,
          pnl: fill.pnl,
        });
      } else if (liveTrading) {
        // Serialize submissions with a small random jitter
        const liveCfg = ((runtime as any)?.execution?.live ?? {}) as { submitJitterMs?: { min?: number; max?: number }; dryRun?: boolean };
        const min = Math.max(0, Number(liveCfg.submitJitterMs?.min ?? 100));
        const max = Math.max(min, Number(liveCfg.submitJitterMs?.max ?? 400));
        const jitter = min + Math.floor(Math.random() * (max - min + 1));
        if (jitter > 0) await new Promise((r) => setTimeout(r, jitter));

        // Only proceed when we have a numeric token id (CLOB)
        const tokenIdOk = typeof instruction.optionId === 'string' && /^\d+$/.test(instruction.optionId);
        if (!tokenIdOk) {
          log('Live submit skipped: non-numeric tokenId', {
            marketId: c.market.id,
            optionId: instruction.optionId,
          });
        } else {
          const tokenIdStr = String(instruction.optionId);
          const minQtyShares = Math.max(
            0,
            (runtime as any)?.ui?.minOpenQuantity ?? 0.01,
          );
          try {
            const res = await submitLiveOrderWithPreflight({
              agentId: agent.id,
              agent,
              runtime,
              polymarket,
              liveTrading,
              marketId: c.market.id,
              optionId: instruction.optionId,
              side:
                instruction.direction === 'sell' ? 'sell' : 'buy',
              tokenId: tokenIdStr,
              notional: instruction.notional,
              expectedPrice: instruction.expectedPrice ?? 0.5,
              minQty:
                instruction.direction === 'sell'
                  ? minQtyShares
                  : undefined,
              log,
            });

            if (plan.reservationId && (portfolio as any).release) {
              try {
                (portfolio as any).release(plan.reservationId);
              } catch {}
            }

            if (res.orderId) {
              try {
                await (repo as any).setTradeInstructionLiveInfo(
                  tradeId,
                  {
                    orderId: res.orderId,
                    status: res.dryRun
                      ? 'dry_run'
                      : res.posted
                        ? 'open'
                        : 'failed',
                    updatedAt: new Date(),
                  },
                );
              } catch {}
            } else {
              const formattedError = formatLiveOrderError(
                res.error ?? "live_order_not_posted",
                res.debug,
              );
              try {
                await (repo as any).setTradeInstructionLiveInfo(
                  tradeId,
                  {
                    status: 'failed',
                    error: formattedError ?? res.error ?? 'live_order_not_posted',
                    updatedAt: new Date(),
                  },
                );
              } catch {}
            }

            await (repo as any).clearMarketCooldowns(
              agent.id,
              c.market.id,
            );
            const so2 = c.market.outcomes.find(
              (o) => o.id === instruction.optionId,
            );
            log(
              res.posted && res.orderId
                ? 'Submitted live order'
                : res.dryRun
                  ? 'Built live order (dry-run)'
                  : 'Live order rejected',
              {
                tradeInstructionId: tradeId,
                marketId: c.market.id,
                marketTitle: c.market.question,
                optionId: instruction.optionId,
                outcomeName: so2?.name,
                notional: res.notional,
                expectedPrice: instruction.expectedPrice ?? 0.5,
                orderId: res.orderId ?? undefined,
              },
            );
          } catch (e) {
            if (plan.reservationId && (portfolio as any).release) {
              try {
                (portfolio as any).release(plan.reservationId);
              } catch {}
            }
            log('Live order submission failed', {
              marketId: c.market.id,
              error: (e as Error).message,
            });
          }
        }
      }
    }

    await (repo as any).completeRun(runId, "completed", new Date());
    const snapshot =
      (await (portfolio as any).snapshot?.()) ??
      (portfolio as any).snapshot();
    log("Run complete. Portfolio snapshot", snapshot);
  } catch (err) {
    await (repo as any).completeRun(runId, "failed", new Date());
    log("Run failed", { error: (err as Error).message });
    throw err;
  } finally {
    try {
      if (db) closeDatabase(db);
    } catch {}
    log("Agent cycle end", {
      agent: agent.id,
      runId,
      mode: paperMode ? "paper" : "live",
      sessionId: options.sessionId,
    });
  }
}

export interface SchedulerOptions extends RunOnceOptions {}

// Deprecated single-loop scheduler removed; use runAgentWithDualLoops instead.

export async function runMonitorOnce(options: RunOnceOptions = {}) {
  const baseDir = options.baseDir ?? process.cwd();
  const log =
    options.log ??
    ((m: string, d?: unknown) => {
      if (d !== undefined) console.log(m, d);
      else console.log(m);
    });

  const runtime = await loadRuntimeConfig(baseDir);
  const agentsConfig = await loadAgentsConfig(baseDir);
  const agent = agentsConfig.agents.find(
    (a) => a.enabled && (!options.agentId || a.id === options.agentId),
  );
  if (!agent) throw new Error("No enabled agent found");

  // Clients
  const http = options.inject?.http ?? createHttpClient(runtime.http as any);
  const clobOv2 = (runtime.http as any)?.hostOverrides?.['clob.polymarket.com'] ?? {};
  const enablePolyLogs = Boolean((runtime as any)?.logging?.verbose?.providers?.polymarket ?? false);
  const polymarket = options.inject?.polymarket ?? createPolymarketClient({ httpClient: http, marketConfig: runtime.marketData, memoize: { orderBookTtlMs: (runtime.http as any)?.memoize?.clobOrderBookTtlMs, feeRateTtlMs: (runtime.http as any)?.memoize?.clobFeeRateTtlMs }, concurrency: { maxConcurrent: clobOv2?.maxConcurrent }, logger: enablePolyLogs ? log : undefined });

  

  const modelApiKey = process.env.OPENROUTER_API_KEY;
  if (!modelApiKey)
    throw new Error("Missing OPENROUTER_API_KEY for LLM decisions");
  const openrouter =
    options.inject?.openrouter ??
    createOpenRouterClient({
      httpClient: http,
      apiKey: modelApiKey,
      defaultModel: agent.model,
      researchProfiles: runtime.researchProfiles,
    });

  const paperMode3 = agent.paperTrading !== false;
  let repo: any;
  let db: any | undefined;
  if (paperMode3) {
    const dbFilePath = options.dbFilePath ?? process.env.PAPER_DB_FILE;
    db = openDatabase(dbFilePath ? { filePath: dbFilePath } : { inMemory: true });
    initializeSchema(db);
    repo = new AgentRepository(db);
  } else {
    const driver = String(process.env.DB_DRIVER || '').toLowerCase();
    if (driver !== 'postgres' && driver !== 'pg') {
      throw new Error('Live mode requires Postgres. Set DB_DRIVER=postgres and provide DATABASE_URL. SQLite is not supported in production.');
    }
    repo = await getAsyncRepository();
  }

  // Optional live CLOB client for monitor in live mode
  const liveTrading =
    !paperMode3 && agent.paperTrading === false
      ? createClobClientForAgent(agent as any)
      : undefined;

  try {
    let portfolio: any;
    if (paperMode3) {
      portfolio = new PortfolioManager(repo, {
        agentId: agent.id,
        initialBalance: runtime.portfolio.initialBalance,
        baseCurrency: runtime.portfolio.baseCurrency,
      });
    }

    // Minimal live→DB sync so monitor sees live opens; then seed live portfolio
    if (agent.paperTrading === false) {
      if (!liveTrading) {
        throw new Error('Live trading client unavailable');
      }
      try {
        await syncLivePositionsFromSnapshot({
          agent: agent as any,
          runtime: runtime as any,
          repo,
          log,
        });
      } catch (e) {
        (log ?? console.error)('Live position sync (monitor) skipped', {
          error: (e as Error).message,
        });
      }
      const state = await (repo as any).getPortfolioState(
        agent.id,
        runtime.portfolio.baseCurrency,
        runtime.portfolio.initialBalance,
      );
      const seedPositions = await (repo as any).listOpenPositions(agent.id);
      portfolio = new PortfolioManagerLive({
        agentId: agent.id,
        baseCurrency: runtime.portfolio.baseCurrency,
        initialCash: state.cashBalance,
        seedPositions,
      });
    }

	    await runMonitorTick({
	      agentId: agent.id,
	      runtime,
	      repo,
	      portfolio,
	      polymarket,
	      openrouter,
	      log,
	      agent,
	      liveTrading,
	    });
  } finally {
    try { if (db) closeDatabase(db); } catch {}
  }
}

export function runAgentWithDualLoops({
  baseDir,
  agentId,
  log,
  dbFilePath,
}: SchedulerOptions) {
  let active = true;
  let busy = false;

  const scheduleDiscovery = async () => {
    if (!active) return;
    const runtime = await loadRuntimeConfig(baseDir ?? process.cwd());
    const intervalMinutes =
      Math.max(1 / 60, runtime.polling.positionMonitorIntervalMinutes);
    const intervalMs = intervalMinutes * 60 * 1000;
    setTimeout(async () => {
      if (!active) return;
      if (busy) return scheduleDiscovery();
      busy = true;
      try {
        await runAgentOnce({ baseDir, agentId, log, dbFilePath });
      } catch (e) {
        (log ?? console.error)("Discovery tick error", {
          error: (e as Error).message,
        });
      } finally {
        busy = false;
        scheduleDiscovery();
      }
    }, intervalMs);
  };

  // Fire immediate ticks, then schedule next ticks
  (async () => {
    if (!active) return;
    try {
      busy = true;
      await runAgentOnce({ baseDir, agentId, log, dbFilePath });
    } catch (e) {
      (log ?? console.error)("Discovery tick error", {
        error: (e as Error).message,
      });
    } finally {
      busy = false;
      scheduleDiscovery();
    }
  })();

  return () => {
    active = false;
  };
}
