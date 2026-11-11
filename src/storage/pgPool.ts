import type { Pool } from 'pg';

declare global {
  // eslint-disable-next-line no-var
  var __pgPool: Pool | undefined;
}

/**
 * Returns a process-wide singleton pg Pool with conservative defaults.
 * Keeps pool tiny and connections short-lived to avoid exhausting Postgres.
 */
export async function getPgPool(connectionString: string): Promise<Pool> {
  if (global.__pgPool) return global.__pgPool;
  const { Pool } = await import('pg');

  const pool = new Pool({
    connectionString,
    max: Number(process.env.PGPOOL_MAX ?? 5),
    idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS ?? 30_000),
    connectionTimeoutMillis: Number(process.env.PG_CONNECTION_TIMEOUT_MS ?? 5_000),
    keepAlive: true,
    // Helps identify sources in pg_stat_activity
    application_name: process.env.PG_APP_NAME || 'inga',
  } as any);

  pool.on('error', (err: unknown) => {
    // eslint-disable-next-line no-console
    console.error('[pg] unexpected error on idle client', err);
  });

  global.__pgPool = pool;
  return pool;
}

