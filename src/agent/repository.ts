import type { Database as SqliteDatabase } from 'better-sqlite3';

import type {
  FillInsert,
  MarketEvaluationInsert,
  PortfolioSnapshot,
  PositionSnapshot,
  TradeDirection,
  TradeInstructionInsert
} from './types';

export type RunStatus = 'running' | 'completed' | 'failed';

function toIso(date: Date): string {
  return date.toISOString();
}

export class AgentRepository {
  constructor(private readonly db: SqliteDatabase) {}

  // Reads --------------------------------------------------------------
  listRuns(limit: number = 50): Array<{
    id: number;
    agentId: string;
    startedAt: string;
    completedAt?: string | null;
    status: RunStatus;
  }> {
    const rows = this.db
      .prepare(
        `SELECT id, agent_id, started_at, completed_at, status
         FROM agent_runs
         ORDER BY datetime(started_at) DESC
         LIMIT @limit`
      )
      .all({ limit }) as Array<{ id: number; agent_id: string; started_at: string; completed_at?: string | null; status: RunStatus }>;

    return rows.map((r) => ({ id: r.id, agentId: r.agent_id, startedAt: r.started_at, completedAt: r.completed_at ?? null, status: r.status }));
  }

  // Discovery cursor --------------------------------------------------
  getMarketDiscoveryCursor(agentId: string): string | undefined {
    const row = this.db
      .prepare(`SELECT cursor FROM discovery_cursor WHERE agent_id = @agent_id`)
      .get({ agent_id: agentId }) as { cursor?: string } | undefined;
    return row?.cursor ?? undefined;
  }

  setMarketDiscoveryCursor(agentId: string, cursor: string): void {
    this.db
      .prepare(
        `INSERT INTO discovery_cursor (agent_id, cursor, updated_at)
         VALUES (@agent_id, @cursor, @updated_at)
         ON CONFLICT(agent_id) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`
      )
      .run({ agent_id: agentId, cursor, updated_at: toIso(new Date()) });
  }

  listRecentMarketEvaluations(limit: number = 50, agentId?: string) {
    return this.listMarketEvaluationsPage({ limit, offset: 0, agentId }).rows;
  }

  listMarketEvaluationsPage(params: {
    limit?: number;
    offset?: number;
    agentId?: string;
    tradeOnly?: boolean;
    marketId?: string;
  }) {
    const useLimit = Number.isFinite(params.limit)
      ? Math.max(0, Math.floor(params.limit ?? 0))
      : 50;
    const offset = Math.max(0, Math.floor(params.offset ?? 0));
    const where: string[] = [];
    const bindings: Record<string, any> = { limit: useLimit, offset };
    const countBindings: Record<string, any> = {};

    if (params.agentId) {
      where.push("agent_id = @agent_id");
      bindings.agent_id = params.agentId;
      countBindings.agent_id = params.agentId;
    }
    if (params.tradeOnly) {
      where.push("trade_flag = 1");
    }
    if (params.marketId) {
      where.push("market_id = @market_id");
      bindings.market_id = params.marketId;
      countBindings.market_id = params.marketId;
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const rowsRaw = this.db
      .prepare(
        `SELECT id, run_id, agent_id, market_id, title, outcomes_json, prices_json, quick_summary, trade_flag, evaluation_rationale, risk_notes, created_at, status,
                debug_market_payload_json, debug_ai_input_json, debug_ai_output_json, evaluation_citations
         FROM market_evaluations
         ${whereSql}
         ORDER BY datetime(created_at) DESC
         LIMIT @limit OFFSET @offset`,
      )
      .all(bindings) as Array<{
        id: number;
        run_id: number;
        agent_id: string;
        market_id: string;
        title: string;
        outcomes_json: string;
        prices_json: string;
        quick_summary: string;
        trade_flag: number;
        evaluation_rationale: string;
        risk_notes?: string | null;
        created_at: string;
        debug_market_payload_json?: string | null;
        debug_ai_input_json?: string | null;
        debug_ai_output_json?: string | null;
        status?: string | null;
        evaluation_citations?: string | null;
      }>;
    const totalRow = this.db
      .prepare(
        `SELECT COUNT(1) AS c FROM market_evaluations ${whereSql}`,
      )
      .get(countBindings) as { c?: number } | undefined;
    const rows = rowsRaw.map((r) => ({
      id: r.id,
      runId: r.run_id,
      agentId: r.agent_id,
      marketId: r.market_id,
      title: r.title,
      outcomes: JSON.parse(r.outcomes_json),
      currentPrices: JSON.parse(r.prices_json),
      quickSummary: r.quick_summary,
      trade: !!r.trade_flag,
      evaluationRationale: r.evaluation_rationale,
      riskNotes: r.risk_notes ?? undefined,
      createdAt: r.created_at,
      debugMarketPayload: r.debug_market_payload_json
        ? JSON.parse(r.debug_market_payload_json)
        : undefined,
      debugAiInput: r.debug_ai_input_json
        ? JSON.parse(r.debug_ai_input_json)
        : undefined,
      debugAiOutput: r.debug_ai_output_json
        ? JSON.parse(r.debug_ai_output_json)
        : undefined,
      status: (r.status as any) ?? undefined,
      citations: r.evaluation_citations
        ? (JSON.parse(r.evaluation_citations) as string[])
        : undefined,
    }));
    return {
      rows,
      total: Number(totalRow?.c ?? rows.length),
    };
  }

  listRecentPlanDecisions(limit: number = 50, agentId?: string) {
    const baseSql =
      `SELECT id, evaluation_id, agent_id, market_id, outcome_id, status, reason, trade_rationale, created_at, debug_json, decision_citations
         FROM plan_decisions
         ${agentId ? 'WHERE agent_id = @agent_id' : ''}
         ORDER BY datetime(created_at) DESC`;
    const useLimit = Number.isFinite(limit) ? Math.floor(limit) : 50;
    const stmt = this.db.prepare(useLimit > 0 ? `${baseSql} LIMIT @limit` : baseSql);
    const rows = (useLimit > 0
      ? stmt.all({ agent_id: agentId, limit: useLimit })
      : stmt.all({ agent_id: agentId })) as Array<{
        id: number;
        evaluation_id: number;
        agent_id: string;
        market_id: string;
        outcome_id?: string | null;
        status: 'accepted' | 'rejected';
        reason?: string | null;
        trade_rationale?: string | null;
        created_at: string;
        debug_json?: string | null;
        decision_citations?: string | null;
      }>;

    return rows.map((r) => ({
      id: r.id,
      evaluationId: r.evaluation_id,
      agentId: r.agent_id,
      marketId: r.market_id,
      outcomeId: r.outcome_id ?? undefined,
      status: r.status,
      reason: r.reason ?? undefined,
      tradeRationale: r.trade_rationale ?? undefined,
      createdAt: r.created_at,
      debug: r.debug_json ? JSON.parse(r.debug_json) : undefined,
      citations: r.decision_citations ? (JSON.parse(r.decision_citations) as string[]) : undefined
    }));
  }

  listRecentTradeInstructions(limit: number = 50, agentId?: string) {
    const baseSql =
      `SELECT id, evaluation_id, agent_id, market_id, option_id, direction, notional, allocation_pct, expected_price, stop_price, take_profit_price, reason, created_at,
              live_order_id, live_status, live_error, live_last_update, executed_at, taker_order_id
         FROM trade_instructions
         ${agentId ? 'WHERE agent_id = @agent_id' : ''}
         ORDER BY datetime(created_at) DESC`;
    const useLimit = Number.isFinite(limit) ? Math.floor(limit) : 50;
    const stmt = this.db.prepare(useLimit > 0 ? `${baseSql} LIMIT @limit` : baseSql);
    const rows = (useLimit > 0
      ? stmt.all({ agent_id: agentId, limit: useLimit })
      : stmt.all({ agent_id: agentId })) as Array<{
        id: number;
        evaluation_id: number | null;
        agent_id: string;
        market_id: string;
        option_id: string;
        direction: TradeDirection;
        notional: number;
        allocation_pct?: number | null;
        expected_price?: number | null;
        stop_price?: number | null;
        take_profit_price?: number | null;
        reason: string;
        created_at: string;
        live_order_id?: string | null;
        live_status?: string | null;
        live_error?: string | null;
        live_last_update?: string | null;
        executed_at?: string | null;
        taker_order_id?: string | null;
      }>;

    return rows.map((r) => ({
      id: r.id,
      evaluationId: r.evaluation_id ?? undefined,
      agentId: r.agent_id,
      marketId: r.market_id,
      optionId: r.option_id,
      direction: r.direction,
      notional: r.notional,
      allocationPct: r.allocation_pct ?? undefined,
      expectedPrice: r.expected_price ?? undefined,
      stopPrice: r.stop_price ?? undefined,
      takeProfitPrice: r.take_profit_price ?? undefined,
      reason: r.reason,
      createdAt: r.created_at,
      liveOrderId: r.live_order_id ?? undefined,
      liveStatus: r.live_status ?? undefined,
      liveError: r.live_error ?? undefined,
      liveLastUpdate: r.live_last_update ?? undefined,
      executedAt: r.executed_at ?? undefined,
      takerOrderId: r.taker_order_id ?? undefined,
    }));
  }

  setTradeInstructionLiveInfo(id: number, params: { orderId?: string; status?: string; error?: string; updatedAt?: Date }) {
    const fields: string[] = [];
    const args: any = { id };
    if (typeof params.orderId === 'string') { fields.push('live_order_id = @order_id'); args.order_id = params.orderId; }
    let status = typeof params.status === 'string' ? params.status.trim() : undefined;
    let error = typeof params.error === 'string' ? params.error : undefined;
    if (status && /^\d{3}$/.test(status)) {
      error = error ? `${error} (http_status=${status})` : `http_status=${status}`;
      status = 'failed';
    }
    if (typeof status === 'string') { fields.push('live_status = @status'); args.status = status; }
    if (typeof error === 'string') { fields.push('live_error = @error'); args.error = error; }
    const ts = (params.updatedAt ?? new Date()).toISOString();
    fields.push('live_last_update = @ts'); args.ts = ts;
    if (fields.length === 0) return;
    const sql = `UPDATE trade_instructions SET ${fields.join(', ')} WHERE id = @id`;
    this.db.prepare(sql).run(args);
  }

  listLiveOrdersNeedingUpdate(agentId: string): Array<{ id: number; orderId: string; createdAt: string; liveStatus?: string }> {
    const rows = this.db.prepare(
      `SELECT id, live_order_id, created_at, live_status
       FROM trade_instructions
       WHERE agent_id = @agent_id AND live_order_id IS NOT NULL AND (live_status IS NULL OR live_status NOT IN ('filled','canceled','failed'))`
    ).all({ agent_id: agentId }) as Array<{ id: number; live_order_id: string; created_at: string; live_status?: string | null }>;
    return rows.map(r => ({ id: r.id, orderId: r.live_order_id, createdAt: r.created_at, liveStatus: r.live_status ?? undefined }));
  }

  // Lookup most recent trade instruction by agent/market/option/direction
  getLatestTradeInstructionFor(agentId: string, marketId: string, optionId: string, direction: TradeDirection): { id: number; createdAt: string } | undefined {
    const row = this.db.prepare(
      `SELECT id, created_at FROM trade_instructions
       WHERE agent_id = @agent_id AND market_id = @market_id AND option_id = @option_id AND direction = @direction
       ORDER BY datetime(created_at) DESC
       LIMIT 1`
    ).get({ agent_id: agentId, market_id: marketId, option_id: optionId, direction }) as { id: number; created_at: string } | undefined;
    return row ? { id: row.id, createdAt: row.created_at } : undefined;
  }

  // Check if any recorded fill references a given taker_order_id (from CLOB trades)
  hasFillWithTakerOrderId(orderId: string): boolean {
    if (!orderId) return false;
    try {
      const row = this.db.prepare(
        `SELECT 1 AS ok FROM fills
         WHERE json_extract(metadata, '$.takerOrderId') = @order_id
         LIMIT 1`
      ).get({ order_id: orderId }) as { ok?: number } | undefined;
      return !!row?.ok;
    } catch {
      // Fallback if JSON1 is unavailable: best-effort match via LIKE
      try {
        const row2 = this.db.prepare(
          `SELECT 1 AS ok FROM fills
           WHERE metadata LIKE @needle
           LIMIT 1`
        ).get({ needle: `%"takerOrderId":"${orderId}"%` }) as { ok?: number } | undefined;
        return !!row2?.ok;
      } catch {
        return false;
      }
    }
  }

  // Lookup a recorded trade instruction by its live order id
  getTradeInstructionByLiveOrderId(orderId: string): { id: number; agentId: string; marketId: string; optionId: string; direction: TradeDirection; createdAt: string } | undefined {
    if (!orderId) return undefined;
    const row = this.db.prepare(
      `SELECT id, agent_id, market_id, option_id, direction, created_at
       FROM trade_instructions WHERE live_order_id = @order_id LIMIT 1`
    ).get({ order_id: orderId }) as { id: number; agent_id: string; market_id: string; option_id: string; direction: TradeDirection; created_at: string } | undefined;
    if (!row) return undefined;
    return { id: row.id, agentId: row.agent_id, marketId: row.market_id, optionId: row.option_id, direction: row.direction, createdAt: row.created_at };
  }

  getTradeInstructionExecutionStateById(id: number): { executedAt?: string; takerOrderId?: string } | undefined {
    try {
      const row = this.db.prepare(
        `SELECT executed_at, taker_order_id FROM trade_instructions WHERE id = @id LIMIT 1`
      ).get({ id }) as { executed_at?: string | null; taker_order_id?: string | null } | undefined;
      if (!row) return undefined;
      const executedAt = row.executed_at ?? undefined;
      const takerOrderId = row.taker_order_id ?? undefined;
      if (!executedAt && !takerOrderId) return {};
      return { executedAt, takerOrderId };
    } catch {
      return undefined;
    }
  }

  listRecentFills(limit: number = 50, agentId?: string) {
    const baseSql =
      `SELECT id, trade_instruction_id, agent_id, market_id, option_id, direction, quantity, fill_price, notional, pnl, created_at, metadata, fee_amount, fee_bps, fee_meta
         FROM fills
         ${agentId ? 'WHERE agent_id = @agent_id' : ''}
         ORDER BY datetime(created_at) DESC`;
    const useLimit = Number.isFinite(limit) ? Math.floor(limit) : 50;
    const stmt = this.db.prepare(useLimit > 0 ? `${baseSql} LIMIT @limit` : baseSql);
    const rows = (useLimit > 0
      ? stmt.all({ agent_id: agentId, limit: useLimit })
      : stmt.all({ agent_id: agentId })) as Array<{
        id: number;
        trade_instruction_id: number;
        agent_id: string;
        market_id: string;
        option_id: string;
        direction: TradeDirection;
        quantity: number;
        fill_price: number;
        notional: number;
        pnl: number;
        created_at: string;
        metadata?: string | null;
        fee_amount?: number | null;
        fee_bps?: number | null;
        fee_meta?: string | null;
      }>;

    return rows.map((r) => ({
      id: r.id,
      tradeInstructionId: r.trade_instruction_id,
      agentId: r.agent_id,
      marketId: r.market_id,
      optionId: r.option_id,
      direction: r.direction,
      quantity: r.quantity,
      fillPrice: r.fill_price,
      notional: r.notional,
      pnl: r.pnl,
      createdAt: r.created_at,
      metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
      feeAmount: typeof r.fee_amount === 'number' ? r.fee_amount : undefined,
      feeBps: typeof r.fee_bps === 'number' ? r.fee_bps : undefined,
      feeMeta: r.fee_meta ? JSON.parse(r.fee_meta) : undefined
    }));
  }

  listRecentExits(limit: number = 50, agentId?: string) {
    const baseSql =
      `SELECT id, evaluation_id, agent_id, market_id, option_id, direction, notional, allocation_pct, expected_price, stop_price, take_profit_price, reason, created_at,
              live_status, live_order_id, executed_at
         FROM trade_instructions
         WHERE direction = 'sell' ${agentId ? 'AND agent_id = @agent_id' : ''}
         ORDER BY datetime(created_at) DESC`;
    const useLimit = Number.isFinite(limit) ? Math.floor(limit) : 50;
    const stmt = this.db.prepare(useLimit > 0 ? `${baseSql} LIMIT @limit` : baseSql);
    const rows = (useLimit > 0
      ? stmt.all({ agent_id: agentId, limit: useLimit })
      : stmt.all({ agent_id: agentId })) as Array<{
        id: number;
        evaluation_id: number | null;
        agent_id: string;
        market_id: string;
        option_id: string;
        direction: TradeDirection;
        notional: number;
        allocation_pct?: number | null;
        expected_price?: number | null;
        stop_price?: number | null;
        take_profit_price?: number | null;
        reason: string;
        created_at: string;
        live_status?: string | null;
        live_order_id?: string | null;
        executed_at?: string | null;
      }>;

    return rows.map((r) => ({
      id: r.id,
      evaluationId: r.evaluation_id ?? undefined,
      agentId: r.agent_id,
      marketId: r.market_id,
      optionId: r.option_id,
      direction: r.direction,
      notional: r.notional,
      allocationPct: r.allocation_pct ?? undefined,
      expectedPrice: r.expected_price ?? undefined,
      stopPrice: r.stop_price ?? undefined,
      takeProfitPrice: r.take_profit_price ?? undefined,
      reason: r.reason,
      createdAt: r.created_at,
      liveStatus: r.live_status ?? undefined,
      liveOrderId: r.live_order_id ?? undefined,
      executedAt: r.executed_at ?? undefined,
    }));
  }

  setTradeInstructionExecutionInfo(id: number, params: { executedAt?: Date | string; takerOrderId?: string }) {
    const fields: string[] = [];
    const args: any = { id };
    if (params.executedAt) {
      const ts = typeof params.executedAt === 'string' ? params.executedAt : (params.executedAt as Date).toISOString();
      fields.push('executed_at = @executed_at');
      args.executed_at = ts;
    }
    if (typeof params.takerOrderId === 'string') {
      fields.push('taker_order_id = @taker_order_id');
      args.taker_order_id = params.takerOrderId;
    }
    if (fields.length === 0) return;
    const sql = `UPDATE trade_instructions SET ${fields.join(', ')} WHERE id = @id`;
    this.db.prepare(sql).run(args);
  }

  getRun(id: number): { id: number; agentId: string; startedAt: string; completedAt?: string | null; status: RunStatus; metadata?: unknown } | undefined {
    const row = this.db
      .prepare(
        `SELECT id, agent_id, started_at, completed_at, status, metadata
         FROM agent_runs WHERE id = @id`
      )
      .get({ id }) as { id: number; agent_id: string; started_at: string; completed_at?: string | null; status: RunStatus; metadata?: string | null } | undefined;
    if (!row) return undefined;
    return { id: row.id, agentId: row.agent_id, startedAt: row.started_at, completedAt: row.completed_at ?? null, status: row.status, metadata: row.metadata ? JSON.parse(row.metadata) : undefined };
  }

  listEvaluationsByRun(runId: number) {
    const rows = this.db
      .prepare(
        `SELECT id, run_id, agent_id, market_id, title, outcomes_json, prices_json, quick_summary, trade_flag, evaluation_rationale, risk_notes, created_at
         FROM market_evaluations WHERE run_id = @run_id
         ORDER BY datetime(created_at) ASC`
      )
      .all({ run_id: runId }) as Array<{
        id: number; run_id: number; agent_id: string; market_id: string; title: string; outcomes_json: string; prices_json: string; quick_summary: string; trade_flag: number; evaluation_rationale: string; risk_notes?: string | null; created_at: string;
      }>;
    return rows.map((r) => ({
      id: r.id,
      runId: r.run_id,
      agentId: r.agent_id,
      marketId: r.market_id,
      title: r.title,
      outcomes: JSON.parse(r.outcomes_json),
      currentPrices: JSON.parse(r.prices_json),
      quickSummary: r.quick_summary,
      trade: !!r.trade_flag,
      evaluationRationale: r.evaluation_rationale,
      riskNotes: r.risk_notes ?? undefined,
      createdAt: r.created_at
    }));
  }

  listPlanDecisionsByRun(runId: number) {
    const rows = this.db
      .prepare(
        `SELECT d.id, d.evaluation_id, d.agent_id, d.market_id, d.outcome_id, d.status, d.reason, d.created_at
         FROM plan_decisions d
         INNER JOIN market_evaluations e ON e.id = d.evaluation_id
         WHERE e.run_id = @run_id
         ORDER BY datetime(d.created_at) ASC`
      )
      .all({ run_id: runId }) as Array<{ id: number; evaluation_id: number; agent_id: string; market_id: string; outcome_id?: string | null; status: 'accepted' | 'rejected'; reason?: string | null; created_at: string }>;
    return rows.map((r) => ({ id: r.id, evaluationId: r.evaluation_id, agentId: r.agent_id, marketId: r.market_id, outcomeId: r.outcome_id ?? undefined, status: r.status, reason: r.reason ?? undefined, createdAt: r.created_at }));
  }

  listTradeInstructionsByRun(runId: number) {
    const rows = this.db
      .prepare(
        `SELECT t.id, t.evaluation_id, t.agent_id, t.market_id, t.option_id, t.direction, t.notional, t.allocation_pct, t.expected_price, t.stop_price, t.take_profit_price, t.reason, t.created_at
         FROM trade_instructions t
         INNER JOIN market_evaluations e ON e.id = t.evaluation_id
         WHERE e.run_id = @run_id
         ORDER BY datetime(t.created_at) ASC`
      )
      .all({ run_id: runId }) as Array<{ id: number; evaluation_id: number; agent_id: string; market_id: string; option_id: string; direction: TradeDirection; notional: number; allocation_pct?: number | null; expected_price?: number | null; stop_price?: number | null; take_profit_price?: number | null; reason: string; created_at: string }>;
    return rows.map((r) => ({
      id: r.id,
      evaluationId: r.evaluation_id,
      agentId: r.agent_id,
      marketId: r.market_id,
      optionId: r.option_id,
      direction: r.direction,
      notional: r.notional,
      allocationPct: r.allocation_pct ?? undefined,
      expectedPrice: r.expected_price ?? undefined,
      stopPrice: r.stop_price ?? undefined,
      takeProfitPrice: r.take_profit_price ?? undefined,
      reason: r.reason,
      createdAt: r.created_at
    }));
  }

  listFillsByInstructionIds(ids: number[]) {
    if (ids.length === 0) return [] as Array<{ id: number; tradeInstructionId: number; agentId: string; marketId: string; optionId: string; direction: TradeDirection; quantity: number; fillPrice: number; notional: number; pnl: number; createdAt: string; metadata?: unknown; feeAmount?: number; feeBps?: number; feeMeta?: unknown }>;
    const rows = this.db
      .prepare(
        `SELECT id, trade_instruction_id, agent_id, market_id, option_id, direction, quantity, fill_price, notional, pnl, created_at, metadata, fee_amount, fee_bps, fee_meta
         FROM fills
         WHERE trade_instruction_id IN (${ids.map(() => '?').join(',')})
         ORDER BY datetime(created_at) ASC`
      )
      .all(ids) as Array<{ id: number; trade_instruction_id: number; agent_id: string; market_id: string; option_id: string; direction: TradeDirection; quantity: number; fill_price: number; notional: number; pnl: number; created_at: string; metadata?: string | null; fee_amount?: number | null; fee_bps?: number | null; fee_meta?: string | null }>;
    return rows.map((r) => ({ id: r.id, tradeInstructionId: r.trade_instruction_id, agentId: r.agent_id, marketId: r.market_id, optionId: r.option_id, direction: r.direction, quantity: r.quantity, fillPrice: r.fill_price, notional: r.notional, pnl: r.pnl, createdAt: r.created_at, metadata: r.metadata ? JSON.parse(r.metadata) : undefined, feeAmount: typeof r.fee_amount === 'number' ? r.fee_amount : undefined, feeBps: typeof r.fee_bps === 'number' ? r.fee_bps : undefined, feeMeta: r.fee_meta ? JSON.parse(r.fee_meta) : undefined }));
  }

  startRun(agentId: string, startedAt: Date, metadata?: Record<string, unknown>): number {
    const stmt = this.db.prepare(
      `
      INSERT INTO agent_runs (agent_id, started_at, status, metadata)
      VALUES (@agent_id, @started_at, @status, @metadata)
      `
    );

    const result = stmt.run({
      agent_id: agentId,
      started_at: toIso(startedAt),
      status: 'running',
      metadata: metadata ? JSON.stringify(metadata) : null
    });

    return Number(result.lastInsertRowid);
  }

  completeRun(runId: number, status: Exclude<RunStatus, 'running'>, completedAt: Date): void {
    const stmt = this.db.prepare(
      `
      UPDATE agent_runs
      SET status = @status, completed_at = @completed_at
      WHERE id = @id
      `
    );

    stmt.run({
      id: runId,
      status,
      completed_at: toIso(completedAt)
    });
  }

  recordMarketEvaluation(evaluation: MarketEvaluationInsert): number {
    const stmt = this.db.prepare(
      `
      INSERT INTO market_evaluations (
        run_id,
        agent_id,
        market_id,
        title,
        outcomes_json,
        prices_json,
        quick_summary,
        trade_flag,
        evaluation_rationale,
        risk_notes,
        created_at,
        status,
        debug_market_payload_json,
        debug_ai_input_json,
        debug_ai_output_json,
        evaluation_citations
      ) VALUES (
        @run_id,
        @agent_id,
        @market_id,
        @title,
        @outcomes_json,
        @prices_json,
        @quick_summary,
        @trade_flag,
        @evaluation_rationale,
        @risk_notes,
        @created_at,
        @status,
        @debug_market_payload_json,
        @debug_ai_input_json,
        @debug_ai_output_json,
        @evaluation_citations
      )
      `
    );

    const result = stmt.run({
      run_id: evaluation.runId,
      agent_id: evaluation.agentId,
      market_id: evaluation.marketId,
      title: evaluation.title,
      outcomes_json: JSON.stringify(evaluation.outcomes),
      prices_json: JSON.stringify(evaluation.currentPrices),
      quick_summary: evaluation.quickResearchSummary,
      trade_flag: evaluation.trade ? 1 : 0,
      rationale: evaluation.evaluationRationale,
      evaluation_rationale: evaluation.evaluationRationale,
      risk_notes: evaluation.riskNotes ?? null,
      created_at: toIso(evaluation.timestamp),
      status: evaluation.status ?? null,
      debug_market_payload_json: evaluation.debugMarketPayloadJson ? JSON.stringify(evaluation.debugMarketPayloadJson) : null,
      debug_ai_input_json: evaluation.debugAiInputJson ? JSON.stringify(evaluation.debugAiInputJson) : null,
      debug_ai_output_json: evaluation.debugAiOutputJson ? JSON.stringify(evaluation.debugAiOutputJson) : null,
      evaluation_citations: evaluation.evaluationCitations ? JSON.stringify(evaluation.evaluationCitations) : null
    });

    return Number(result.lastInsertRowid);
  }

  pruneEvaluationsByStatusBefore(status: string, cutoffIso: string): number {
    const stmt = this.db.prepare(
      `DELETE FROM market_evaluations WHERE status = @status AND datetime(created_at) < datetime(@cutoff)`
    );
    const res = stmt.run({ status, cutoff: cutoffIso });
    return Number(res.changes ?? 0);
  }

  recordTradeInstruction(instruction: TradeInstructionInsert): number {
    const stmt = this.db.prepare(
      `
      INSERT INTO trade_instructions (
        evaluation_id,
        agent_id,
        market_id,
        option_id,
        direction,
        notional,
        allocation_pct,
        expected_price,
        stop_price,
        take_profit_price,
        reason,
        created_at
      ) VALUES (
        @evaluation_id,
        @agent_id,
        @market_id,
        @option_id,
        @direction,
        @notional,
        @allocation_pct,
        @expected_price,
        @stop_price,
        @take_profit_price,
        @reason,
        @created_at
      )
      `
    );

    const result = stmt.run({
      evaluation_id: instruction.evaluationId ?? null,
      agent_id: instruction.agentId,
      market_id: instruction.marketId,
      option_id: instruction.optionId,
      direction: instruction.direction,
      notional: instruction.notional,
      allocation_pct: instruction.allocationPct ?? null,
      expected_price: instruction.expectedPrice ?? null,
      stop_price: instruction.stopPrice ?? null,
      take_profit_price: instruction.takeProfitPrice ?? null,
      reason: instruction.reason,
      created_at: toIso(instruction.createdAt)
    });

    return Number(result.lastInsertRowid);
  }

  recordFill(fill: FillInsert): number {
    const stmt = this.db.prepare(
      `
      INSERT INTO fills (
        trade_instruction_id,
        agent_id,
        market_id,
        option_id,
        direction,
        quantity,
        fill_price,
        notional,
        pnl,
        created_at,
        metadata,
        fee_amount,
        fee_bps,
        fee_meta
      ) VALUES (
        @trade_instruction_id,
        @agent_id,
        @market_id,
        @option_id,
        @direction,
        @quantity,
        @fill_price,
        @notional,
        @pnl,
        @created_at,
        @metadata,
        @fee_amount,
        @fee_bps,
        @fee_meta
      )
      `
    );

    const result = stmt.run({
      trade_instruction_id: fill.tradeInstructionId,
      agent_id: fill.agentId,
      market_id: fill.marketId,
      option_id: fill.optionId,
      direction: fill.direction,
      quantity: fill.quantity,
      fill_price: fill.fillPrice,
      notional: fill.notional,
      pnl: fill.pnl,
      created_at: toIso(fill.createdAt),
      metadata: fill.metadata ? JSON.stringify(fill.metadata) : null,
      fee_amount: typeof fill.feeAmount === 'number' ? fill.feeAmount : null,
      fee_bps: typeof fill.feeBps === 'number' ? fill.feeBps : null,
      fee_meta: fill.feeMeta ? JSON.stringify(fill.feeMeta) : null
    });

    return Number(result.lastInsertRowid);
  }

  recordPlanDecision(input: {
    evaluationId: number;
    agentId: string;
    marketId: string;
    outcomeId?: string;
    status: 'accepted' | 'rejected';
    reason?: string;
    tradeRationale?: string;
    createdAt: Date;
    debug?: unknown;
    citations?: string[];
  }): number {
    const stmt = this.db.prepare(
      `
      INSERT INTO plan_decisions (
        evaluation_id,
        agent_id,
        market_id,
        outcome_id,
        status,
        reason,
        trade_rationale,
        created_at,
        debug_json,
        decision_citations
      ) VALUES (
        @evaluation_id,
        @agent_id,
        @market_id,
        @outcome_id,
        @status,
        @reason,
        @trade_rationale,
        @created_at,
        @debug_json,
        @decision_citations
      )
      `
    );

    const result = stmt.run({
      evaluation_id: input.evaluationId,
      agent_id: input.agentId,
      market_id: input.marketId,
      outcome_id: input.outcomeId ?? null,
      status: input.status,
      reason: input.reason ?? null,
      trade_rationale: input.tradeRationale ?? null,
      created_at: toIso(input.createdAt),
      debug_json: input.debug ? JSON.stringify(input.debug) : null,
      decision_citations: input.citations ? JSON.stringify(input.citations) : null
    });

    return Number(result.lastInsertRowid);
  }

  // Latest trade rationale per (agentId, marketId, outcomeId)
  getLatestTradeRationale(agentId: string, marketId: string, outcomeId: string): { tradeRationale: string; createdAt: string } | undefined {
    const row = this.db
      .prepare(
        `SELECT trade_rationale, created_at
         FROM plan_decisions
         WHERE agent_id = @agent_id AND market_id = @market_id AND outcome_id = @outcome_id AND status = 'accepted' AND trade_rationale IS NOT NULL
         ORDER BY datetime(created_at) DESC
         LIMIT 1`
      )
      .get({ agent_id: agentId, market_id: marketId, outcome_id: outcomeId }) as { trade_rationale?: string | null; created_at: string } | undefined;
    if (!row || !row.trade_rationale) return undefined;
    return { tradeRationale: row.trade_rationale, createdAt: row.created_at };
  }

  // Latest decision citations per (agentId, marketId, outcomeId)
  getLatestDecisionCitations(agentId: string, marketId: string, outcomeId: string): { citations: string[]; createdAt: string } | undefined {
    const row = this.db
      .prepare(
        `SELECT decision_citations, created_at
         FROM plan_decisions
         WHERE agent_id = @agent_id AND market_id = @market_id AND outcome_id = @outcome_id AND status = 'accepted' AND decision_citations IS NOT NULL
         ORDER BY datetime(created_at) DESC
         LIMIT 1`
      )
      .get({ agent_id: agentId, market_id: marketId, outcome_id: outcomeId }) as { decision_citations?: string | null; created_at: string } | undefined;
    if (!row || !row.decision_citations) return undefined;
    return { citations: JSON.parse(row.decision_citations), createdAt: row.created_at };
  }

  // Allow optional openedAt for first-time insert (used by live→DB sync); updates never change openedAt
  upsertPosition(position: Omit<PositionSnapshot, 'id' | 'openedAt' | 'updatedAt'> & { id?: number; openedAt?: Date }): PositionSnapshot {
    const now = toIso(new Date());
    const payload = {
      agent_id: position.agentId,
      market_id: position.marketId,
      option_id: position.optionId,
      direction: position.direction,
      quantity: position.quantity,
      average_price: position.averagePrice,
      status: position.status
    };

    const existing = this.db
      .prepare(
        `
        SELECT id, opened_at, updated_at FROM positions
        WHERE agent_id = @agent_id AND market_id = @market_id AND option_id = @option_id
        `
      )
      .get(payload) as { id: number; opened_at: string; updated_at: string } | undefined;

    if (existing) {
      this.db
        .prepare(
          `
          UPDATE positions
          SET quantity = @quantity,
              average_price = @average_price,
              status = @status,
              updated_at = @updated_at
          WHERE id = @id
          `
        )
        .run({
          id: existing.id,
          quantity: payload.quantity,
          average_price: payload.average_price,
          status: payload.status,
          updated_at: now
        });

      return {
        id: existing.id,
        agentId: payload.agent_id,
        marketId: payload.market_id,
        optionId: payload.option_id,
        direction: payload.direction as TradeDirection,
        quantity: payload.quantity,
        averagePrice: payload.average_price,
        status: payload.status as PositionSnapshot['status'],
        openedAt: new Date(existing.opened_at),
        updatedAt: new Date(now)
      };
    }

    const result = this.db
      .prepare(
        `
        INSERT INTO positions (
          agent_id,
          market_id,
          option_id,
          direction,
          quantity,
          average_price,
          status,
          opened_at,
          updated_at
        ) VALUES (
          @agent_id,
          @market_id,
          @option_id,
          @direction,
          @quantity,
          @average_price,
          @status,
          @opened_at,
          @updated_at
        )
        `
      )
      .run({
        ...payload,
        opened_at: position.openedAt ? toIso(position.openedAt) : now,
        updated_at: now
      });

    return {
      id: Number(result.lastInsertRowid),
      agentId: payload.agent_id,
      marketId: payload.market_id,
      optionId: payload.option_id,
      direction: payload.direction as TradeDirection,
      quantity: payload.quantity,
      averagePrice: payload.average_price,
      status: payload.status as PositionSnapshot['status'],
      openedAt: position.openedAt ? new Date(toIso(position.openedAt)) : new Date(now),
      updatedAt: new Date(now)
    };
  }

  closePosition(agentId: string, marketId: string, optionId: string, closedAt: Date): void {
    this.db
      .prepare(
        `
        UPDATE positions
        SET status = 'closed',
            updated_at = @closed_at
        WHERE agent_id = @agent_id AND market_id = @market_id AND option_id = @option_id
        `
      )
      .run({
        agent_id: agentId,
        market_id: marketId,
        option_id: optionId,
        closed_at: toIso(closedAt)
      });
  }

  listAllPositions(agentId: string): PositionSnapshot[] {
    const rows = this.db
      .prepare(
        `
        SELECT * FROM positions
        WHERE agent_id = @agent_id
        ORDER BY datetime(updated_at) DESC
        `
      )
      .all({ agent_id: agentId }) as Array<{
        id: number;
        agent_id: string;
        market_id: string;
        option_id: string;
        direction: TradeDirection;
        quantity: number;
        average_price: number;
        status: string;
        opened_at: string;
        updated_at: string;
      }>;

    return rows.map((row) => ({
      id: row.id,
      agentId: row.agent_id,
      marketId: row.market_id,
      optionId: row.option_id,
      direction: row.direction,
      quantity: row.quantity,
      averagePrice: row.average_price,
      status: row.status as PositionSnapshot['status'],
      openedAt: new Date(row.opened_at),
      updatedAt: new Date(row.updated_at)
    }));
  }

  listOpenPositions(agentId: string): PositionSnapshot[] {
    const rows = this.db
      .prepare(
        `
        SELECT * FROM positions
        WHERE agent_id = @agent_id AND status = 'open'
        `
      )
      .all({ agent_id: agentId }) as Array<{
        id: number;
        agent_id: string;
        market_id: string;
        option_id: string;
        direction: TradeDirection;
        quantity: number;
        average_price: number;
        status: string;
        opened_at: string;
        updated_at: string;
      }>;

    return rows.map((row) => ({
      id: row.id,
      agentId: row.agent_id,
      marketId: row.market_id,
      optionId: row.option_id,
      direction: row.direction,
      quantity: row.quantity,
      averagePrice: row.average_price,
      status: row.status as PositionSnapshot['status'],
      openedAt: new Date(row.opened_at),
      updatedAt: new Date(row.updated_at)
    }));
  }

  getPortfolioState(
    agentId: string,
    baseCurrency: string,
    initialBalance: number
  ): {
    agentId: string;
    cashBalance: number;
    reservedBalance: number;
    realizedPnl: number;
    baseCurrency: string;
    updatedAt: Date;
  } {
    const stmt = this.db.prepare(
      `
      SELECT agent_id, cash_balance, reserved_balance, realized_pnl, base_currency, updated_at
      FROM portfolio_state
      WHERE agent_id = @agent_id
      `
    );
    const row = stmt.get({ agent_id: agentId }) as
      | {
          agent_id: string;
          cash_balance: number;
          reserved_balance: number;
          realized_pnl: number;
          base_currency: string;
          updated_at: string;
        }
      | undefined;

    if (row) {
      return {
        agentId: row.agent_id,
        cashBalance: row.cash_balance,
        reservedBalance: row.reserved_balance,
        realizedPnl: row.realized_pnl,
        baseCurrency: row.base_currency,
        updatedAt: new Date(row.updated_at)
      };
    }

    this.db
      .prepare(
        `
        INSERT INTO portfolio_state (
          agent_id,
          cash_balance,
          reserved_balance,
          realized_pnl,
          base_currency,
          updated_at
        ) VALUES (
          @agent_id,
          @cash_balance,
          @reserved_balance,
          @realized_pnl,
          @base_currency,
          @updated_at
        )
        `
      )
      .run({
        agent_id: agentId,
        cash_balance: initialBalance,
        reserved_balance: 0,
        realized_pnl: 0,
        base_currency: baseCurrency,
        updated_at: toIso(new Date())
      });

    return this.getPortfolioState(agentId, baseCurrency, initialBalance);
  }

  updatePortfolioState(agentId: string, state: { cashBalance: number; reservedBalance: number; realizedPnl: number; baseCurrency: string }) {
    this.db
      .prepare(
        `
        UPDATE portfolio_state
        SET cash_balance = @cash_balance,
            reserved_balance = @reserved_balance,
            realized_pnl = @realized_pnl,
            base_currency = @base_currency,
            updated_at = @updated_at
        WHERE agent_id = @agent_id
        `
      )
      .run({
        agent_id: agentId,
        cash_balance: state.cashBalance,
        reserved_balance: state.reservedBalance,
        realized_pnl: state.realizedPnl,
        base_currency: state.baseCurrency,
        updated_at: toIso(new Date())
      });
  }

  buildPortfolioSnapshot(agentId: string, baseCurrency: string, initialBalance: number): PortfolioSnapshot {
    const state = this.getPortfolioState(agentId, baseCurrency, initialBalance);
    const positions = this.listOpenPositions(agentId);
    const marks = this.getPositionMarks(agentId);
    const unrealized = positions.reduce((acc, p) => {
      const key = `${p.marketId}:${p.optionId}`;
      const m = marks.get(key);
      const bid = m?.bestBid ?? undefined;
      if (typeof bid === 'number') {
        return acc + (bid - p.averagePrice) * p.quantity;
      }
      return acc;
    }, 0);

    return {
      agentId,
      cashBalance: state.cashBalance,
      reservedBalance: state.reservedBalance,
      realizedPnl: state.realizedPnl,
      baseCurrency,
      unrealizedPnl: unrealized,
      positions
    };
  }

  getLastFillTime(agentId: string, marketId: string): Date | undefined {
    const row = this.db
      .prepare(
        `
        SELECT MAX(created_at) as last
        FROM fills
        WHERE agent_id = @agent_id AND market_id = @market_id
        `
      )
      .get({ agent_id: agentId, market_id: marketId }) as { last?: string } | undefined;

    return row?.last ? new Date(row.last) : undefined;
  }

  // Cooldowns ---------------------------------------------------------
  upsertMarketCooldown(params: { agentId: string; marketId: string; reason: string; expiresAt: Date; updatedAt?: Date }): void {
    const updatedAt = params.updatedAt ?? new Date();
    this.db
      .prepare(
        `
        INSERT INTO market_cooldowns (agent_id, market_id, reason, updated_at, expires_at)
        VALUES (@agent_id, @market_id, @reason, @updated_at, @expires_at)
        ON CONFLICT(agent_id, market_id, reason)
        DO UPDATE SET updated_at = excluded.updated_at, expires_at = excluded.expires_at
        `
      )
      .run({
        agent_id: params.agentId,
        market_id: params.marketId,
        reason: params.reason,
        updated_at: toIso(updatedAt),
        expires_at: toIso(params.expiresAt)
      });
  }

  clearMarketCooldowns(agentId: string, marketId: string, reason?: string): void {
    if (reason) {
      this.db
        .prepare(
          `DELETE FROM market_cooldowns WHERE agent_id = @agent_id AND market_id = @market_id AND reason = @reason`
        )
        .run({ agent_id: agentId, market_id: marketId, reason });
      return;
    }

    this.db
      .prepare(
        `DELETE FROM market_cooldowns WHERE agent_id = @agent_id AND market_id = @market_id`
      )
      .run({ agent_id: agentId, market_id: marketId });
  }

  /**
   * Returns active cooldown reasons after pruning any expired entries.
   */
  getActiveCooldownReasons(agentId: string, marketId: string, now: Date = new Date()): string[] {
    // prune expired
    this.db
      .prepare(`DELETE FROM market_cooldowns WHERE datetime(expires_at) <= datetime(@now)`)
      .run({ now: toIso(now) });

    const rows = this.db
      .prepare(
        `SELECT reason FROM market_cooldowns
         WHERE agent_id = @agent_id AND market_id = @market_id AND datetime(expires_at) > datetime(@now)`
      )
      .all({ agent_id: agentId, market_id: marketId, now: toIso(now) }) as Array<{ reason: string }>;

    return rows.map((r) => r.reason);
  }

  // Position marks ---------------------------------------------------
  setPositionMark(params: { agentId: string; marketId: string; optionId: string; bestBid?: number; bestAsk?: number; mid?: number; markedAt?: Date }) {
    const markedAt = params.markedAt ?? new Date();
    this.db
      .prepare(
        `INSERT INTO position_marks (agent_id, market_id, option_id, best_bid, best_ask, mid, marked_at)
         VALUES (@agent_id, @market_id, @option_id, @best_bid, @best_ask, @mid, @marked_at)
         ON CONFLICT(agent_id, market_id, option_id)
         DO UPDATE SET best_bid = excluded.best_bid, best_ask = excluded.best_ask, mid = excluded.mid, marked_at = excluded.marked_at`
      )
      .run({
        agent_id: params.agentId,
        market_id: params.marketId,
        option_id: params.optionId,
        best_bid: typeof params.bestBid === 'number' ? params.bestBid : null,
        best_ask: typeof params.bestAsk === 'number' ? params.bestAsk : null,
        mid: typeof params.mid === 'number' ? params.mid : null,
        marked_at: toIso(markedAt)
      });
  }

  getPositionMarks(agentId: string): Map<string, { bestBid?: number; bestAsk?: number; mid?: number; markedAt: Date }> {
    const rows = this.db
      .prepare(
        `SELECT market_id, option_id, best_bid, best_ask, mid, marked_at
         FROM position_marks WHERE agent_id = @agent_id`
      )
      .all({ agent_id: agentId }) as Array<{ market_id: string; option_id: string; best_bid?: number | null; best_ask?: number | null; mid?: number | null; marked_at: string }>;
    const map = new Map<string, { bestBid?: number; bestAsk?: number; mid?: number; markedAt: Date }>();
    for (const r of rows) {
      map.set(`${r.market_id}:${r.option_id}`, {
        bestBid: r.best_bid ?? undefined,
        bestAsk: r.best_ask ?? undefined,
        mid: r.mid ?? undefined,
        markedAt: new Date(r.marked_at)
      });
    }
    return map;
  }

  // Token resolution cache ----------------------------------------------------
  getResolvedClobTokenId(marketId: string, outcomeIndex: number): string | undefined {
    const row = this.db
      .prepare(
        `SELECT clob_token_id FROM token_resolution_map WHERE market_id = @market_id AND outcome_index = @outcome_index`
      )
      .get({ market_id: marketId, outcome_index: outcomeIndex }) as { clob_token_id?: string } | undefined;
    return row?.clob_token_id ?? undefined;
  }

  upsertResolvedClobTokenId(params: { marketId: string; outcomeIndex: number; clobTokenId: string; source?: string; resolvedAt?: Date }): void {
    const { marketId, outcomeIndex, clobTokenId, source, resolvedAt } = params;
    this.db
      .prepare(
        `INSERT INTO token_resolution_map (market_id, outcome_index, clob_token_id, source, resolved_at)
         VALUES (@market_id, @outcome_index, @clob_token_id, @source, @resolved_at)
         ON CONFLICT(market_id, outcome_index)
         DO UPDATE SET clob_token_id = excluded.clob_token_id, source = excluded.source, resolved_at = excluded.resolved_at`
      )
      .run({ market_id: marketId, outcome_index: outcomeIndex, clob_token_id: clobTokenId, source: source ?? null, resolved_at: (resolvedAt ?? new Date()).toISOString() });
  }

  // Closed positions (live rounds) -------------------------------------------
  recordClosedPositions(
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
  ): void {
    if (!positions.length) return;
    const stmt = this.db.prepare(
      `INSERT INTO closed_positions (
         agent_id, market_id, option_id, quantity,
         average_price, exit_price, realized_pnl, fees_paid, closed_at
       ) VALUES (
         @agent_id, @market_id, @option_id, @quantity,
         @average_price, @exit_price, @realized_pnl, @fees_paid, @closed_at
       )
       ON CONFLICT(agent_id, market_id, option_id, closed_at) DO UPDATE SET
         quantity = excluded.quantity,
         average_price = excluded.average_price,
         exit_price = excluded.exit_price,
         realized_pnl = excluded.realized_pnl,
         fees_paid = excluded.fees_paid`,
    );
    for (const p of positions) {
      stmt.run({
        agent_id: agentId,
        market_id: p.marketId,
        option_id: p.optionId,
        quantity: p.quantity,
        average_price: p.averagePrice,
        exit_price: p.exitPrice,
        realized_pnl: p.realizedPnl,
        fees_paid: p.feesPaid,
        closed_at: p.closedAt,
      });
    }
  }

  listRecentClosedPositions(
    limit: number = 50,
    agentId?: string,
    offset: number = 0,
    filters?: { marketId?: string; optionId?: string },
  ): Array<{
    agentId: string;
    marketId: string;
    optionId: string;
    quantity: number;
    averagePrice: number;
    exitPrice: number;
    realizedPnl: number;
    feesPaid: number;
    closedAt: string;
  }> {
    const baseSql = `SELECT agent_id, market_id, option_id, quantity, average_price, exit_price, realized_pnl, fees_paid, closed_at
                     FROM closed_positions`;
    const useLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 50;
    const useOffset = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
    const clauses: string[] = [];
    if (agentId) clauses.push('agent_id = @agent_id');
    if (filters?.marketId) clauses.push('market_id = @market_id');
    if (filters?.optionId) clauses.push('option_id = @option_id');
    let sql = clauses.length ? `${baseSql} WHERE ${clauses.join(' AND ')}` : baseSql;
    sql = `${sql} ORDER BY datetime(closed_at) DESC`;
    if (useLimit > 0) sql = `${sql} LIMIT @limit`;
    if (useOffset > 0) sql = `${sql} OFFSET @offset`;
    const stmt = this.db.prepare(sql);
    const params: Record<string, number | string> = {};
    if (useLimit > 0) params.limit = useLimit;
    if (useOffset > 0) params.offset = useOffset;
    if (agentId) params.agent_id = agentId;
    if (filters?.marketId) params.market_id = filters.marketId;
    if (filters?.optionId) params.option_id = filters.optionId;
    const rows = stmt.all(params) as Array<{
      agent_id: string;
      market_id: string;
      option_id: string;
      quantity: number;
      average_price: number;
      exit_price: number;
      realized_pnl: number;
      fees_paid: number;
      closed_at: string;
    }>;
    return rows.map((r) => ({
      agentId: r.agent_id,
      marketId: r.market_id,
      optionId: r.option_id,
      quantity: r.quantity,
      averagePrice: r.average_price,
      exitPrice: r.exit_price,
      realizedPnl: r.realized_pnl,
      feesPaid: r.fees_paid,
      closedAt: r.closed_at,
    }));
  }

  countClosedPositions(agentId?: string, filters?: { marketId?: string; optionId?: string }): number {
    const clauses: string[] = [];
    if (agentId) clauses.push('agent_id = @agent_id');
    if (filters?.marketId) clauses.push('market_id = @market_id');
    if (filters?.optionId) clauses.push('option_id = @option_id');
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const stmt = this.db.prepare(
      `SELECT COUNT(1) AS cnt FROM closed_positions ${where}`,
    );
    const params: Record<string, string> = {};
    if (agentId) params.agent_id = agentId;
    if (filters?.marketId) params.market_id = filters.marketId;
    if (filters?.optionId) params.option_id = filters.optionId;
    const row = stmt.get(params) as { cnt?: number } | undefined;
    const value = row?.cnt;
    return typeof value === 'number' ? value : 0;
  }

  getTotalRealizedPnlFromClosed(agentId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(realized_pnl), 0) AS sum_pnl
         FROM closed_positions
         WHERE agent_id = @agent_id`,
      )
      .get({ agent_id: agentId }) as { sum_pnl?: number } | undefined;
    return typeof row?.sum_pnl === 'number' ? row.sum_pnl : 0;
  }

  // Portfolio history --------------------------------------------------------
  recordPortfolioHistory(params: { agentId: string; ts: number; equity: number; realizedPnl: number; unrealizedPnl: number }): void {
    this.db
      .prepare(
        `INSERT INTO portfolio_history (agent_id, ts, equity, realized_pnl, unrealized_pnl)
         VALUES (@agent_id, @ts, @equity, @realized_pnl, @unrealized_pnl)
         ON CONFLICT(agent_id, ts) DO UPDATE SET equity = excluded.equity, realized_pnl = excluded.realized_pnl, unrealized_pnl = excluded.unrealized_pnl`
      )
      .run({
        agent_id: params.agentId,
        ts: Math.floor(params.ts),
        equity: params.equity,
        realized_pnl: params.realizedPnl,
        unrealized_pnl: params.unrealizedPnl
      });
  }

  getLatestPortfolioHistory(agentId: string): { ts: number; equity: number; realizedPnl: number; unrealizedPnl: number } | undefined {
    const row = this.db
      .prepare(
        `SELECT ts, equity, realized_pnl, unrealized_pnl
         FROM portfolio_history
         WHERE agent_id = @agent_id
         ORDER BY ts DESC
         LIMIT 1`
      )
      .get({ agent_id: agentId }) as { ts: number; equity: number; realized_pnl: number; unrealized_pnl: number } | undefined;
    if (!row) return undefined;
    return { ts: Number(row.ts), equity: row.equity, realizedPnl: row.realized_pnl, unrealizedPnl: row.unrealized_pnl };
  }

  // Token resolution (reverse): get outcome index by clob token id for a market
  getOutcomeIndexByClobTokenId(marketId: string, clobTokenId: string): number | undefined {
    const row = this.db
      .prepare(
        `SELECT outcome_index FROM token_resolution_map WHERE market_id = @market_id AND clob_token_id = @clob_token_id`
      )
      .get({ market_id: marketId, clob_token_id: clobTokenId }) as { outcome_index?: number } | undefined;
    return typeof row?.outcome_index === 'number' ? row!.outcome_index : undefined;
  }

  // Latest evaluation summary for a given market (any agent)
  getLatestEvaluationSummary(marketId: string): { title: string; outcomes: Array<{ id: string; name: string }>; url?: string } | undefined {
    const row = this.db
      .prepare(
        `SELECT title, outcomes_json, debug_market_payload_json
         FROM market_evaluations
         WHERE market_id = @market_id
         ORDER BY datetime(created_at) DESC
         LIMIT 1`
      )
      .get({ market_id: marketId }) as { title: string; outcomes_json: string; debug_market_payload_json?: string | null } | undefined;
    if (!row) return undefined;
    let outcomes: Array<{ id: string; name: string }> = [];
    try { outcomes = JSON.parse(row.outcomes_json) as Array<{ id: string; name: string }>; } catch {}

    let url: string | undefined;
    if (row.debug_market_payload_json) {
      try {
        const payload = JSON.parse(row.debug_market_payload_json);
        if (Array.isArray(payload)) {
          const entry = payload.find((x: any) => x && (x.url || x.slug));
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

    return { title: row.title, outcomes, url };
  }

  getEarliestPortfolioHistory(agentId: string): { ts: number; equity: number; realizedPnl: number; unrealizedPnl: number } | undefined {
    const row = this.db
      .prepare(
        `SELECT ts, equity, realized_pnl, unrealized_pnl
         FROM portfolio_history
         WHERE agent_id = @agent_id
         ORDER BY ts ASC
         LIMIT 1`
      )
      .get({ agent_id: agentId }) as { ts: number; equity: number; realized_pnl: number; unrealized_pnl: number } | undefined;
    if (!row) return undefined;
    return { ts: Number(row.ts), equity: row.equity, realizedPnl: row.realized_pnl, unrealizedPnl: row.unrealized_pnl };
  }

  getEarliestRunStart(agentId?: string): number | undefined {
    const row = this.db
      .prepare(
        `SELECT started_at FROM agent_runs
         ${agentId ? 'WHERE agent_id = @agent_id' : ''}
         ORDER BY datetime(started_at) ASC
         LIMIT 1`
      )
      .get({ agent_id: agentId }) as { started_at: string } | undefined;
    if (!row) return undefined;
    const ts = Date.parse(row.started_at);
    return Number.isFinite(ts) ? ts : undefined;
  }

  listPortfolioHistoryBetween(agentId: string, startTs: number, endTs: number): Array<{ ts: number; equity: number; realizedPnl: number; unrealizedPnl: number }> {
    const rows = this.db
      .prepare(
        `SELECT ts, equity, realized_pnl, unrealized_pnl
         FROM portfolio_history
         WHERE agent_id = @agent_id AND ts >= @start_ts AND ts <= @end_ts
         ORDER BY ts ASC`
      )
      .all({ agent_id: agentId, start_ts: Math.floor(startTs), end_ts: Math.floor(endTs) }) as Array<{ ts: number; equity: number; realized_pnl: number; unrealized_pnl: number }>;
    return rows.map((r) => ({ ts: Number(r.ts), equity: r.equity, realizedPnl: r.realized_pnl, unrealizedPnl: r.unrealized_pnl }));
  }

  prunePortfolioHistoryBefore(agentId: string, cutoffTs: number): number {
    const info = this.db
      .prepare(
        `DELETE FROM portfolio_history WHERE agent_id = @agent_id AND ts < @cutoff`
      )
      .run({ agent_id: agentId, cutoff: Math.floor(cutoffTs) });
    // changes is the number of rows deleted
    return info.changes as number;
  }
}
