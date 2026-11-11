import { createHash } from "node:crypto";
import type { OpenRouterClient } from "../../clients/openrouter";
import type { MarketEvaluationInsert } from "../types";
import {
  buildDecisionPrompt,
  type DecisionPromptInput,
} from "../../prompts/decision";

export type DecisionInput = DecisionPromptInput;

export interface DecisionResult {
  evaluation: MarketEvaluationInsert;
  confidence?: number;
  // Extras produced by the LLM when trade=true
  marketId?: string;
  outcomeId?: string;
  subjectiveProb?: number; // 0..1
  maxPayPrice?: number; // 0..1
  edgeBps?: number; // computed vs chosen price basis
  priceBasis?: "ask" | "mid" | "snapshot";
  spendPct?: number; // 0..1
  tpPct?: number | null;
  slPct?: number | null;
  // Optional: replacement target outcome when at capacity (close this fully)
  replaceOutcomeId?: string;
  trades?: Array<{
    marketId: string;
    outcomeId: string;
    maxPayPrice?: number;
    spendPct?: number;
    direction?: "buy" | "sell";
  }>;
  tradeRationale?: string;
  debugAiInput?: unknown;
  debugAiOutput?: unknown;
  promptHash: string;
  // Classification of model output validity
  parsedOk?: boolean;
  parseError?: string;
  // URLs extracted from OpenRouter Responses annotations (web search plugin)
  citations?: string[];
  evidence?: any[];
  guards?: any;
}

function safeParseJson(content: string): any {
  try {
    if (!content) return {};
    // Prefer fenced JSON blocks if present
    const fenceIdx = content.indexOf("```json");
    if (fenceIdx >= 0) {
      const rest = content.slice(fenceIdx + 7);
      const endFence = rest.indexOf("```");
      const block = endFence >= 0 ? rest.slice(0, endFence) : rest;
      return JSON.parse(block.trim());
    }
    // Fallback: slice from first { to last }
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const json = content.slice(start, end + 1);
      return JSON.parse(json);
    }
    return {};
  } catch {
    // Last resort: try to remove trailing commas
    try {
      const cleaned = content
        .replace(/,\s*}/g, "}")
        .replace(/,\s*]/g, "]");
      const start = cleaned.indexOf("{");
      const end = cleaned.lastIndexOf("}");
      if (start >= 0 && end > start) {
        return JSON.parse(cleaned.slice(start, end + 1));
      }
    } catch {}
    return {};
  }
}

export async function evaluateMarket(
  llm: OpenRouterClient,
  input: DecisionInput,
): Promise<DecisionResult> {
  const { system, user, rows, edgeThreshold, floor, ceiling, focusOutcomeIds } =
    buildDecisionPrompt(input);
  const isDeepPhase = input.phase === "deep";
  // Deep phase must always be called with the quick-phase decision context
  if (isDeepPhase && !input.quickDecision) {
    throw new Error(
      "evaluateMarket(deep): missing quickDecision context from quick phase",
    );
  }
  const promptHash = createHash("sha256").update(system).digest("hex");
  const completions: Array<{ content: string }> = [];
  const useWebMax = ((): number => {
    const w = (input.runtime as any)?.research?.webSearch as
      | { quickMaxResults?: number; deepMaxResults?: number }
      | undefined;
    const q = Number(w?.quickMaxResults ?? 6);
    const d = Number(w?.deepMaxResults ?? 8);
    return input.phase === "deep"
      ? Math.max(1, Math.min(15, d))
      : Math.max(1, Math.min(15, q));
  })();
  const excludeLineUser = (() => {
    const ex = (((input.runtime as any)?.research as any)?.webSearch as any)
      ?.excludeDomains as string[] | undefined;
    const list = Array.isArray(ex) && ex.length ? ex.join(", ") : "";
    return list
      ? `You MUST exclude -site: ${list} for any search queries or resources in your research/analysis/citations/annotations as they are not regarded as independent/external/objective sources.`
      : "";
  })();
  const userWithPolicy = excludeLineUser
    ? `${user}\n\n${excludeLineUser}`
    : user;

  const profileCfg =
    (input.runtime.researchProfiles as any)?.[input.profile]?.openrouter ?? {};
  const pluginMaxOut = Number(profileCfg?.maxTokens ?? 1024);
  const plugin = {
    id: "web",
    engine: "exa",
    max_results: useWebMax,
    max_output_tokens: pluginMaxOut,
    search_prompt: `Do at most ${useWebMax} search for only the most latest, relevant and accurate results.`,
  } as const;

  const runCompletion = async (sys: string, usr: string) => {
    const result = await llm.complete({
      messages: [
        { role: "system", content: sys },
        { role: "user", content: usr },
      ],
      profile: input.profile,
      plugins: [plugin],
    });
    completions.push({ content: result.content });
    return result;
  };
  let completion = await runCompletion(system, userWithPolicy);

  const normalizeOutput = (payload: any) => {
    if (!payload || typeof payload !== "object") return;
    const legsArr = Array.isArray(payload.legs)
      ? (payload.legs as any[]).filter(Boolean)
      : [];
    const primary = legsArr[0];
    if (primary) {
      if (payload.marketId == null && typeof primary.marketId === "string")
        payload.marketId = primary.marketId;
      if (payload.marketId == null && typeof primary.market === "string")
        payload.marketId = primary.market;
      if (payload.outcomeId == null && typeof primary.outcomeId === "string")
        payload.outcomeId = primary.outcomeId;
      if (
        payload.subjectiveProb == null &&
        typeof primary.subjectiveProb === "number"
      )
        payload.subjectiveProb = primary.subjectiveProb;
      if (
        payload.maxPayPrice == null &&
        typeof primary.maxPayPrice === "number"
      )
        payload.maxPayPrice = primary.maxPayPrice;
      if (payload.spendPct == null && typeof primary.spendPct === "number")
        payload.spendPct = primary.spendPct;
      if (payload.priceBasis == null && typeof primary.priceBasis === "string")
        payload.priceBasis = primary.priceBasis;
    }
    if (!payload.trades && legsArr.length && input.phase === "deep") {
      payload.trades = legsArr
        .map((leg) => {
          const marketCandidate =
            typeof leg.marketId === "string"
              ? String(leg.marketId)
              : input.market.id;
          const outcomeCandidate =
            typeof leg.outcomeId === "string" ? String(leg.outcomeId) : null;
          if (!outcomeCandidate) return undefined;
          const maxPay =
            typeof leg.maxPayPrice === "number"
              ? Number(leg.maxPayPrice)
              : undefined;
          const spend =
            typeof leg.spendPct === "number"
              ? Math.max(0, Math.min(1, Number(leg.spendPct)))
              : undefined;
          const directionRaw =
            typeof leg.direction === "string"
              ? leg.direction
              : typeof leg.side === "string"
                ? leg.side
                : undefined;
          const direction = directionRaw
            ? directionRaw.toLowerCase().startsWith("s")
              ? "sell"
              : "buy"
            : undefined;
          return {
            marketId: marketCandidate,
            outcomeId: outcomeCandidate,
            maxPayPrice: maxPay,
            spendPct: spend,
            direction,
          };
        })
        .filter(Boolean);
    }
    if (payload.guards == null && payload.guardrails != null) payload.guards = payload.guardrails;
  };

  let parsed = safeParseJson(completion.content);
  normalizeOutput(parsed);
  const baseValid = (p: any) =>
    typeof p.trade === "boolean" &&
    typeof p.rationale === "string" &&
    p.rationale.trim().length >= 8;

  const finalValidExtras = (p: any) => {
    if (!p || typeof p !== "object") return false;
    if (input.phase !== "deep") return true;
    if (p.trade !== true) return true;
    if (typeof p.spendPct !== "number" || !Number.isFinite(p.spendPct)) return false;
    const guards = (p as any).guards;
    if (!guards || typeof guards !== "object") return false;
    if (typeof guards.momentumSpike !== "boolean") return false;
    if (guards.momentumSpike === true) return false;
    if (typeof guards.evidenceQuality !== "string" || !guards.evidenceQuality.trim()) return false;
    if (typeof guards.multiCandidateChecked !== "boolean") return false;
    if (Array.isArray((p as any).trades)) {
      for (const leg of (p as any).trades) {
        if (!leg || typeof leg !== "object") continue;
        const directionRaw = typeof leg.direction === "string" ? leg.direction : undefined;
        const direction = directionRaw ? (directionRaw.toLowerCase().startsWith("s") ? "sell" : "buy") : "buy";
        if (direction === "buy") {
          if (typeof leg.spendPct !== "number" || !Number.isFinite(leg.spendPct)) return false;
        }
      }
    }
    return true;
  };

  const quickTrade =
    isDeepPhase && input.quickDecision?.trade === true;

  let parsedOk: boolean | undefined = undefined;
  let parseError: string | undefined = undefined;
  if (!baseValid(parsed)) {
    // One-shot repair attempt with stricter instruction
    const repairSystem = `Return STRICT JSON only with keys ${
      input.phase === "deep"
        ? "{trade:boolean, outcomeId:string, subjectiveProb:number, maxPayPrice:number, spendPct:number, tpPct:number|null, slPct:number|null, rationale:string, riskNotes:string|null, replaceOutcomeId:string|null, evidence?:Array, guards?:Object, trades?:Array}"
        : "{trade:boolean, outcomeId:string, subjectiveProb:number, maxPayPrice:number, rationale:string, riskNotes:string|null, evidence?:Array, guards?:Object}"
    }.
If trade=true in quick, outcomeId MUST be one from the Outcomes (THIS market only). If trade=false, omit optional fields.`;
    completion = await runCompletion(repairSystem, userWithPolicy);
    parsed = safeParseJson(completion.content);
    normalizeOutput(parsed);
    if (!baseValid(parsed)) {
      parsedOk = false;
      parseError = "parse_error";
    }
  }

  const ensureSchemaFields = async (reason: string) => {
    const requiredKeys =
      input.phase === "deep"
        ? "outcomeId, subjectiveProb"
        : "outcomeId, subjectiveProb";
    const requiredShape =
      input.phase === "deep"
        ? "{trade:boolean, outcomeId:string, subjectiveProb:number, maxPayPrice:number, spendPct:number, tpPct:number|null, slPct:number|null, rationale:string, riskNotes:string|null, replaceOutcomeId:string|null, evidence?:Array, guards?:Object, trades?:Array}"
        : "{trade:boolean, outcomeId:string, subjectiveProb:number, maxPayPrice:number, rationale:string, riskNotes:string|null, evidence?:Array, guards?:Object}";
    const repairSystem = `Your previous JSON reply was invalid (${reason}). Return STRICT JSON with keys ${requiredShape}.
If trade=true in quick, outcomeId MUST be one from the Outcomes (THIS market only). Keep responses concise and within configured bounds.`;
    const repairCompletion = await runCompletion(repairSystem, userWithPolicy);
    completion = repairCompletion as any;
    parsed = safeParseJson((repairCompletion as any).content ?? "");
    normalizeOutput(parsed);
  };

  // Enforce bounds and edge requirement when trade=true; otherwise fail-closed to no-trade.
  let marketId: string | undefined;
  let outcomeId: string | undefined;
  let subjectiveProb: number | undefined;
  let maxPayPrice: number | undefined;
  let priceBasis: "ask" | "mid" | "snapshot" | undefined;
  let spendPct: number | undefined;
  let tpPct: number | null | undefined;
  let slPct: number | null | undefined;
  let replaceOutcomeId: string | undefined;
  let edgeBps: number | undefined;

  // Deep phase can veto the quick trade, but must never "revive" a quick no-trade.
  let trade = isDeepPhase ? Boolean(quickTrade && parsed.trade === true) : Boolean(parsed.trade);
  let rationale = baseValid(parsed)
    ? (parsed.rationale as string)
    : "Insufficient model rationale; conservative no-trade.";
  let riskNotes =
    parsed.riskNotes ??
    (!baseValid(parsed)
      ? "Model output invalid or empty; defaulting to safe stance."
      : undefined);

  const tradeShapeValid = (p: any) => {
    if (!p) return false;
    const hasOutcome =
      typeof p.outcomeId === "string" && p.outcomeId.trim().length > 0;
    const inFocus =
      hasOutcome && (!input.phase || input.phase !== "deep")
        ? focusOutcomeIds.has(String(p.outcomeId))
        : true;
    const hasProb =
      typeof p.subjectiveProb === "number" &&
      p.subjectiveProb >= 0 &&
      p.subjectiveProb <= 1;
    return hasOutcome && inFocus && hasProb;
  };

  if (trade && !(tradeShapeValid(parsed) && finalValidExtras(parsed))) {
    if (input.phase === "deep" && (parsed as any)?.guards?.momentumSpike === true) {
      trade = false;
      riskNotes = "Momentum spike guard triggered (near-high + extreme recent move); conservative trade=false.";
    }
  }

  if (trade && !(tradeShapeValid(parsed) && finalValidExtras(parsed))) {
    const missing: string[] = [];
    const outc =
      typeof parsed.outcomeId === "string" && parsed.outcomeId.trim().length > 0
        ? String(parsed.outcomeId)
        : undefined;
    if (!outc) missing.push("outcomeId");
    if (input.phase !== "deep" && outc && !focusOutcomeIds.has(outc))
      missing.push("outcomeId_not_in_this_market");
    if (typeof parsed.subjectiveProb !== "number")
      missing.push("subjectiveProb");
    if (typeof (parsed as any).maxPayPrice !== "number") missing.push("maxPayPrice");
    if (input.phase === "deep") {
      if (typeof (parsed as any).spendPct !== "number") missing.push("spendPct");
      const guards = (parsed as any).guards;
      if (!guards || typeof guards !== "object") missing.push("guards");
      else {
        if (typeof guards.momentumSpike !== "boolean") missing.push("guards.momentumSpike");
        if (typeof guards.evidenceQuality !== "string") missing.push("guards.evidenceQuality");
        if (typeof guards.multiCandidateChecked !== "boolean") missing.push("guards.multiCandidateChecked");
      }
    }
    if (missing.length > 0) {
      try {
        await ensureSchemaFields(`missing keys: ${missing.join(", ")}`);
      } catch {
        // fall through; trade flag will be cleared below if still invalid
      }
    }
    if (!(tradeShapeValid(parsed) && finalValidExtras(parsed))) {
      trade = false;
      riskNotes =
        input.phase === "deep"
          ? "Model output missing required fields or violated guardrails; conservative trade=false."
          : "Model output missing required fields or invalid outcomeId for this market; conservative trade=false.";
    }
  }

  if (trade) {
    // price ceiling guard from config
    if (
      typeof parsed.maxPayPrice === "number" &&
      parsed.maxPayPrice > ceiling
    ) {
      parsed.maxPayPrice = ceiling;
    }
    marketId = String(parsed.marketId ?? input.market.id);
    outcomeId = String(parsed.outcomeId);
    subjectiveProb =
      typeof parsed.subjectiveProb === "number"
        ? Number(parsed.subjectiveProb)
        : undefined;
    maxPayPrice = typeof (parsed as any).maxPayPrice === "number" ? Number((parsed as any).maxPayPrice) : undefined;
    if (input.phase === "deep") {
      if (typeof parsed.spendPct === "number")
        spendPct = Math.max(0, Math.min(1, Number(parsed.spendPct)));
      tpPct =
        typeof parsed.tpPct === "number"
          ? Math.max(0, Math.min(1, Number(parsed.tpPct)))
          : null;
      slPct =
        typeof parsed.slPct === "number"
          ? Math.max(0, Math.min(1, Number(parsed.slPct)))
          : null;
      if (
        parsed.replaceOutcomeId &&
        typeof parsed.replaceOutcomeId === "string" &&
        parsed.replaceOutcomeId.trim().length > 0
      ) {
        replaceOutcomeId = String(parsed.replaceOutcomeId);
      }
    }

    // Derive a price basis for edge computation (prefer ask, then mid, then snapshot)
    const row = rows.find((r) => r.id === outcomeId);
    const basisVal = (():
      | { v: number; name: "ask" | "mid" | "snapshot" }
      | undefined => {
      if (typeof row?.bestAsk === "number")
        return { v: row.bestAsk!, name: "ask" };
      if (typeof row?.mid === "number") return { v: row.mid!, name: "mid" };
      if (typeof row?.snapshotPrice === "number")
        return { v: row.snapshotPrice!, name: "snapshot" };
      return undefined;
    })();
    if (basisVal) {
      // Enforce entry floor pre-planner to avoid futile plans
      if (basisVal.v < floor) {
        trade = false;
        riskNotes = `Chosen basis ${basisVal.v.toFixed(3)} below entry floor ${floor}`;
      }
      priceBasis = basisVal.name;
      const ttlMinutes = row?.ttlMinutes ?? null;
      const allowEndgame =
        typeof ttlMinutes === "number" &&
        ttlMinutes >= 0 &&
        ttlMinutes <= 96 * 60 &&
        basisVal.name === "ask" &&
        basisVal.v >= 0.95;
      let edgeBpsLocal: number | undefined;
      if (typeof subjectiveProb === "number") {
        edgeBpsLocal = Math.round((subjectiveProb - basisVal.v) * 10000);
      } else if (allowEndgame) {
        edgeBpsLocal = Math.round((1 - basisVal.v) * 10000);
      }
      if (!allowEndgame) {
        if (typeof edgeBpsLocal !== "number") {
          trade = false;
          riskNotes =
            "Model did not supply subjective probability; insufficient edge.";
        } else if (edgeBpsLocal < edgeThreshold) {
          trade = false;
          riskNotes = `Edge ${edgeBpsLocal}bps below min ${edgeThreshold}bps.`;
        }
      }
      edgeBps = edgeBpsLocal;
    } else {
      trade = false;
      riskNotes = "No price basis available to assess edge.";
    }
    // Respect floor/ceiling bounds
    if (
      trade &&
      (typeof maxPayPrice !== "number" ||
        maxPayPrice < floor ||
        maxPayPrice > ceiling)
    ) {
      trade = false;
      riskNotes = `maxPayPrice outside bounds [${floor}, ${ceiling}]`;
    }
  }


  const now = new Date();
  const debugEnabled =
    input.runtime.logging.verbose.ai && input.runtime.logging.sampleRate > 0;
  const takeSample =
    debugEnabled && Math.random() < (input.runtime.logging.sampleRate ?? 1);
  const debugAiInput =
    takeSample && !input.runtime.logging.redact.aiInput
      ? {
          system,
          user,
          rows,
          phase: input.phase ?? "quick",
          portfolio: input.portfolioContext,
          promptHash,
        }
      : undefined;
  const debugAiOutput =
    takeSample && !input.runtime.logging.redact.aiOutput
      ? completions.length > 1
        ? {
            attempts: completions.map((c, index) => ({
              attempt: index + 1,
              raw: c.content,
            })),
            parsed,
          }
        : { raw: (completion as any).content ?? "", parsed }
      : undefined;
  const evaluation: MarketEvaluationInsert = {
    runId: input.runId,
    agentId: input.agentId,
    marketId: input.market.id,
    title: input.market.question,
    outcomes: input.market.outcomes.map((o) => ({
      id: o.id,
      name: o.name,
      price: o.price,
    })),
    currentPrices: Object.fromEntries(
      input.market.outcomes.map((o) => [o.id, o.price]),
    ),
    quickResearchSummary: input.quickResearchSummary,
    trade,
    evaluationRationale: rationale,
    riskNotes,
    timestamp: now,
    debugMarketPayloadJson: rows,
    debugAiInputJson: debugAiInput,
    debugAiOutputJson: debugAiOutput,
    evaluationCitations: Array.isArray((completion as any)?.citations)
      ? ((completion as any).citations as string[]).filter(
          (u) => typeof u === "string",
        )
      : undefined,
  };

  // Optional multi-leg parsing for deep phase: accept trades[] while preserving single fields
  let trades: DecisionResult["trades"] = undefined;
  if (input.phase === "deep" && Array.isArray((parsed as any)?.trades)) {
    const arr = ((parsed as any).trades as any[]).filter(Boolean);
    const legs: NonNullable<DecisionResult["trades"]> = [];
    for (const t of arr) {
      const mid = String(t?.marketId ?? input.market.id);
      const oid =
        typeof t?.outcomeId === "string" ? String(t.outcomeId) : undefined;
      const mp =
        typeof t?.maxPayPrice === "number" ? Number(t.maxPayPrice) : undefined;
      const sp =
        typeof t?.spendPct === "number"
          ? Math.max(0, Math.min(1, Number(t.spendPct)))
          : undefined;
      const dirRaw = (t?.direction ?? t?.side) as string | undefined;
      const dir =
        dirRaw &&
        typeof dirRaw === "string" &&
        dirRaw.toLowerCase().startsWith("s")
          ? "sell"
          : undefined;
      if (oid)
        legs.push({
          marketId: mid,
          outcomeId: oid,
          maxPayPrice: mp,
          spendPct: sp,
          direction: dir,
        });
    }
    if (legs.length > 0) trades = legs;
  }
  if (trade && edgeBps === undefined && typeof subjectiveProb === "number") {
    const basis = rows.find((r) => r.id === outcomeId);
    const compare =
      priceBasis === "ask"
        ? basis?.bestAsk
        : priceBasis === "mid"
          ? basis?.mid
          : basis?.snapshotPrice;
    if (typeof compare === "number")
      edgeBps = Math.round((subjectiveProb - compare) * 10000);
  }

  return {
    evaluation,
    marketId,
    outcomeId,
    subjectiveProb,
    maxPayPrice,
    edgeBps,
    priceBasis,
    spendPct,
    tpPct,
    slPct,
    replaceOutcomeId,
    trades,
    evidence: Array.isArray((parsed as any)?.evidence) ? ((parsed as any).evidence as any[]).filter(Boolean) : undefined,
    guards: (parsed as any)?.guards,
    tradeRationale: rationale,
    debugAiInput,
    debugAiOutput,
    promptHash,
    parsedOk: parsedOk === undefined ? baseValid(parsed) : parsedOk,
    parseError,
    citations: Array.isArray((completion as any)?.citations)
      ? ((completion as any).citations as string[]).filter(
          (u) => typeof u === "string",
        )
      : undefined,
  };
}
