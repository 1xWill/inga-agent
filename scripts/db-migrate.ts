#!/usr/bin/env tsx
/*
  Postgres schema migration script
  - Connects to DATABASE_URL and creates all required tables/indexes idempotently.
  - Intended for Railway: run via `npm run db:migrate` after deploying services.
*/
import 'dotenv/config';
import { exit } from 'node:process';

// Defer import to avoid requiring pg in environments that don't use it
async function main() {
  const url = process.env.DATABASE_URL;
  const driver = (process.env.DB_DRIVER || '').toLowerCase();
  if (!url) {
    console.error('[db:migrate] Missing DATABASE_URL');
    exit(1);
  }
  if (driver && driver !== 'postgres' && driver !== 'pg') {
    console.warn(`[db:migrate] DB_DRIVER=${driver} (continuing anyway for Postgres DDL)`);
  }

  const { Pool } = await import('pg');
  const pool = new Pool({
    connectionString: url,
    max: Number(process.env.PGPOOL_MAX || 5),
    idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS ?? 30_000),
    connectionTimeoutMillis: Number(process.env.PG_CONNECTION_TIMEOUT_MS ?? 5_000),
    keepAlive: true,
    application_name: process.env.PG_APP_NAME || 'inga-migrate',
  } as any);
  const client = await pool.connect();
  try {
    const stmts: string[] = [
      // agent_runs
      `CREATE TABLE IF NOT EXISTS agent_runs (
        id BIGSERIAL PRIMARY KEY,
        agent_id TEXT NOT NULL,
        started_at TIMESTAMPTZ NOT NULL,
        completed_at TIMESTAMPTZ NULL,
        status TEXT NOT NULL,
        metadata JSONB
      )`,

      // market_evaluations
      `CREATE TABLE IF NOT EXISTS market_evaluations (
        id BIGSERIAL PRIMARY KEY,
        run_id BIGINT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        market_id TEXT NOT NULL,
        title TEXT NOT NULL,
        outcomes_json JSONB NOT NULL,
        prices_json JSONB NOT NULL,
        quick_summary TEXT NOT NULL,
        trade_flag BOOLEAN NOT NULL,
        evaluation_rationale TEXT NOT NULL,
        risk_notes TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        status TEXT,
        debug_market_payload_json JSONB,
        debug_ai_input_json JSONB,
        debug_ai_output_json JSONB,
        evaluation_citations JSONB
      )`,

      // trade_instructions
      `CREATE TABLE IF NOT EXISTS trade_instructions (
        id BIGSERIAL PRIMARY KEY,
        evaluation_id BIGINT NULL,
        agent_id TEXT NOT NULL,
        market_id TEXT NOT NULL,
        option_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        notional NUMERIC NOT NULL,
        allocation_pct NUMERIC NULL,
        expected_price NUMERIC NULL,
        stop_price NUMERIC NULL,
        take_profit_price NUMERIC NULL,
        reason TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        live_order_id TEXT,
        live_status TEXT,
        live_error TEXT,
        live_last_update TIMESTAMPTZ,
        executed_at TIMESTAMPTZ,
        taker_order_id TEXT
      )`,

      // fills
      `CREATE TABLE IF NOT EXISTS fills (
        id BIGSERIAL PRIMARY KEY,
        trade_instruction_id BIGINT NOT NULL REFERENCES trade_instructions(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        market_id TEXT NOT NULL,
        option_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        quantity NUMERIC NOT NULL,
        fill_price NUMERIC NOT NULL,
        notional NUMERIC NOT NULL,
        pnl NUMERIC NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        metadata JSONB,
        fee_amount NUMERIC,
        fee_bps NUMERIC,
        fee_meta JSONB
      )`,

      // positions
      `CREATE TABLE IF NOT EXISTS positions (
        id BIGSERIAL PRIMARY KEY,
        agent_id TEXT NOT NULL,
        market_id TEXT NOT NULL,
        option_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        quantity NUMERIC NOT NULL,
        average_price NUMERIC NOT NULL,
        status TEXT NOT NULL,
        opened_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )`,
      `DO $$ BEGIN
         CREATE UNIQUE INDEX IF NOT EXISTS idx_positions_agent_market_option
           ON positions(agent_id, market_id, option_id);
       END $$;`,

      // portfolio_state
      `CREATE TABLE IF NOT EXISTS portfolio_state (
        agent_id TEXT PRIMARY KEY,
        cash_balance NUMERIC NOT NULL,
        reserved_balance NUMERIC NOT NULL,
        realized_pnl NUMERIC NOT NULL,
        base_currency TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )`,

      // plan_decisions
      `CREATE TABLE IF NOT EXISTS plan_decisions (
        id BIGSERIAL PRIMARY KEY,
        evaluation_id BIGINT NOT NULL,
        agent_id TEXT NOT NULL,
        market_id TEXT NOT NULL,
        outcome_id TEXT,
        status TEXT NOT NULL,
        reason TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        trade_rationale TEXT,
        debug_json JSONB,
        decision_citations JSONB
      )`,

      // market_cooldowns
      `CREATE TABLE IF NOT EXISTS market_cooldowns (
        agent_id TEXT NOT NULL,
        market_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (agent_id, market_id, reason)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_market_cooldowns_expires ON market_cooldowns(expires_at)`,

      // discovery_cursor
      `CREATE TABLE IF NOT EXISTS discovery_cursor (
        agent_id TEXT PRIMARY KEY,
        cursor TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )`,

      // position_marks
      `CREATE TABLE IF NOT EXISTS position_marks (
        agent_id TEXT NOT NULL,
        market_id TEXT NOT NULL,
        option_id TEXT NOT NULL,
        best_bid NUMERIC,
        best_ask NUMERIC,
        mid NUMERIC,
        marked_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (agent_id, market_id, option_id)
      )`,

      // token_resolution_map
      `CREATE TABLE IF NOT EXISTS token_resolution_map (
        market_id TEXT NOT NULL,
        outcome_index INTEGER NOT NULL,
        clob_token_id TEXT NOT NULL,
        source TEXT,
        resolved_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (market_id, outcome_index)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_token_resolution_reverse ON token_resolution_map(market_id, clob_token_id)`,

      // portfolio_history
      `CREATE TABLE IF NOT EXISTS portfolio_history (
        agent_id TEXT NOT NULL,
        ts BIGINT NOT NULL,
        equity NUMERIC NOT NULL,
        realized_pnl NUMERIC NOT NULL,
        unrealized_pnl NUMERIC NOT NULL,
        PRIMARY KEY (agent_id, ts)
      )`,

      // closed_positions: persistent closed rounds per agent/market/option
      `CREATE TABLE IF NOT EXISTS closed_positions (
        agent_id TEXT NOT NULL,
        market_id TEXT NOT NULL,
        option_id TEXT NOT NULL,
        quantity NUMERIC NOT NULL,
        average_price NUMERIC NOT NULL,
        exit_price NUMERIC NOT NULL,
        realized_pnl NUMERIC NOT NULL,
        fees_paid NUMERIC NOT NULL,
        closed_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (agent_id, market_id, option_id, closed_at)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_closed_positions_agent_closed ON closed_positions(agent_id, closed_at DESC)`,

      // Helpful indexes for recent lists and live lookups
      `CREATE INDEX IF NOT EXISTS idx_trade_instructions_agent_created ON trade_instructions(agent_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_fills_agent_created ON fills(agent_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_market_eval_agent_created ON market_evaluations(agent_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_trade_instructions_live_order ON trade_instructions(live_order_id)`
    ];

    for (const sql of stmts) {
      await client.query(sql);
    }
    console.log('[db:migrate] Completed');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error('[db:migrate] Error', e);
  exit(1);
});
