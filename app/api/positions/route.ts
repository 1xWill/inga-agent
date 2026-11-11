import { NextRequest, NextResponse } from 'next/server';
import { getRepository } from '../_lib/db';
import { loadAgentsConfig, loadRuntimeConfig } from '../../../src/config/loaders';
import { getLiveAccountSnapshot } from '../../../src/server/liveAccount';
import { createHttpClient } from '../../../src/http/client';
import { deriveEffectiveTargets } from '../../../src/agent/pipeline/targets';
import { enrichMarketOutcomeLabels } from '../_lib/enrich';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const agentId = searchParams.get('agentId');
  const includeClosed = ['1','true','yes'].includes((searchParams.get('includeClosed') ?? '').toLowerCase());
  if (!agentId) return NextResponse.json({ error: 'agentId required' }, { status: 400 });
  const repo = await getRepository();

  // Use live positions when the agent is configured for live trading
  const runtime = await loadRuntimeConfig(process.cwd());
  const agents = await loadAgentsConfig(process.cwd());
  const ag = agents.agents.find((a) => a.id === agentId);
  let positions: Array<{ marketId: string; optionId: string; quantity: number; averagePrice: number; status: string; bestBid?: number; bestAsk?: number; updatedAt?: string; exitPrice?: number; realizedPnlForPosition?: number; tpPrice?: number; slPrice?: number }> = [];
  if (ag && ag.enabled && ag.paperTrading === false) {
    try {
      const live = await getLiveAccountSnapshot(ag as any, runtime, { tradesLimit: 300, includeOrders: false });
      // Persist closed rounds into closed_positions so positions/portfolios
      // can read recent closed history without rewalking trades.
      try {
        const closedRows =
          (live.closedPositions ?? []).map((p) => ({
            marketId: p.marketId,
            optionId: p.tokenId,
            quantity: p.quantity,
            averagePrice: p.averagePrice,
            exitPrice: p.exitPrice,
            realizedPnl: p.realizedPnlForPosition ?? 0,
            feesPaid: (p as any).feesPaid ?? 0,
            closedAt: p.closedAt,
          })) ?? [];
        if (closedRows.length > 0) {
          await repo.recordClosedPositions(agentId, closedRows);
        }
      } catch {
        // Best-effort only; do not fail /api/positions when persistence of
        // closed rounds is unavailable.
      }
      // Load current marks to expose lastMarkedAt aligned with marksRefresher cadence
      const marks = await repo.getPositionMarks(agentId);
      // Derive last-entry TP/SL from latest BUY instructions
      const repo2 = await getRepository();
      const repoTrades = await repo2.listRecentTradeInstructions(200, agentId);
      const lastEntryMap = new Map<string, { tp?: number; sl?: number; exp?: number; at: string }>();
      for (const t of repoTrades) {
        if (t.direction !== 'buy') continue;
        const key = `${t.marketId}:${t.optionId}`;
        const prev = lastEntryMap.get(key);
        if (!prev || new Date(t.createdAt) > new Date(prev.at)) {
          lastEntryMap.set(key, { tp: t.takeProfitPrice, sl: t.stopPrice, exp: t.expectedPrice, at: t.createdAt });
        }
      }
      const deriveEffective = (entry?: { tp?: number; sl?: number; exp?: number }) => {
        const res = deriveEffectiveTargets(
          entry
            ? {
                expectedPrice: entry.exp,
                takeProfitPrice: entry.tp,
                stopPrice: entry.sl,
              }
            : undefined,
          runtime as any,
        );
        return {
          tpEff: res.tpEff,
          slEff: res.slEff,
          tpOrig: res.tpOrig,
          slOrig: res.slOrig,
        };
      };
      // Derive last-trade timestamps for open positions sorting
      const lastTradeMs = new Map<string, number>();
      try {
        for (const t of (live.trades ?? [])) {
          const ts = Date.parse((t as any).matchTime);
          if (Number.isFinite(ts)) lastTradeMs.set(t.tokenId, Math.max(lastTradeMs.get(t.tokenId) ?? 0, ts));
        }
      } catch {}
      const feeForToken = (tokenId: string) => {
        try {
          let sum = 0;
          for (const t of (live.trades ?? [])) {
            if ((t as any).tokenId !== tokenId) continue;
            const pr = (t as any).price as number;
            const sz = (t as any).size as number;
            const bps = typeof (t as any).feeRateBps === 'number' ? (t as any).feeRateBps : 0;
            sum += Math.abs(pr * sz) * bps / 10000;
          }
          return sum;
        } catch { return undefined; }
      };
      const open = (live.openPositions ?? []).map((p) => {
        const key = `${p.marketId}:${p.tokenId}`;
        const eff = deriveEffective(lastEntryMap.get(key));
        return ({
        marketId: p.marketId,
        optionId: p.tokenId,
        quantity: p.quantity,
        averagePrice: p.averagePrice,
        status: 'open',
        bestBid: p.bestBid,
        bestAsk: p.bestAsk,
        updatedAt: (() => { const ms = lastTradeMs.get(p.tokenId); return typeof ms === 'number' && ms > 0 ? new Date(ms).toISOString() : undefined; })(),
        lastMarkedAt: (() => { const m = marks.get(`${p.marketId}:${p.tokenId}`); return m?.markedAt ? m.markedAt.toISOString() : undefined; })(),
        tpPrice: eff.tpEff,
        slPrice: eff.slEff,
        feesPaid: feeForToken(p.tokenId),
        tpPriceOrig: eff.tpOrig,
        slPriceOrig: eff.slOrig,
      });
      });
      let closed: Array<{
        marketId: string;
        optionId: string;
        quantity: number;
        averagePrice: number;
        status: string;
        exitPrice?: number;
        realizedPnlForPosition?: number;
        updatedAt?: string;
        feesPaid?: number;
      }> = [];
      if (includeClosed) {
        const maxClosedPages = Math.max(
          1,
          Math.floor(((runtime.ui as any)?.maxClosedPages ?? 12) as number),
        );
        const closedLimit = maxClosedPages * 5;
        const rawClosed = await repo.listRecentClosedPositions(closedLimit, agentId);
        closed = (rawClosed ?? []).map((p: any) => ({
          marketId: p.marketId,
          optionId: p.optionId,
          quantity: p.quantity,
          averagePrice: p.averagePrice,
          status: 'closed',
          exitPrice: p.exitPrice,
          realizedPnlForPosition: p.realizedPnl,
          updatedAt: p.closedAt,
          feesPaid: p.feesPaid,
        }));
      }
      // Optional filter: hide tiny open positions
      const minQty = Math.max(0, (runtime.ui as any)?.minOpenQuantity ?? 0.01);
      const filterSmall = Boolean((runtime.ui as any)?.filterSmallPositions ?? true);
      positions = [
        ...(filterSmall ? open.filter((p) => p.quantity >= minQty) : open),
        ...closed,
      ];
    } catch {
      positions = [];
    }
  } else {
    const openDb = await repo.listOpenPositions(agentId);
    const minQty = Math.max(0, (runtime.ui as any)?.minOpenQuantity ?? 0.01);
    const filterSmall = Boolean((runtime.ui as any)?.filterSmallPositions ?? true);
    const open = (filterSmall ? openDb.filter((p) => p.quantity >= minQty) : openDb).map((p) => ({
      marketId: p.marketId,
      optionId: p.optionId,
      quantity: p.quantity,
      averagePrice: p.averagePrice,
      status: p.status,
    }));
    positions = open;
  }

  // Enrich with names and titles using targeted evaluation lookups
  let enriched = await enrichMarketOutcomeLabels(repo as any, positions, (p: any) => ({
    marketId: p.marketId,
    evaluationOutcomeId: p.optionId,
    clobTokenId: p.optionId,
  }));
  // Best-effort final fallback: for any positions still missing titles or outcome
  // names, fetch market metadata directly from the CLOB public endpoint
  // GET /markets/{condition_id}. This endpoint returns `question` and a `tokens`
  // array with `{ token_id, outcome }`, which we can use to hydrate names for
  // markets that were never evaluated by the agent pipeline (e.g., manual trades).
  const missing = enriched.filter((p: any) => !p.marketTitle || !p.outcomeName);
  if (missing.length > 0) {
    try {
      const http = createHttpClient(runtime.http as any);
      const clobHostRaw = process.env.POLY_CLOB_HOST || 'https://clob.polymarket.com';
      const clobHost = clobHostRaw.replace(/\/+$/, '');
      const marketMeta = new Map<
        string,
        { question?: string; tokens?: Array<{ token_id: string; outcome: string }> }
      >();
      const uniqueMarketIds = Array.from(new Set(missing.map((p: any) => p.marketId).filter(Boolean)));
      for (const mid of uniqueMarketIds) {
        try {
          const url = `${clobHost}/markets/${mid}`;
          const data = await http<any>(url);
          if (data && typeof data === 'object') {
            marketMeta.set(mid, {
              question: (data as any).question as string | undefined,
              tokens: Array.isArray((data as any).tokens) ? (data as any).tokens : undefined,
            });
          }
        } catch {
          // Ignore CLOB lookup failures for enrichment; UI will keep "-" labels.
        }
      }
      enriched = enriched.map((p: any) => {
        if (p.marketTitle && p.outcomeName) return p;
        const meta = marketMeta.get(p.marketId);
        if (!meta) return p;
        let marketTitle = p.marketTitle || meta.question;
        let outcomeName = p.outcomeName;
        if (!outcomeName && meta.tokens) {
          const tok = meta.tokens.find((t) => String(t.token_id) === String(p.optionId));
          if (tok && typeof tok.outcome === 'string') {
            outcomeName = tok.outcome;
          }
        }
        return { ...p, marketTitle, outcomeName };
      });
    } catch {
      // Best-effort only; do not fail positions route on fallback errors.
    }
  }
  return NextResponse.json({ positions: enriched });
}
