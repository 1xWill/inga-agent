import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import Database from "better-sqlite3";
import type { Database as SqliteDatabase } from "better-sqlite3";

const DEFAULT_DB_PATH = "data/inga.sqlite";

export interface DatabaseOptions {
  filePath?: string;
  inMemory?: boolean;
}

export function openDatabase(options: DatabaseOptions = {}): SqliteDatabase {
  const { filePath, inMemory } = options;
  if (inMemory) {
    return new Database(":memory:");
  }

  const targetPath = resolve(filePath ?? DEFAULT_DB_PATH);
  mkdirSync(dirname(targetPath), { recursive: true });
  return new Database(targetPath);
}

export function initializeSchema(db: SqliteDatabase): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS agent_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      status TEXT NOT NULL,
      metadata JSON
    );

    CREATE TABLE IF NOT EXISTS market_evaluations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      agent_id TEXT NOT NULL,
      market_id TEXT NOT NULL,
      title TEXT NOT NULL,
      outcomes_json TEXT NOT NULL,
      prices_json TEXT NOT NULL,
      quick_summary TEXT NOT NULL,
      trade_flag INTEGER NOT NULL,
      evaluation_rationale TEXT NOT NULL,
      risk_notes TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS trade_instructions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      evaluation_id INTEGER,
      agent_id TEXT NOT NULL,
      market_id TEXT NOT NULL,
      option_id TEXT NOT NULL,
      direction TEXT NOT NULL,
      notional REAL NOT NULL,
      allocation_pct REAL,
      expected_price REAL,
      stop_price REAL,
      take_profit_price REAL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS fills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trade_instruction_id INTEGER NOT NULL,
      agent_id TEXT NOT NULL,
      market_id TEXT NOT NULL,
      option_id TEXT NOT NULL,
      direction TEXT NOT NULL,
      quantity REAL NOT NULL,
      fill_price REAL NOT NULL,
      notional REAL NOT NULL,
      pnl REAL NOT NULL,
      created_at TEXT NOT NULL,
      metadata JSON,
      FOREIGN KEY (trade_instruction_id) REFERENCES trade_instructions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      market_id TEXT NOT NULL,
      option_id TEXT NOT NULL,
      direction TEXT NOT NULL,
      quantity REAL NOT NULL,
      average_price REAL NOT NULL,
      status TEXT NOT NULL,
      opened_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_positions_agent_market_option
      ON positions(agent_id, market_id, option_id);

    CREATE TABLE IF NOT EXISTS portfolio_state (
      agent_id TEXT PRIMARY KEY,
      cash_balance REAL NOT NULL,
      reserved_balance REAL NOT NULL,
      realized_pnl REAL NOT NULL,
      base_currency TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS plan_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      evaluation_id INTEGER NOT NULL,
      agent_id TEXT NOT NULL,
      market_id TEXT NOT NULL,
      outcome_id TEXT,
      status TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL
    );

    -- Tracks temporary suppression of markets for specific reasons (e.g., no-trade evaluation, planner rejection)
    CREATE TABLE IF NOT EXISTS market_cooldowns (
      agent_id TEXT NOT NULL,
      market_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY (agent_id, market_id, reason)
    );

    CREATE INDEX IF NOT EXISTS idx_market_cooldowns_expires
      ON market_cooldowns(expires_at);

    -- Persists market discovery cursor per agent across runs
    CREATE TABLE IF NOT EXISTS discovery_cursor (
      agent_id TEXT PRIMARY KEY,
      cursor TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- Last marks for open positions (updated by monitor loop)
    CREATE TABLE IF NOT EXISTS position_marks (
      agent_id TEXT NOT NULL,
      market_id TEXT NOT NULL,
      option_id TEXT NOT NULL,
      best_bid REAL,
      best_ask REAL,
      mid REAL,
      marked_at TEXT NOT NULL,
      PRIMARY KEY (agent_id, market_id, option_id)
    );

    -- Cache of resolved CLOB token ids per market/outcome index
    CREATE TABLE IF NOT EXISTS token_resolution_map (
      market_id TEXT NOT NULL,
      outcome_index INTEGER NOT NULL,
      clob_token_id TEXT NOT NULL,
      source TEXT,
      resolved_at TEXT NOT NULL,
      PRIMARY KEY (market_id, outcome_index)
    );

    -- Per-agent mark-to-market portfolio history snapshots
    -- Stores equity and PnL components at snapshot time. ts is epoch millis.
    CREATE TABLE IF NOT EXISTS portfolio_history (
      agent_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      equity REAL NOT NULL,
      realized_pnl REAL NOT NULL,
      unrealized_pnl REAL NOT NULL,
      PRIMARY KEY (agent_id, ts)
    );

    -- Persistent closed position rounds per agent/market/option
    -- Stores aggregated closed rounds reconstructed from live trades. One row per
    -- completed round, keyed by (agent, market, option, closed_at).
    CREATE TABLE IF NOT EXISTS closed_positions (
      agent_id TEXT NOT NULL,
      market_id TEXT NOT NULL,
      option_id TEXT NOT NULL,
      quantity REAL NOT NULL,
      average_price REAL NOT NULL,
      exit_price REAL NOT NULL,
      realized_pnl REAL NOT NULL,
      fees_paid REAL NOT NULL,
      closed_at TEXT NOT NULL,
      PRIMARY KEY (agent_id, market_id, option_id, closed_at)
    );

  `);

  // Migrations: ensure debug columns exist
  const ensureColumn = (table: string, column: string, type: string) => {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>;
    if (!rows.some((r) => r.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  };

  // evaluation_rationale stores evaluation-phase rationale
  ensureColumn("market_evaluations", "evaluation_rationale", "TEXT");
  ensureColumn("market_evaluations", "status", "TEXT");
  ensureColumn("market_evaluations", "debug_market_payload_json", "TEXT");
  ensureColumn("market_evaluations", "debug_ai_input_json", "TEXT");
  ensureColumn("market_evaluations", "debug_ai_output_json", "TEXT");
  ensureColumn("market_evaluations", "evaluation_citations", "TEXT"); // JSON array of URLs
  // trade_rationale attaches to accepted deep decisions (why buy/sell)
  ensureColumn("plan_decisions", "trade_rationale", "TEXT");
  ensureColumn("plan_decisions", "debug_json", "TEXT");
  ensureColumn("plan_decisions", "decision_citations", "TEXT");
  ensureColumn("fills", "fee_amount", "REAL");
  ensureColumn("fills", "fee_bps", "REAL");
  ensureColumn("fills", "fee_meta", "TEXT");
  ensureColumn("trade_instructions", "live_order_id", "TEXT");
  ensureColumn("trade_instructions", "live_status", "TEXT");
  ensureColumn("trade_instructions", "live_error", "TEXT");
  ensureColumn("trade_instructions", "live_last_update", "TEXT");
  ensureColumn("trade_instructions", "executed_at", "TEXT");
  ensureColumn("trade_instructions", "taker_order_id", "TEXT");

  // Data hygiene: clamp any persisted TP/SL outside [0,1]
  try {
    db.exec(`
      UPDATE trade_instructions
      SET take_profit_price = CASE
        WHEN take_profit_price IS NULL THEN take_profit_price
        WHEN take_profit_price > 1.0 THEN 1.0
        WHEN take_profit_price < 0.0 THEN 0.0
        ELSE take_profit_price
      END;
      UPDATE trade_instructions
      SET stop_price = CASE
        WHEN stop_price IS NULL THEN stop_price
        WHEN stop_price > 1.0 THEN 1.0
        WHEN stop_price < 0.0 THEN 0.0
        ELSE stop_price
      END;
    `);
  } catch {}
}

export function closeDatabase(db: SqliteDatabase): void {
  db.close();
}
