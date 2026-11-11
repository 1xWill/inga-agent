#!/usr/bin/env node
import { config as loadEnv } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { runAgentOnce, runAgentWithDualLoops, runMonitorOnce } from './runner';
import { createHttpClient } from '../http/client';
import { createPolymarketClient } from '../clients/polymarket';
import { loadAgentsConfig, loadRuntimeConfig } from '../config';
import { ensureOrdersRefresher } from '../../app/api/_lib/ordersRefresher';
import { ensureLiveSnapshotRefresher } from '../../app/api/_lib/liveSnapshotRefresher';
import { ensureMarksRefresher } from '../../app/api/_lib/marksRefresher';
// Start periodic portfolio-history recorder alongside the worker loops so
// chart dots continue updating even when the web (serverless) is idle.
import { ensurePortfolioHistoryRefresher, refreshPortfolioHistoryNow } from '../../app/api/_lib/portfolioHistoryRefresher';

function parseArgs(argv: string[]) {
  const args = { loop: false, monitorOnce: false, all: false, agentId: undefined as string | undefined, dbFilePath: undefined as string | undefined };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--loop' || a === '-l') args.loop = true;
    else if (a === '--monitor') args.monitorOnce = true;
    else if (a === '--all') args.all = true;
    else if ((a === '--agent' || a === '-a') && argv[i + 1]) { args.agentId = argv[++i]; }
    else if ((a === '--db' || a === '-d') && argv[i + 1]) { args.dbFilePath = argv[++i]; }
    else if (!args.agentId && !a.startsWith('-')) { args.agentId = a; }
  }
  if (!args.dbFilePath) {
    args.dbFilePath = process.env.PAPER_DB_FILE || 'data/inga.sqlite';
  }
  return args;
}

export async function main() {
  // Load env like tests do: .env.local then .env
  const root = process.cwd();
  const envLocal = resolve(root, '.env.local');
  const envDefault = resolve(root, '.env');
  if (existsSync(envLocal)) loadEnv({ path: envLocal });
  if (existsSync(envDefault)) loadEnv({ path: envDefault, override: false });

  const { loop, monitorOnce, all, agentId, dbFilePath } = parseArgs(process.argv);
  if (loop) {
    // Continuous runner
    if (all) {
      const cfg = await loadAgentsConfig(process.cwd());
      const runtime = await loadRuntimeConfig(process.cwd());
      const enabledAgents = cfg.agents.filter((a) => a.enabled);
      const sessionId = `sess_${Date.now()}`;
      // Start orders refresher timers (worker-owned). Cancels are gated by env WORKER_ENABLE_AUTOCANCEL.
      try {
        for (const a of enabledAgents) {
          // Live-order status/TTL cancels (cancels gated via WORKER_ENABLE_AUTOCANCEL)
          ensureOrdersRefresher(a as any, runtime as any);
          // Portfolio history snapshots; honors runtime.portfolioHistory.{enabled,intervalMinutes}
          ensurePortfolioHistoryRefresher(a.id, runtime as any);
          // Live portfolio snapshots for serverless web; cadence matches marksRefresher.intervalMinutes
          ensureLiveSnapshotRefresher(a.id, runtime as any);
          // Orderbook marks + numeric exit triggers
          ensureMarksRefresher(a.id, runtime as any);
        }
      } catch {}
      // Shared discovery scheduler (one per process)
      let active = true;
      let busyDiscovery = false;
      const httpShared = createHttpClient(runtime.http as any);
      const clobOv = (runtime.http as any)?.hostOverrides?.['clob.polymarket.com'];
      const polyShared = createPolymarketClient({ httpClient: httpShared, marketConfig: runtime.marketData, memoize: (runtime.http as any)?.memoize, concurrency: { maxConcurrent: clobOv?.maxConcurrent }, logger: (runtime as any)?.logging?.verbose?.providers?.polymarket ? console.log : undefined });
      const scheduleSharedDiscovery = async () => {
        if (!active) return;
        // Use positionMonitorIntervalMinutes as the primary tick for the full
        // cycle: numeric monitor → LLM monitor → quick/deep discovery.
        const intervalMinutes = Math.max(1 / 60, runtime.polling.positionMonitorIntervalMinutes);
        const intervalMs = intervalMinutes * 60 * 1000;
        setTimeout(async () => {
          if (!active) return;
          if (busyDiscovery) return scheduleSharedDiscovery();
          busyDiscovery = true;
          try {
            // Build shared discovery via first call; others reuse cache
            await Promise.all(
              enabledAgents.map((a, idx) =>
                new Promise<void>((resolve) => {
                  const jitter = Math.floor(50 + Math.random() * 200);
                  setTimeout(() => {
                    runAgentOnce({
                      agentId: a.id,
                      baseDir: process.cwd(),
                      log: console.log,
                      dbFilePath,
                      sessionId,
                      inject: { http: httpShared, polymarket: polyShared },
                    })
                      .then(() => resolve())
                      .catch(() => resolve());
                  }, jitter + idx * 20);
                }),
              ),
            );
          } catch (e) {
            // eslint-disable-next-line no-console
            console.error("[cli] Shared discovery tick error", {
              error: (e as Error).message,
            });
          } finally {
            busyDiscovery = false;
            scheduleSharedDiscovery();
          }
        }, intervalMs);
      };
      // Fire immediate discovery+monitor cycle then schedule
      (async () => {
        busyDiscovery = true;
        try {
          await Promise.all(
            enabledAgents.map((a, idx) =>
              new Promise<void>((resolve) => {
                const jitter = Math.floor(50 + Math.random() * 200);
                setTimeout(() => {
                  runAgentOnce({ agentId: a.id, baseDir: process.cwd(), log: console.log, dbFilePath, sessionId, inject: { http: httpShared, polymarket: polyShared } })
                    .then(() => resolve())
                    .catch(() => resolve());
                }, jitter + idx * 20);
              })
            )
          );
        } catch (e) {
          console.error('[cli] Shared discovery immediate tick error', { error: (e as Error).message });
        } finally {
          busyDiscovery = false;
          scheduleSharedDiscovery();
        }
      })();
      const shutdown = () => { active = false; process.exit(0); };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      console.log(`[cli] started shared discovery + per-agent monitor for: ${enabledAgents.map(a=>a.id).join(', ')}`);
      await new Promise(() => {});
    } else {
      // Single-agent loop: also ensure portfolio history snapshots for this agent
      try {
        const runtime = await loadRuntimeConfig(process.cwd());
        if (agentId) {
          ensurePortfolioHistoryRefresher(agentId, runtime as any);
          ensureLiveSnapshotRefresher(agentId, runtime as any);
          ensureMarksRefresher(agentId, runtime as any);
        }
      } catch {}
      runAgentWithDualLoops({ agentId, baseDir: process.cwd(), log: console.log, dbFilePath });
    }
  } else {
    if (monitorOnce) {
      await runMonitorOnce({ agentId, dbFilePath, log: console.log });
    } else {
      await runAgentOnce({ agentId, dbFilePath, log: console.log });
      // After a one-off run, opportunistically persist a fresh portfolio snapshot
      // so charts update even without the worker. Honors portfolioHistory.enabled.
      try {
        const runtime = await loadRuntimeConfig(process.cwd());
        if (runtime?.portfolioHistory?.enabled) {
          const cfg = await loadAgentsConfig(process.cwd());
          const ag = cfg.agents.find((a) => a.enabled && (!agentId || a.id === agentId));
          if (ag) await refreshPortfolioHistoryNow(ag.id, runtime as any);
        }
      } catch {}
    }
  }
}

// ESM-safe entrypoint
if (typeof import.meta !== 'undefined' && (import.meta as any).url === `file://${process.argv[1]}`) {
  void main();
}
