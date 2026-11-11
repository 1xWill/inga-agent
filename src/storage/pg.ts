import type { Pool } from 'pg';
import type { AgentRepositoryAsync } from './types';

type TradeDirection = 'buy' | 'sell';

export function createPgRepository(pool: Pool): AgentRepositoryAsync {
  const q = async (text: string, params: any[] = []) => {
    const res = await pool.query(text, params);
    return res.rows as any[];
  };

  const one = async <T = any>(text: string, params: any[] = []) => {
    const rows = await q(text, params);
    return (rows[0] as T) ?? undefined;
  };

  // Discovery cursor --------------------------------------------------
  async function getMarketDiscoveryCursor(agentId: string) {
    const r = await one<{ cursor?: string }>(
      `SELECT cursor FROM discovery_cursor WHERE agent_id = $1`,
      [agentId]
    );
    return r?.cursor ?? undefined;
  }

  async function setMarketDiscoveryCursor(agentId: string, cursor: string) {
    const now = new Date().toISOString();
    await q(
      `INSERT INTO discovery_cursor (agent_id, cursor, updated_at)
       VALUES ($1,$2,$3)
       ON CONFLICT (agent_id) DO UPDATE SET cursor = EXCLUDED.cursor, updated_at = EXCLUDED.updated_at`,
      [agentId, cursor, now]
    );
  }

  async function listRuns(limit: number = 50) {
    const rows = await q(
      `SELECT id, agent_id, started_at, completed_at, status
       FROM agent_runs ORDER BY started_at DESC LIMIT $1`,
      [Math.max(1, Math.min(limit, 200))]
    );
    return rows.map((r: any) => ({ id: Number(r.id), agentId: r.agent_id, startedAt: r.started_at, completedAt: r.completed_at ?? null, status: r.status }));
  }

  async function getRun(id: number) {
    const r = await one(
      `SELECT id, agent_id, started_at, completed_at, status, metadata
       FROM agent_runs WHERE id = $1`,
      [id]
    );
    if (!r) return undefined;
    return { id: Number(r.id), agentId: r.agent_id, startedAt: r.started_at, completedAt: r.completed_at ?? null, status: r.status, metadata: r.metadata ?? undefined } as any;
  }

  // Run lifecycle -----------------------------------------------------
  async function startRun(agentId: string, startedAt: Date, metadata?: Record<string, unknown>) {
    const r = await one<{ id: string }>(
      `INSERT INTO agent_runs (agent_id, started_at, status, metadata)
       VALUES ($1,$2,'running',$3)
       RETURNING id`,
      [agentId, (startedAt ?? new Date()).toISOString(), metadata ? JSON.stringify(metadata) : null]
    );
    return Number(r!.id);
  }

  async function completeRun(runId: number, status: 'completed' | 'failed', completedAt: Date) {
    await q(
      `UPDATE agent_runs SET status = $1, completed_at = $2 WHERE id = $3`,
      [status, (completedAt ?? new Date()).toISOString(), runId]
    );
  }

  // Writes ------------------------------------------------------------
  async function recordMarketEvaluation(e: {
    runId: number;
    agentId: string;
    marketId: string;
    title: string;
    outcomes: any[];
    currentPrices: Record<string, number | undefined>;
    quickResearchSummary: string;
    trade: boolean;
    evaluationRationale: string;
    riskNotes?: string;
    timestamp: Date;
    status?: string;
    debugMarketPayloadJson?: unknown;
    debugAiInputJson?: unknown;
    debugAiOutputJson?: unknown;
    evaluationCitations?: string[];
  }) {
    const r = await one<{ id: string }>(
      `INSERT INTO market_evaluations (
         run_id, agent_id, market_id, title,
         outcomes_json, prices_json, quick_summary, trade_flag,
         evaluation_rationale, risk_notes, created_at, status,
         debug_market_payload_json, debug_ai_input_json, debug_ai_output_json,
         evaluation_citations
       ) VALUES (
         $1,$2,$3,$4,
         $5,$6,$7,$8,
         $9,$10,$11,$12,
         $13,$14,$15,$16
       ) RETURNING id`,
      [
        e.runId,
        e.agentId,
        e.marketId,
        e.title,
        JSON.stringify(e.outcomes ?? []),
        JSON.stringify(e.currentPrices ?? {}),
        e.quickResearchSummary,
        e.trade ? true : false,
        e.evaluationRationale,
        e.riskNotes ?? null,
        (e.timestamp ?? new Date()).toISOString(),
        e.status ?? null,
        e.debugMarketPayloadJson ? JSON.stringify(e.debugMarketPayloadJson) : null,
        e.debugAiInputJson ? JSON.stringify(e.debugAiInputJson) : null,
        e.debugAiOutputJson ? JSON.stringify(e.debugAiOutputJson) : null,
        Array.isArray(e.evaluationCitations) ? JSON.stringify(e.evaluationCitations) : null,
      ]
    );
    return Number(r!.id);
  }

  async function recordPlanDecision(d: {
    evaluationId: number;
    agentId: string;
    marketId: string;
    outcomeId?: string;
    status: string;
    reason?: string;
    createdAt: Date;
    tradeRationale?: string;
    debug?: unknown;
    citations?: string[];
  }) {
    const r = await one<{ id: string }>(
      `INSERT INTO plan_decisions (
         evaluation_id, agent_id, market_id, outcome_id,
         status, reason, created_at, trade_rationale, debug_json, decision_citations
       ) VALUES (
         $1,$2,$3,$4,
         $5,$6,$7,$8,$9,$10
       ) RETURNING id`,
      [
        d.evaluationId,
        d.agentId,
        d.marketId,
        d.outcomeId ?? null,
        d.status,
        d.reason ?? null,
        (d.createdAt ?? new Date()).toISOString(),
        d.tradeRationale ?? null,
        d.debug ? JSON.stringify(d.debug) : null,
        Array.isArray(d.citations) ? JSON.stringify(d.citations) : null,
      ]
    );
    return Number(r!.id);
  }

  async function recordTradeInstruction(t: {
    evaluationId: number;
    agentId: string;
    marketId: string;
    optionId: string;
    direction: TradeDirection;
    notional: number;
    allocationPct?: number;
    expectedPrice?: number;
    stopPrice?: number;
    takeProfitPrice?: number;
    reason: string;
    createdAt: Date;
  }) {
    const r = await one<{ id: string }>(
      `INSERT INTO trade_instructions (
         evaluation_id, agent_id, market_id, option_id, direction,
         notional, allocation_pct, expected_price, stop_price, take_profit_price,
         reason, created_at
       ) VALUES (
         $1,$2,$3,$4,$5,
         $6,$7,$8,$9,$10,
         $11,$12
       ) RETURNING id`,
      [
        t.evaluationId,
        t.agentId,
        t.marketId,
        t.optionId,
        t.direction,
        t.notional,
        typeof t.allocationPct === 'number' ? t.allocationPct : null,
        typeof t.expectedPrice === 'number' ? t.expectedPrice : null,
        typeof t.stopPrice === 'number' ? t.stopPrice : null,
        typeof t.takeProfitPrice === 'number' ? t.takeProfitPrice : null,
        t.reason,
        (t.createdAt ?? new Date()).toISOString(),
      ]
    );
    return Number(r!.id);
  }

  // Cooldowns ---------------------------------------------------------
  async function upsertMarketCooldown(params: { agentId: string; marketId: string; reason: string; expiresAt: Date; updatedAt?: Date }) {
    const updatedAt = (params.updatedAt ?? new Date()).toISOString();
    await q(
      `INSERT INTO market_cooldowns (agent_id, market_id, reason, updated_at, expires_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (agent_id, market_id, reason)
       DO UPDATE SET updated_at = EXCLUDED.updated_at, expires_at = EXCLUDED.expires_at`,
      [params.agentId, params.marketId, params.reason, updatedAt, params.expiresAt.toISOString()]
    );
  }

  async function clearMarketCooldowns(agentId: string, marketId: string, reason?: string) {
    if (reason) {
      await q(`DELETE FROM market_cooldowns WHERE agent_id = $1 AND market_id = $2 AND reason = $3`, [agentId, marketId, reason]);
      return;
    }
    await q(`DELETE FROM market_cooldowns WHERE agent_id = $1 AND market_id = $2`, [agentId, marketId]);
  }

  async function getActiveCooldownReasons(agentId: string, marketId: string, now: Date = new Date()) {
    // Prune expired
    await q(`DELETE FROM market_cooldowns WHERE expires_at <= $1`, [(now ?? new Date()).toISOString()]);
    const rows = await q(
      `SELECT reason FROM market_cooldowns
       WHERE agent_id = $1 AND market_id = $2 AND expires_at > $3`,
      [agentId, marketId, (now ?? new Date()).toISOString()]
    );
    return rows.map((r: any) => r.reason as string);
  }

  // Positions & portfolio --------------------------------------------
  async function upsertPosition(p: { id?: number; agentId: string; marketId: string; optionId: string; direction: TradeDirection; quantity: number; averagePrice: number; status: 'open'|'closed'; openedAt?: Date }) {
    const opened = (p.openedAt ?? new Date()).toISOString();
    const updated = new Date().toISOString();
    await q(
      `INSERT INTO positions (agent_id, market_id, option_id, direction, quantity, average_price, status, opened_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (agent_id, market_id, option_id)
       DO UPDATE SET quantity = EXCLUDED.quantity, average_price = EXCLUDED.average_price, status = EXCLUDED.status, updated_at = EXCLUDED.updated_at`,
      [p.agentId, p.marketId, p.optionId, p.direction, p.quantity, p.averagePrice, p.status, opened, updated]
    );
    const r = await one(
      `SELECT * FROM positions WHERE agent_id = $1 AND market_id = $2 AND option_id = $3`,
      [p.agentId, p.marketId, p.optionId]
    );
    return {
      id: Number(r!.id), agentId: r!.agent_id, marketId: r!.market_id, optionId: r!.option_id,
      direction: r!.direction as TradeDirection, quantity: Number(r!.quantity), averagePrice: Number(r!.average_price),
      status: r!.status as any, openedAt: new Date(r!.opened_at), updatedAt: new Date(r!.updated_at)
    } as any;
  }

  async function closePosition(agentId: string, marketId: string, optionId: string, closedAt: Date) {
    await q(
      `UPDATE positions SET status = 'closed', updated_at = $1 WHERE agent_id = $2 AND market_id = $3 AND option_id = $4`,
      [(closedAt ?? new Date()).toISOString(), agentId, marketId, optionId]
    );
  }

  async function updatePortfolioState(agentId: string, state: { cashBalance: number; reservedBalance: number; realizedPnl: number; baseCurrency: string }) {
    await q(
      `UPDATE portfolio_state SET cash_balance = $1, reserved_balance = $2, realized_pnl = $3, base_currency = $4, updated_at = $5 WHERE agent_id = $6`,
      [state.cashBalance, state.reservedBalance, state.realizedPnl, state.baseCurrency, new Date().toISOString(), agentId]
    );
  }

  async function getLastFillTime(agentId: string, marketId: string) {
    const r = await one<{ last?: string }>(
      `SELECT MAX(created_at) AS last FROM fills WHERE agent_id = $1 AND market_id = $2`,
      [agentId, marketId]
    );
    return r?.last ? new Date(r.last) : undefined;
  }

  async function recordClosedPositions(
    agentId: string,
    positions: Array<{
      marketId: string;
      optionId: string;
      quantity: number;
      averagePrice: number;
      exitPrice: number;
      realizedPnl: number;
      feesPaid: number;
      closedAt: string;
    }>,
  ) {
    if (!positions.length) return;
    for (const p of positions) {
      const closedAtIso =
        typeof p.closedAt === 'string'
          ? p.closedAt
          : new Date(p.closedAt as any).toISOString();
      await q(
        `INSERT INTO closed_positions (
           agent_id, market_id, option_id, quantity,
           average_price, exit_price, realized_pnl, fees_paid, closed_at
         ) VALUES (
           $1,$2,$3,$4,
           $5,$6,$7,$8,$9
         )
         ON CONFLICT (agent_id, market_id, option_id, closed_at) DO UPDATE SET
           quantity = EXCLUDED.quantity,
           average_price = EXCLUDED.average_price,
           exit_price = EXCLUDED.exit_price,
           realized_pnl = EXCLUDED.realized_pnl,
           fees_paid = EXCLUDED.fees_paid`,
        [
          agentId,
          p.marketId,
          p.optionId,
          p.quantity,
          p.averagePrice,
          p.exitPrice,
          p.realizedPnl,
          p.feesPaid,
          closedAtIso,
        ],
      );
    }
  }

  async function listRecentClosedPositions(
    limit: number = 50,
    agentId?: string,
    offset: number = 0,
    filters?: { marketId?: string; optionId?: string },
  ) {
    const values: Array<string | number> = [];
    let paramIdx = 1;
    const limitVal = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 50;
    const offsetVal = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
    let sql = `SELECT agent_id, market_id, option_id, quantity, average_price, exit_price, realized_pnl, fees_paid, closed_at
       FROM closed_positions`;
    const clauses: string[] = [];
    if (agentId) {
      values.push(agentId);
      clauses.push(`agent_id = $${paramIdx}`);
      paramIdx += 1;
    }
    if (filters?.marketId) {
      values.push(filters.marketId);
      clauses.push(`market_id = $${paramIdx}`);
      paramIdx += 1;
    }
    if (filters?.optionId) {
      values.push(filters.optionId);
      clauses.push(`option_id = $${paramIdx}`);
      paramIdx += 1;
    }
    if (clauses.length > 0) {
      sql += ` WHERE ${clauses.join(' AND ')}`;
    }
    sql += ' ORDER BY closed_at DESC';
    if (limitVal > 0) {
      values.push(limitVal);
      sql += ` LIMIT $${paramIdx}`;
      paramIdx += 1;
    }
    if (offsetVal > 0) {
      values.push(offsetVal);
      sql += ` OFFSET $${paramIdx}`;
    }
    const rows = await q(sql, values);
    return rows.map((r: any) => ({
      agentId: r.agent_id as string,
      marketId: r.market_id as string,
      optionId: r.option_id as string,
      quantity: Number(r.quantity),
      averagePrice: Number(r.average_price),
      exitPrice: Number(r.exit_price),
      realizedPnl: Number(r.realized_pnl),
      feesPaid: Number(r.fees_paid),
      closedAt: r.closed_at as string,
    }));
  }

  async function countClosedPositions(agentId?: string, filters?: { marketId?: string; optionId?: string }) {
    const values: Array<string> = [];
    let paramIdx = 1;
    let sql = 'SELECT COUNT(1) AS cnt FROM closed_positions';
    const clauses: string[] = [];
    if (agentId) {
      clauses.push(`agent_id = $${paramIdx}`);
      values.push(agentId);
      paramIdx += 1;
    }
    if (filters?.marketId) {
      clauses.push(`market_id = $${paramIdx}`);
      values.push(filters.marketId);
      paramIdx += 1;
    }
    if (filters?.optionId) {
      clauses.push(`option_id = $${paramIdx}`);
      values.push(filters.optionId);
      paramIdx += 1;
    }
    if (clauses.length > 0) {
      sql += ` WHERE ${clauses.join(' AND ')}`;
    }
    const row = await one<{ cnt?: string }>(sql, values);
    return row?.cnt != null ? Number(row.cnt) : 0;
  }

  async function getTotalRealizedPnlFromClosed(agentId: string) {
    const r = await one<{ sum_pnl?: string }>(
      `SELECT COALESCE(SUM(realized_pnl), 0) AS sum_pnl
       FROM closed_positions
       WHERE agent_id = $1`,
      [agentId],
    );
    const v = r?.sum_pnl != null ? Number(r.sum_pnl) : 0;
    return Number.isFinite(v) ? v : 0;
  }

  // Token resolution cache -------------------------------------------
  async function upsertResolvedClobTokenId(params: { marketId: string; outcomeIndex: number; clobTokenId: string; source?: string; resolvedAt?: Date }) {
    await q(
      `INSERT INTO token_resolution_map (market_id, outcome_index, clob_token_id, source, resolved_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (market_id, outcome_index)
       DO UPDATE SET clob_token_id = EXCLUDED.clob_token_id, source = EXCLUDED.source, resolved_at = EXCLUDED.resolved_at`,
      [params.marketId, params.outcomeIndex, params.clobTokenId, params.source ?? null, (params.resolvedAt ?? new Date()).toISOString()]
    );
  }

  async function listEvaluationsByRun(runId: number) {
    const rows = await q(
      `SELECT id, run_id, agent_id, market_id, title, outcomes_json, prices_json, quick_summary, trade_flag, evaluation_rationale, risk_notes, created_at
       FROM market_evaluations WHERE run_id = $1 ORDER BY created_at ASC`,
      [runId]
    );
    return rows.map((r: any) => ({
      id: Number(r.id), runId: Number(r.run_id), agentId: r.agent_id, marketId: r.market_id,
      title: r.title, outcomes: r.outcomes_json, currentPrices: r.prices_json,
      quickSummary: r.quick_summary, trade: !!r.trade_flag, evaluationRationale: r.evaluation_rationale,
      riskNotes: r.risk_notes ?? undefined, createdAt: r.created_at
    }));
  }

  async function listPlanDecisionsByRun(runId: number) {
    const rows = await q(
      `SELECT d.id, d.evaluation_id, d.agent_id, d.market_id, d.outcome_id, d.status, d.reason, d.created_at
       FROM plan_decisions d INNER JOIN market_evaluations e ON e.id = d.evaluation_id
       WHERE e.run_id = $1 ORDER BY d.created_at ASC`,
      [runId]
    );
    return rows.map((r: any) => ({ id: Number(r.id), evaluationId: Number(r.evaluation_id), agentId: r.agent_id, marketId: r.market_id, outcomeId: r.outcome_id ?? undefined, status: r.status, reason: r.reason ?? undefined, createdAt: r.created_at }));
  }

  async function listTradeInstructionsByRun(runId: number) {
    const rows = await q(
      `SELECT t.id, t.evaluation_id, t.agent_id, t.market_id, t.option_id, t.direction, t.notional, t.allocation_pct, t.expected_price, t.stop_price, t.take_profit_price, t.reason, t.created_at
       FROM trade_instructions t INNER JOIN market_evaluations e ON e.id = t.evaluation_id
       WHERE e.run_id = $1 ORDER BY t.created_at ASC`,
      [runId]
    );
    return rows.map((r: any) => ({
      id: Number(r.id), evaluationId: Number(r.evaluation_id), agentId: r.agent_id, marketId: r.market_id, optionId: r.option_id,
      direction: r.direction as TradeDirection,
      notional: Number(r.notional),
      // Postgres returns NUMERIC as strings by default; normalize to numbers for API/UI consumers
      allocationPct: r.allocation_pct != null ? Number(r.allocation_pct) : undefined,
      expectedPrice: r.expected_price != null ? Number(r.expected_price) : undefined,
      stopPrice: r.stop_price != null ? Number(r.stop_price) : undefined,
      takeProfitPrice: r.take_profit_price != null ? Number(r.take_profit_price) : undefined,
      reason: r.reason, createdAt: r.created_at
    }));
  }

  async function listFillsByInstructionIds(ids: number[]) {
    if (!ids || ids.length === 0) return [] as any[];
    const params = ids.map((_, i) => `$${i + 1}`).join(',');
    const rows = await q(
      `SELECT id, trade_instruction_id, agent_id, market_id, option_id, direction, quantity, fill_price, notional, pnl, created_at, metadata, fee_amount, fee_bps, fee_meta
       FROM fills WHERE trade_instruction_id IN (${params}) ORDER BY created_at ASC`,
      ids
    );
    return rows.map((r: any) => ({
      id: Number(r.id),
      tradeInstructionId: Number(r.trade_instruction_id),
      agentId: r.agent_id,
      marketId: r.market_id,
      optionId: r.option_id,
      direction: r.direction as TradeDirection,
      quantity: Number(r.quantity),
      fillPrice: Number(r.fill_price),
      notional: Number(r.notional),
      pnl: Number(r.pnl),
      createdAt: r.created_at,
      metadata: r.metadata ?? undefined,
      feeAmount: r.fee_amount != null ? Number(r.fee_amount) : undefined,
      feeBps: r.fee_bps != null ? Number(r.fee_bps) : undefined,
      feeMeta: r.fee_meta ?? undefined
    }));
  }

  async function listRecentMarketEvaluations(limit = 50, agentId?: string) {
    const { rows } = await listMarketEvaluationsPage({
      limit,
      offset: 0,
      agentId,
    });
    return rows;
  }

  async function listMarketEvaluationsPage(params: {
    limit?: number;
    offset?: number;
    agentId?: string;
    tradeOnly?: boolean;
    marketId?: string;
  }) {
    const limit = Number.isFinite(params.limit)
      ? Math.max(0, Math.floor(params.limit ?? 0))
      : 50;
    const offset = Math.max(0, Math.floor(params.offset ?? 0));
    const clauses: string[] = [];
    const args: any[] = [];

    if (params.agentId) {
      clauses.push(`agent_id = $${args.length + 1}`);
      args.push(params.agentId);
    }
    if (params.tradeOnly) {
      clauses.push(`trade_flag = true`);
    }
    if (params.marketId) {
      clauses.push(`market_id = $${args.length + 1}`);
      args.push(params.marketId);
    }
    const whereSql = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = await q(
      `SELECT id, run_id, agent_id, market_id, title, outcomes_json, prices_json, quick_summary, trade_flag, evaluation_rationale, risk_notes, created_at, status,
              debug_market_payload_json, debug_ai_input_json, debug_ai_output_json, evaluation_citations
       FROM market_evaluations
       ${whereSql}
       ORDER BY created_at DESC
       LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
      [...args, limit, offset],
    );
    const countRows = await q(
      `SELECT COUNT(1) AS c FROM market_evaluations ${whereSql}`,
      args,
    );
    return {
      rows: rows.map((r: any) => ({
        id: Number(r.id),
        runId: Number(r.run_id),
        agentId: r.agent_id,
        marketId: r.market_id,
        title: r.title,
        outcomes: r.outcomes_json,
        currentPrices: r.prices_json,
        quickSummary: r.quick_summary,
        trade: !!r.trade_flag,
        evaluationRationale: r.evaluation_rationale,
        riskNotes: r.risk_notes ?? undefined,
        createdAt: r.created_at,
        debugMarketPayload: r.debug_market_payload_json ?? undefined,
        debugAiInput: r.debug_ai_input_json ?? undefined,
        debugAiOutput: r.debug_ai_output_json ?? undefined,
        status: r.status ?? undefined,
        citations: r.evaluation_citations ?? undefined,
      })),
      total: Number(countRows?.[0]?.c ?? rows.length),
    };
  }

  async function listRecentPlanDecisions(limit = 50, agentId?: string) {
    const rows = await q(
      `SELECT id, evaluation_id, agent_id, market_id, outcome_id, status, reason, trade_rationale, created_at, debug_json, decision_citations
       FROM plan_decisions ${agentId ? 'WHERE agent_id = $2' : ''} ORDER BY created_at DESC LIMIT $1`,
      agentId ? [Math.floor(limit), agentId] : [Math.floor(limit)]
    );
    return rows.map((r: any) => ({
      id: Number(r.id), evaluationId: Number(r.evaluation_id), agentId: r.agent_id, marketId: r.market_id, outcomeId: r.outcome_id ?? undefined,
      status: r.status, reason: r.reason ?? undefined, tradeRationale: r.trade_rationale ?? undefined, createdAt: r.created_at,
      debug: r.debug_json ?? undefined, citations: r.decision_citations ?? undefined
    }));
  }

  async function listRecentTradeInstructions(limit = 50, agentId?: string) {
    const rows = await q(
      `SELECT id, evaluation_id, agent_id, market_id, option_id, direction, notional, allocation_pct, expected_price, stop_price, take_profit_price, reason, created_at,
              live_order_id, live_status, live_error, live_last_update, executed_at, taker_order_id
       FROM trade_instructions ${agentId ? 'WHERE agent_id = $2' : ''} ORDER BY created_at DESC LIMIT $1`,
      agentId ? [Math.floor(limit), agentId] : [Math.floor(limit)]
    );
    return rows.map((r: any) => ({
      id: Number(r.id), evaluationId: r.evaluation_id ?? undefined, agentId: r.agent_id, marketId: r.market_id, optionId: r.option_id,
      direction: r.direction as TradeDirection,
      notional: Number(r.notional),
      allocationPct: r.allocation_pct != null ? Number(r.allocation_pct) : undefined,
      expectedPrice: r.expected_price != null ? Number(r.expected_price) : undefined,
      stopPrice: r.stop_price != null ? Number(r.stop_price) : undefined,
      takeProfitPrice: r.take_profit_price != null ? Number(r.take_profit_price) : undefined,
      reason: r.reason, createdAt: r.created_at, liveOrderId: r.live_order_id ?? undefined, liveStatus: r.live_status ?? undefined,
      liveError: r.live_error ?? undefined, liveLastUpdate: r.live_last_update ?? undefined, executedAt: r.executed_at ?? undefined, takerOrderId: r.taker_order_id ?? undefined
    }));
  }

  async function listRecentFills(limit = 50, agentId?: string) {
    const rows = await q(
      `SELECT id, trade_instruction_id, agent_id, market_id, option_id, direction, quantity, fill_price, notional, pnl, created_at, metadata, fee_amount, fee_bps, fee_meta
       FROM fills ${agentId ? 'WHERE agent_id = $2' : ''} ORDER BY created_at DESC LIMIT $1`,
      agentId ? [Math.floor(limit), agentId] : [Math.floor(limit)]
    );
    return rows.map((r: any) => ({
      id: Number(r.id),
      tradeInstructionId: Number(r.trade_instruction_id),
      agentId: r.agent_id,
      marketId: r.market_id,
      optionId: r.option_id,
      direction: r.direction as TradeDirection,
      quantity: Number(r.quantity),
      fillPrice: Number(r.fill_price),
      notional: Number(r.notional),
      pnl: Number(r.pnl),
      createdAt: r.created_at,
      metadata: r.metadata ?? undefined,
      feeAmount: r.fee_amount != null ? Number(r.fee_amount) : undefined,
      feeBps: r.fee_bps != null ? Number(r.fee_bps) : undefined,
      feeMeta: r.fee_meta ?? undefined
    }));
  }

  async function listRecentExits(limit = 50, agentId?: string) {
    const rows = await q(
      `SELECT id, evaluation_id, agent_id, market_id, option_id, direction, notional, allocation_pct, expected_price, stop_price, take_profit_price, reason, created_at,
              live_status, live_order_id, executed_at
       FROM trade_instructions WHERE direction = 'sell' ${agentId ? 'AND agent_id = $2' : ''}
       ORDER BY created_at DESC LIMIT $1`,
      agentId ? [Math.floor(limit), agentId] : [Math.floor(limit)]
    );
    return rows.map((r: any) => ({
      id: Number(r.id),
      evaluationId: r.evaluation_id ?? undefined,
      agentId: r.agent_id,
      marketId: r.market_id,
      optionId: r.option_id,
      direction: r.direction as TradeDirection,
      notional: Number(r.notional),
      allocationPct: r.allocation_pct != null ? Number(r.allocation_pct) : undefined,
      expectedPrice: r.expected_price != null ? Number(r.expected_price) : undefined,
      stopPrice: r.stop_price != null ? Number(r.stop_price) : undefined,
      takeProfitPrice: r.take_profit_price != null ? Number(r.take_profit_price) : undefined,
      reason: r.reason,
      createdAt: r.created_at,
      liveStatus: r.live_status ?? undefined,
      liveOrderId: r.live_order_id ?? undefined,
      executedAt: r.executed_at ?? undefined
    }));
  }

  async function setTradeInstructionExecutionInfo(id: number, params: { executedAt?: Date | string; takerOrderId?: string }) {
    const fields: string[] = [];
    const args: any[] = [];
    let idx = 1;
    if (params.executedAt) { fields.push(`executed_at = $${idx++}`); args.push(typeof params.executedAt === 'string' ? params.executedAt : (params.executedAt as Date).toISOString()); }
    if (typeof params.takerOrderId === 'string') { fields.push(`taker_order_id = $${idx++}`); args.push(params.takerOrderId); }
    if (fields.length === 0) return;
    args.push(id);
    await q(`UPDATE trade_instructions SET ${fields.join(', ')} WHERE id = $${idx}`, args);
  }

  async function listLiveOrdersNeedingUpdate(agentId: string) {
    const rows = await q(
      `SELECT id, live_order_id, created_at, live_status FROM trade_instructions
       WHERE agent_id = $1 AND live_order_id IS NOT NULL AND (live_status IS NULL OR live_status NOT IN ('filled','canceled','failed'))`,
      [agentId]
    );
    return rows.map((r: any) => ({ id: Number(r.id), orderId: r.live_order_id, createdAt: r.created_at, liveStatus: r.live_status ?? undefined }));
  }

  async function getTradeInstructionExecutionStateById(id: number) {
    const r = await one(`SELECT executed_at, taker_order_id FROM trade_instructions WHERE id = $1`, [id]);
    if (!r) return undefined;
    return { executedAt: r.executed_at ?? undefined, takerOrderId: r.taker_order_id ?? undefined } as any;
  }

  async function getTradeInstructionByLiveOrderId(orderId: string) {
    const r = await one(`SELECT id, agent_id, market_id, option_id, direction, created_at FROM trade_instructions WHERE live_order_id = $1 ORDER BY created_at DESC LIMIT 1`, [orderId]);
    if (!r) return undefined;
    return { id: Number(r.id), agentId: r.agent_id, marketId: r.market_id, optionId: r.option_id, direction: r.direction as TradeDirection, createdAt: r.created_at } as any;
  }

  async function hasFillWithTakerOrderId(orderId: string) {
    const r = await one<{ c: string }>(`SELECT COUNT(1) AS c FROM fills WHERE metadata ->> 'takerOrderId' = $1`, [orderId]);
    return Number(r?.c ?? 0) > 0;
  }

  async function setTradeInstructionLiveInfo(id: number, params: { orderId?: string; status?: string; error?: string; updatedAt?: Date }) {
    const fields: string[] = [];
    const args: any[] = [];
    let idx = 1;
    if (typeof params.orderId === 'string') { fields.push(`live_order_id = $${idx++}`); args.push(params.orderId); }
    let status = typeof params.status === 'string' ? params.status.trim() : undefined;
    let error = typeof params.error === 'string' ? params.error : undefined;
    if (status && /^\d{3}$/.test(status)) {
      error = error ? `${error} (http_status=${status})` : `http_status=${status}`;
      status = 'failed';
    }
    if (typeof status === 'string') { fields.push(`live_status = $${idx++}`); args.push(status); }
    if (typeof error === 'string') { fields.push(`live_error = $${idx++}`); args.push(error); }
    const ts = (params.updatedAt ?? new Date()).toISOString();
    fields.push(`live_last_update = $${idx++}`); args.push(ts);
    args.push(id);
    await q(`UPDATE trade_instructions SET ${fields.join(', ')} WHERE id = $${idx}`, args);
  }

  async function getLatestTradeRationale(agentId: string, marketId: string, outcomeId: string) {
    const r = await one(`SELECT trade_rationale, created_at FROM plan_decisions WHERE agent_id = $1 AND market_id = $2 AND outcome_id = $3 AND status = 'accepted' AND trade_rationale IS NOT NULL ORDER BY created_at DESC LIMIT 1`, [agentId, marketId, outcomeId]);
    if (!r || !r.trade_rationale) return undefined;
    return { tradeRationale: r.trade_rationale as string, createdAt: r.created_at as string };
  }

  async function getLatestDecisionCitations(agentId: string, marketId: string, outcomeId: string) {
    const r = await one(`SELECT decision_citations, created_at FROM plan_decisions WHERE agent_id = $1 AND market_id = $2 AND outcome_id = $3 AND status = 'accepted' AND decision_citations IS NOT NULL ORDER BY created_at DESC LIMIT 1`, [agentId, marketId, outcomeId]);
    if (!r || !r.decision_citations) return undefined;
    return { citations: r.decision_citations as string[], createdAt: r.created_at as string };
  }

  async function listAllPositions(agentId: string) {
    const rows = await q(`SELECT * FROM positions WHERE agent_id = $1 ORDER BY updated_at DESC`, [agentId]);
    return rows.map((row: any) => ({
      id: Number(row.id), agentId: row.agent_id, marketId: row.market_id, optionId: row.option_id, direction: row.direction as TradeDirection,
      quantity: Number(row.quantity), averagePrice: Number(row.average_price), status: row.status as any, openedAt: new Date(row.opened_at), updatedAt: new Date(row.updated_at)
    }));
  }

  async function listOpenPositions(agentId: string) {
    const rows = await q(`SELECT * FROM positions WHERE agent_id = $1 AND status = 'open'`, [agentId]);
    return rows.map((row: any) => ({
      id: Number(row.id), agentId: row.agent_id, marketId: row.market_id, optionId: row.option_id, direction: row.direction as TradeDirection,
      quantity: Number(row.quantity), averagePrice: Number(row.average_price), status: row.status as any, openedAt: new Date(row.opened_at), updatedAt: new Date(row.updated_at)
    }));
  }

  async function getPositionMarks(agentId: string) {
    const rows = await q(`SELECT market_id, option_id, best_bid, best_ask, mid, marked_at FROM position_marks WHERE agent_id = $1`, [agentId]);
    const map = new Map<string, { bestBid?: number; bestAsk?: number; mid?: number; markedAt: Date }>();
    for (const r of rows) {
      const bestBid = r.best_bid == null ? undefined : Number(r.best_bid);
      const bestAsk = r.best_ask == null ? undefined : Number(r.best_ask);
      const mid = r.mid == null ? undefined : Number(r.mid);
      map.set(`${r.market_id}:${r.option_id}`, { bestBid, bestAsk, mid, markedAt: new Date(r.marked_at) });
    }
    return map;
  }

  async function setPositionMark(params: { agentId: string; marketId: string; optionId: string; bestBid?: number; bestAsk?: number; mid?: number; markedAt?: Date }) {
    const markedAt = (params.markedAt ?? new Date()).toISOString();
    await q(
      `INSERT INTO position_marks (agent_id, market_id, option_id, best_bid, best_ask, mid, marked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (agent_id, market_id, option_id) DO UPDATE
       SET best_bid = EXCLUDED.best_bid, best_ask = EXCLUDED.best_ask, mid = EXCLUDED.mid, marked_at = EXCLUDED.marked_at`,
      [params.agentId, params.marketId, params.optionId, params.bestBid ?? null, params.bestAsk ?? null, params.mid ?? null, markedAt]
    );
  }

  async function getResolvedClobTokenId(marketId: string, outcomeIndex: number) {
    const r = await one<{ clob_token_id?: string }>(`SELECT clob_token_id FROM token_resolution_map WHERE market_id = $1 AND outcome_index = $2`, [marketId, outcomeIndex]);
    return r?.clob_token_id ?? undefined;
  }

  async function getOutcomeIndexByClobTokenId(marketId: string, clobTokenId: string) {
    const r = await one<{ outcome_index?: number }>(`SELECT outcome_index FROM token_resolution_map WHERE market_id = $1 AND clob_token_id = $2`, [marketId, clobTokenId]);
    return typeof r?.outcome_index === 'number' ? Number(r!.outcome_index) : undefined;
  }

  async function getLatestEvaluationSummary(marketId: string) {
    const r = await one<{
      title: string;
      outcomes_json: any;
      debug_market_payload_json?: any;
    }>(
      `SELECT title, outcomes_json, debug_market_payload_json
       FROM market_evaluations
       WHERE market_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [marketId],
    );
    if (!r) return undefined;
    let url: string | undefined;
    const payload = r.debug_market_payload_json;
    if (payload) {
      try {
        const arr = Array.isArray(payload) ? payload : JSON.parse(String(payload));
        if (Array.isArray(arr)) {
          const entry = arr.find((x: any) => x && (x.url || x.slug));
          if (entry) {
            url =
              (entry as any).url ||
              ((entry as any).slug
                ? `https://polymarket.com/market/${(entry as any).slug}`
                : undefined);
          }
        }
      } catch {
        // best-effort only
      }
    }
    return {
      title: r.title,
      outcomes: r.outcomes_json as Array<{ id: string; name: string }>,
      url,
    };
  }

  async function getPortfolioState(agentId: string, baseCurrency: string, initialBalance: number) {
    const r = await one(`SELECT agent_id, cash_balance, reserved_balance, realized_pnl, base_currency, updated_at FROM portfolio_state WHERE agent_id = $1`, [agentId]);
    if (r) {
      return { agentId: r.agent_id, cashBalance: Number(r.cash_balance), reservedBalance: Number(r.reserved_balance), realizedPnl: Number(r.realized_pnl), baseCurrency: r.base_currency, updatedAt: new Date(r.updated_at) };
    }
    const now = new Date().toISOString();
    await q(`INSERT INTO portfolio_state (agent_id, cash_balance, reserved_balance, realized_pnl, base_currency, updated_at) VALUES ($1,$2,$3,$4,$5,$6)`, [agentId, initialBalance, 0, 0, baseCurrency, now]);
    return { agentId, cashBalance: initialBalance, reservedBalance: 0, realizedPnl: 0, baseCurrency, updatedAt: new Date(now) };
  }

  async function buildPortfolioSnapshot(agentId: string, baseCurrency: string, initialBalance: number) {
    const state = await getPortfolioState(agentId, baseCurrency, initialBalance);
    const positions = await listOpenPositions(agentId);
    const marks = await getPositionMarks(agentId);
    const unrealized = positions.reduce((acc, p) => {
      const key = `${p.marketId}:${p.optionId}`;
      const m = marks.get(key);
      const bid = (m as any)?.bestBid ?? undefined;
      if (typeof bid === 'number') return acc + (bid - p.averagePrice) * p.quantity;
      return acc;
    }, 0);
    return { agentId, cashBalance: state.cashBalance, reservedBalance: state.reservedBalance, realizedPnl: state.realizedPnl, baseCurrency, unrealizedPnl: unrealized, positions } as any;
  }

  async function recordPortfolioHistory(params: { agentId: string; ts: number; equity: number; realizedPnl: number; unrealizedPnl: number }) {
    await q(
      `INSERT INTO portfolio_history (agent_id, ts, equity, realized_pnl, unrealized_pnl)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (agent_id, ts) DO UPDATE SET equity = EXCLUDED.equity, realized_pnl = EXCLUDED.realized_pnl, unrealized_pnl = EXCLUDED.unrealized_pnl`,
      [params.agentId, Math.floor(params.ts), params.equity, params.realizedPnl, params.unrealizedPnl]
    );
  }

  async function getLatestPortfolioHistory(agentId: string) {
    const r = await one(`SELECT ts, equity, realized_pnl, unrealized_pnl FROM portfolio_history WHERE agent_id = $1 ORDER BY ts DESC LIMIT 1`, [agentId]);
    if (!r) return undefined;
    return { ts: Number(r.ts), equity: Number(r.equity), realizedPnl: Number(r.realized_pnl), unrealizedPnl: Number(r.unrealized_pnl) };
  }

  async function getEarliestPortfolioHistory(agentId: string) {
    const r = await one(`SELECT ts, equity, realized_pnl, unrealized_pnl FROM portfolio_history WHERE agent_id = $1 ORDER BY ts ASC LIMIT 1`, [agentId]);
    if (!r) return undefined;
    return { ts: Number(r.ts), equity: Number(r.equity), realizedPnl: Number(r.realized_pnl), unrealizedPnl: Number(r.unrealized_pnl) };
  }

  async function getEarliestRunStart(agentId?: string) {
    const r = await one<{ started_at?: string }>(
      `SELECT started_at FROM agent_runs ${agentId ? 'WHERE agent_id = $1' : ''} ORDER BY started_at ASC LIMIT 1`,
      agentId ? [agentId] : []
    );
    if (!r?.started_at) return undefined;
    const ts = Date.parse(r.started_at);
    return Number.isFinite(ts) ? ts : undefined;
  }

  async function listPortfolioHistoryBetween(agentId: string, startTs: number, endTs: number) {
    const rows = await q(`SELECT ts, equity, realized_pnl, unrealized_pnl FROM portfolio_history WHERE agent_id = $1 AND ts >= $2 AND ts <= $3 ORDER BY ts ASC`, [agentId, Math.floor(startTs), Math.floor(endTs)]);
    return rows.map((r: any) => ({ ts: Number(r.ts), equity: Number(r.equity), realizedPnl: Number(r.realized_pnl), unrealizedPnl: Number(r.unrealized_pnl) }));
  }

  async function prunePortfolioHistoryBefore(agentId: string, cutoffTs: number) {
    await q(`DELETE FROM portfolio_history WHERE agent_id = $1 AND ts < $2`, [agentId, Math.floor(cutoffTs)]);
    return 0;
  }

  async function pruneEvaluationsByStatusBefore(status: string, cutoffIso: string) {
    await q(`DELETE FROM market_evaluations WHERE status = $1 AND created_at < $2`, [status, cutoffIso]);
    return 0;
  }

  return {
    // Runs and per-run details
    listRuns,
    getRun,
    listEvaluationsByRun,
    listPlanDecisionsByRun,
    listTradeInstructionsByRun,
    listFillsByInstructionIds,
    startRun,
    completeRun,
    // Writes
    recordMarketEvaluation,
    recordPlanDecision,
    recordTradeInstruction,
    // Recents and lookups
    listRecentMarketEvaluations,
    listMarketEvaluationsPage,
    listRecentPlanDecisions,
    listRecentTradeInstructions,
    listRecentFills,
    listRecentExits,
    // Live order linkage/status
    listLiveOrdersNeedingUpdate,
    getTradeInstructionExecutionStateById,
    getTradeInstructionByLiveOrderId,
    hasFillWithTakerOrderId,
    setTradeInstructionLiveInfo,
    setTradeInstructionExecutionInfo,
    // Rationale and citations
    getLatestTradeRationale,
    getLatestDecisionCitations,
    // Positions & marks
    listAllPositions,
    listOpenPositions,
    getPositionMarks,
    setPositionMark,
    upsertPosition,
    closePosition,
    // Token resolution
    getResolvedClobTokenId,
    getOutcomeIndexByClobTokenId,
    upsertResolvedClobTokenId,
    getLatestEvaluationSummary,
    // Portfolio summary/history
    buildPortfolioSnapshot,
    // Note: getPortfolioState is used by live runner to seed/update balance.
    // It was defined above but not exported, causing runtime errors like
    // "repo.getPortfolioState is not a function" in live (PG) mode.
    // Export it here to match the SQLite repository surface.
    getPortfolioState,
    recordPortfolioHistory,
    getLatestPortfolioHistory,
    getEarliestPortfolioHistory,
    getEarliestRunStart,
    listPortfolioHistoryBetween,
    prunePortfolioHistoryBefore,
    pruneEvaluationsByStatusBefore,
    updatePortfolioState,
    getLastFillTime,
    recordClosedPositions,
    listRecentClosedPositions,
    countClosedPositions,
    getTotalRealizedPnlFromClosed,
    // Cooldowns
    upsertMarketCooldown,
    clearMarketCooldowns,
    getActiveCooldownReasons,
    // Discovery cursor
    getMarketDiscoveryCursor,
    setMarketDiscoveryCursor,
  } as unknown as AgentRepositoryAsync;
}
