import type { Pool } from 'pg';

type LiveSnapshot = {
  agentId: string;
  updatedAt: string; // ISO
  cashBalance: number;
  realizedPnl: number;
  unrealizedPnl: number;
  equity: number;
  positionsOpen: any[];
  positionsClosed: any[];
};

async function getPool(): Promise<Pool | undefined> {
  const driver = (process.env.DB_DRIVER || '').toLowerCase();
  const url = process.env.DATABASE_URL;
  if (!url || (driver !== 'postgres' && driver !== 'pg')) return undefined;
  const mod = await import('pg');
  return new mod.Pool({ connectionString: url, max: Number(process.env.PGPOOL_MAX || 3) });
}

async function ensureTable(pool: Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS live_portfolio_snapshots (
      agent_id TEXT PRIMARY KEY,
      updated_at TIMESTAMPTZ NOT NULL,
      cash_balance REAL NOT NULL,
      realized_pnl REAL NOT NULL,
      unrealized_pnl REAL NOT NULL,
      equity REAL NOT NULL,
      positions_open JSONB NOT NULL,
      positions_closed JSONB NOT NULL
    )
  `);
}

export async function upsertLiveSnapshot(s: LiveSnapshot): Promise<boolean> {
  const pool = await getPool();
  if (!pool) return false;
  await ensureTable(pool);
  await pool.query(
    `INSERT INTO live_portfolio_snapshots (agent_id, updated_at, cash_balance, realized_pnl, unrealized_pnl, equity, positions_open, positions_closed)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (agent_id)
     DO UPDATE SET updated_at = EXCLUDED.updated_at,
                   cash_balance = EXCLUDED.cash_balance,
                   realized_pnl = EXCLUDED.realized_pnl,
                   unrealized_pnl = EXCLUDED.unrealized_pnl,
                   equity = EXCLUDED.equity,
                   positions_open = EXCLUDED.positions_open,
                   positions_closed = EXCLUDED.positions_closed`,
    [
      s.agentId,
      s.updatedAt,
      s.cashBalance,
      s.realizedPnl,
      s.unrealizedPnl,
      s.equity,
      JSON.stringify(s.positionsOpen ?? []),
      JSON.stringify(s.positionsClosed ?? []),
    ]
  );
  return true;
}

export async function getLiveSnapshot(agentId: string): Promise<LiveSnapshot | undefined> {
  const pool = await getPool();
  if (!pool) return undefined;
  await ensureTable(pool);
  const r = await pool.query(
    `SELECT agent_id, updated_at, cash_balance, realized_pnl, unrealized_pnl, equity, positions_open, positions_closed
     FROM live_portfolio_snapshots WHERE agent_id = $1`,
    [agentId]
  );
  const row = r.rows?.[0];
  if (!row) return undefined;
  return {
    agentId: String(row.agent_id),
    updatedAt: new Date(row.updated_at).toISOString(),
    cashBalance: Number(row.cash_balance),
    realizedPnl: Number(row.realized_pnl),
    unrealizedPnl: Number(row.unrealized_pnl),
    equity: Number(row.equity),
    positionsOpen: Array.isArray(row.positions_open) ? row.positions_open : (row.positions_open ? JSON.parse(row.positions_open) : []),
    positionsClosed: Array.isArray(row.positions_closed) ? row.positions_closed : (row.positions_closed ? JSON.parse(row.positions_closed) : []),
  };
}

