#!/usr/bin/env tsx
/**
 * Print which SQLite DB file the app would use and basic table counts.
 *
 * Usage:
 *   npm run db:info            # prints path + counts
 *   npm run db:info -- --file data/inga.sqlite
 */
import "dotenv/config";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";

function argVal(name: string, def?: string): string | undefined {
  const k = `--${name}`;
  const i = process.argv.indexOf(k);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return def;
}

const root = process.cwd();
const envFile = process.env.PAPER_DB_FILE;
const defaultFile = resolve(root, "data/inga.sqlite");
const fileArg = argVal("file");
const filePath = fileArg
  ? resolve(root, fileArg)
  : envFile
    ? resolve(root, envFile)
    : existsSync(defaultFile)
      ? defaultFile
      : defaultFile;
const exists = existsSync(filePath);
const size = exists ? statSync(filePath).size : 0;

console.log(
  JSON.stringify({
    root,
    envFile,
    defaultFile,
    selected: filePath,
    exists,
    size,
  }),
);

if (!exists) process.exit(0);

const db = new Database(filePath);
const get = (sql: string): number => {
  try {
    const row = db.prepare(sql).get() as any;
    return Number(row?.c ?? 0);
  } catch {
    return 0;
  }
};

const out = {
  runs: get("select count(*) as c from agent_runs"),
  evals: get("select count(*) as c from market_evaluations"),
  decisions: get("select count(*) as c from plan_decisions"),
  trades: get("select count(*) as c from trade_instructions"),
  fills: get("select count(*) as c from fills"),
  positions: get("select count(*) as c from positions"),
};
console.log(JSON.stringify(out));
