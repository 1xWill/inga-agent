import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AgentRepositoryAsync } from './types';
import { asAsyncRepository } from './sqlite';
import { openDatabase, initializeSchema } from '../agent/db';
import { AgentRepository as SyncAgentRepository } from '../agent/repository';
import { getPgPool } from './pgPool';
import { createPgRepository } from './pg';

let pgRepoSingleton: AgentRepositoryAsync | null = null;

export async function getRepository(): Promise<AgentRepositoryAsync> {
  const driver = (process.env.DB_DRIVER || 'sqlite').toLowerCase();
  if (driver === 'postgres' || driver === 'pg') {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is required for DB_DRIVER=postgres');
    if (!pgRepoSingleton) {
      const pool = await getPgPool(url);
      pgRepoSingleton = createPgRepository(pool);
    }
    return pgRepoSingleton;
  }

  // Default: SQLite (local/tests). Reuse existing sync repo and wrap as async.
  const root = process.cwd();
  const envFile = process.env.PAPER_DB_FILE;
  const defaultFile = resolve(root, 'data/inga.sqlite');
  const filePath = envFile ? resolve(root, envFile) : existsSync(defaultFile) ? defaultFile : undefined;
  const db = openDatabase(filePath ? { filePath } : {});
  initializeSchema(db);
  const syncRepo = new SyncAgentRepository(db);
  return asAsyncRepository(syncRepo);
}
