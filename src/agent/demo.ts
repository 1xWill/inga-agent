#!/usr/bin/env node
import { config as loadEnv } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { runAgentWithDualLoops } from './runner';

function parseArgs(argv: string[]) {
  const args = { seconds: 180, agentId: undefined as string | undefined, dbFilePath: undefined as string | undefined };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if ((a === '--seconds' || a === '-s') && argv[i + 1]) { args.seconds = Math.max(1, Number(argv[++i])); }
    else if ((a === '--agent' || a === '-a') && argv[i + 1]) { args.agentId = argv[++i]; }
    else if ((a === '--db' || a === '-d') && argv[i + 1]) { args.dbFilePath = argv[++i]; }
  }
  if (!args.dbFilePath) {
    args.dbFilePath = process.env.PAPER_DB_FILE || 'data/inga.sqlite';
  }
  return args;
}

async function main() {
  const root = process.cwd();
  const envLocal = resolve(root, '.env.local');
  const envDefault = resolve(root, '.env');
  if (existsSync(envLocal)) loadEnv({ path: envLocal });
  if (existsSync(envDefault)) loadEnv({ path: envDefault, override: false });

  const { seconds, agentId, dbFilePath } = parseArgs(process.argv);
  const stop = runAgentWithDualLoops({ agentId, baseDir: process.cwd(), log: console.log, dbFilePath });
  console.log(`[demo] Triple loops running for ${seconds}s...`);
  setTimeout(() => {
    console.log('[demo] Stopping triple loops.');
    stop();
    // Give pending timers a moment to settle then exit
    setTimeout(() => process.exit(0), 500);
  }, seconds * 1000);
}

void main();
