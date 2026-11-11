import type { RuntimeConfig } from '../config/schema';
import { finalizePromptSections, mergePromptSections, type PromptOverrides } from './utils';

export interface MonitorPromptInput {
  runtime: RuntimeConfig;
  marketId: string;
  marketTitle?: string;
  outcomeId: string;
  outcomeName?: string;
  position: {
    quantity: number;
    averagePrice: number;
    openedAt: Date | string;
  };
  latest: {
    bestBid?: number;
    bestAsk?: number;
    mid?: number;
  };
  liquidity: {
    bidTop: number;
    askTop: number;
    levels: number;
  };
  costs: {
    cost: number;
    theoreticalMaxGain: number;
    remainingBestCase: number;
  };
  entryRationale?: string;
  researchBrief?: string;
}

export function buildMonitorPrompt(input: MonitorPromptInput) {
  const { runtime } = input;
  const systemBlock = `You are a disciplined Polymarket trader monitoring an open position. Return STRICT JSON only.
	Schema: { "action": "hold|close|buy_more|reduce", "confidence": number, "rationale": string, "tpPct": number|null, "slPct": number|null, "adjustNotional": number|null }
Rule: If action="buy_more", you MUST set adjustNotional to the USDC notional you want to add (a positive number). If you cannot size it safely, return action="hold" instead.`;
  const excludeLine = (() => {
    const ex = (((runtime as any)?.research as any)?.webSearch as any)?.excludeDomains as
      | string[]
      | undefined;
    const list = Array.isArray(ex) && ex.length ? ex.join(', ') : '';
    return list
      ? `Web research policy: MUST exclude -site: ${list} for any search queries or resources in your research/analysis/citations/annotations as they are not regarded as independent/external/objective sources.`
      : '';
  })();
  const entrySnippet = (() => {
    const raw = (input.entryRationale ?? '').replace(/\s+/g, ' ').trim();
    return raw || 'n/a';
  })();
  const userBlock = `Market: ${input.marketTitle ?? input.marketId}
Outcome: ${input.outcomeName ?? input.outcomeId}
	Position: qty=${input.position.quantity.toFixed(4)}, avg=${input.position.averagePrice.toFixed(3)}, openedAt=${typeof input.position.openedAt === 'string' ? input.position.openedAt : input.position.openedAt.toISOString()}
	Latest: bid=${input.latest.bestBid ?? 'n/a'}, ask=${input.latest.bestAsk ?? 'n/a'}, mid=${input.latest.mid ?? 'n/a'}
	Liquidity: bidNotionalTopK=${input.liquidity.bidTop.toFixed(2)}, askNotionalTopK=${input.liquidity.askTop.toFixed(
	    2,
	  )} levels=${input.liquidity.levels}
	Costs & Payouts: cost≈${input.costs.cost.toFixed(2)} USDC, max_settlement_gain≈${input.costs.theoreticalMaxGain.toFixed(2)} USDC, remaining_best_case≈${input.costs.remainingBestCase.toFixed(2)} USDC
	Entry rationale: ${entrySnippet}
	Rules: Prefer hold unless clear catalyst or strong conviction. Do NOT close solely due to the natural bid/ask friction (marking to bid makes a fresh long look red).
	Use executable bid for exits/TP/SL and require a real catalyst or threshold breach.
	Capital-efficiency guidance: compute remaining_best_case in dollars and weigh it against how soon the market is likely to resolve and how locked-in the thesis is. If remaining_best_case is small but resolution appears soon / outcome effectively decided, prefer hold (or buy_more if still positive). If remaining_best_case is small and resolution appears far away or the thesis has degraded, recommend close/redeploy and show the math.
	Evidence rule: cite at least one fresh external source for macro/policy/election/regulation bets; if none exist, bias toward hold/reduce and say so.
	${excludeLine ? `${excludeLine}\n` : ''}
	Research (brief):\n${input.researchBrief ?? ''}
	Return JSON now:`;

  const overrides = runtime.prompts?.monitor as PromptOverrides | undefined;
  const merged = mergePromptSections({ system: [systemBlock], user: [userBlock] }, overrides);
  return finalizePromptSections(merged);
}
