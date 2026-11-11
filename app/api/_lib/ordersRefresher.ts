import type { RuntimeConfig, AgentDefinition } from '../../../src/config/schema';
import { getRepository } from '../_lib/db';
import { createClobClientForAgent } from '../../../src/clients/polymarket_live';
import { getCachedLiveTrades, findLatestExecutionTime } from '../../../src/server/liveTradesCache';
import { resolveFallbackTokenId } from '../../../src/server/liveExecution';

type Timer = ReturnType<typeof setInterval>;

const timers = new Map<string, Timer>();
const orderErrorBackoff = new Map<string, number>();
const ORDER_BACKOFF_MS = 60_000;

function statusFromOpenOrder(raw: any): string | undefined {
  const s = String(raw?.status ?? '').toLowerCase();
  if (!s) return undefined;
  if (s.includes('open') || s.includes('partial')) return 'open';
  if (s.includes('cancel')) return 'canceled';
  if (s.includes('fail')) return 'failed';
  if (s.includes('fill')) return 'filled';
  return s;
}

export function ensureOrdersRefresher(agent: AgentDefinition, runtime: RuntimeConfig) {
  const key = agent.id;
  if (timers.has(key)) return;
  const intervalMinutes =
    Math.max(
      1 / 60,
      (runtime?.execution as any)?.live?.ordersRefresher?.intervalMinutes ??
        runtime.marksRefresher?.intervalMinutes ??
        10 / 60,
    );
  const periodMs = Math.max(1000, intervalMinutes * 60 * 1000);
  const timer = setInterval(async () => {
    const repo = await getRepository();
    try {
      // Only operate for agents with configured live creds
      const live = createClobClientForAgent(agent);
      if (!live) return;
      const client = live.client;
      const rows = await repo.listLiveOrdersNeedingUpdate(agent.id);
      if (rows.length === 0) return;
      // TTL auto-cancel (gated to worker via env)
      const allowCancels = (() => {
        const v = String(process.env.WORKER_ENABLE_AUTOCANCEL || '').toLowerCase();
        return v === '1' || v === 'true' || v === 'yes' || v === 'worker';
      })();
      const auto = (runtime?.execution as any)?.live?.autoCancel ?? { enabled: false, ttlMinutes: 0 };
      const now = Date.now();
      for (const r of rows) {
        // 1) DB-first minimal persistence check: if we already persisted execution info,
        // treat as filled and avoid false cancels.
        try {
          const exec = await repo.getTradeInstructionExecutionStateById(r.id);
          if (exec && (exec.executedAt || exec.takerOrderId)) {
            if (r.liveStatus !== 'filled') await repo.setTradeInstructionLiveInfo(r.id, { status: 'filled' });
            continue;
          }
        } catch {}
        // TTL cancel (best-effort)
        if (allowCancels && auto?.enabled === true && auto?.ttlMinutes && auto.ttlMinutes > 0) {
          const ageMs = now - new Date(r.createdAt).getTime();
          if (ageMs > auto.ttlMinutes * 60 * 1000) {
            try { await client.cancelOrder({ orderID: r.orderId }); await repo.setTradeInstructionLiveInfo(r.id, { status: 'canceled' }); continue; } catch (e: any) { await repo.setTradeInstructionLiveInfo(r.id, { error: String(e?.message || e) }); }
          }
        }
        // Poll order status
        try {
          const lastErrAt = orderErrorBackoff.get(r.orderId);
          if (lastErrAt && now - lastErrAt < ORDER_BACKOFF_MS) {
            continue;
          }
          const ord = await client.getOrder(r.orderId);
          // Successful read: clear any previous 5xx backoff for this order
          if (orderErrorBackoff.has(r.orderId)) {
            orderErrorBackoff.delete(r.orderId);
          }
          const st = statusFromOpenOrder(ord);
          // Special case: "matched" can persist; if we can find a taker fill, treat as filled.
          if (st === 'matched') {
            try {
              const instr = await repo.getTradeInstructionByLiveOrderId(r.orderId);
              const tokenIdForFallback = instr
                ? await resolveFallbackTokenId(repo as any, instr.marketId, instr.optionId)
                : undefined;
              const executedAt = await findLatestExecutionTime(agent, r.orderId, {
                ttlMs: 0,
                fallbackByToken: instr && tokenIdForFallback
                  ? { tokenId: tokenIdForFallback, side: instr.direction as any, after: instr.createdAt }
                  : undefined,
              });
              if (executedAt) {
                await repo.setTradeInstructionExecutionInfo(r.id, { executedAt, takerOrderId: r.orderId });
                await repo.setTradeInstructionLiveInfo(r.id, { status: 'filled' });
                continue;
              }
            } catch {}
          }
          if (st && st !== r.liveStatus) {
            await repo.setTradeInstructionLiveInfo(r.id, { status: st });
            // If now filled (or matched), try to persist executedAt using cached live trades
            if (st === 'filled' || st === 'matched') {
              try {
                const instr = await repo.getTradeInstructionByLiveOrderId(r.orderId);
                const tokenIdForFallback = instr
                  ? await resolveFallbackTokenId(repo as any, instr.marketId, instr.optionId)
                  : undefined;
                const executedAt = await findLatestExecutionTime(agent, r.orderId, {
                  // Force refresh: avoid mislabeling when cache is stale
                  ttlMs: 0,
                  fallbackByToken: instr && tokenIdForFallback
                    ? { tokenId: tokenIdForFallback, side: instr.direction as any, after: instr.createdAt }
                    : undefined,
                });
                if (executedAt) {
                  await repo.setTradeInstructionExecutionInfo(r.id, { executedAt, takerOrderId: r.orderId });
                  // Treat matched-with-trade as filled for terminal bookkeeping
                  if (st === 'matched') await repo.setTradeInstructionLiveInfo(r.id, { status: 'filled' });
                }
              } catch {}
            }
          }
        } catch (e: any) {
          const err: any = e;
          const msg = String(err?.message || err || 'error');
          const status = typeof err?.response?.status === 'number'
            ? err.response.status
            : typeof err?.status === 'number'
              ? err.status
              : undefined;
          const is5xx =
            typeof status === 'number'
              ? status >= 500 && status < 600
              : /5\d\d|internal server error|bad gateway/i.test(msg);
          if (is5xx) {
            // Cloudflare / CLOB transient 5xx: avoid storing large HTML blobs or
            // polluting live_error; back off briefly and retry on future ticks.
            orderErrorBackoff.set(r.orderId, now);
            continue;
          }
          // If the order is no longer retrievable (404/not found/gone), treat as terminal.
          // Cross-check fills: if any fill references this taker_order_id, mark as 'filled';
          // otherwise mark as 'canceled' (avoid mislabeling true failures as fills).
          if (/404|not\s*found|gone/i.test(msg)) {
            // Prefer live trades cache over DB fills (live agents may not persist fills)
            let executedAt: string | undefined;
            try {
              const instr = await repo.getTradeInstructionByLiveOrderId(r.orderId);
              const tokenIdForFallback = instr
                ? await resolveFallbackTokenId(repo as any, instr.marketId, instr.optionId)
                : undefined;
              executedAt = await findLatestExecutionTime(agent, r.orderId, {
                // Force refresh on 404 to disambiguate filled vs canceled
                ttlMs: 0,
                fallbackByToken: instr && tokenIdForFallback
                  ? { tokenId: tokenIdForFallback, side: instr.direction as any, after: instr.createdAt }
                  : undefined,
              });
            } catch {}
            if (executedAt) {
              await repo.setTradeInstructionLiveInfo(r.id, { status: 'filled', error: undefined });
              try { await repo.setTradeInstructionExecutionInfo(r.id, { executedAt, takerOrderId: r.orderId }); } catch {}
            } else {
              // No evidence of fill. Apply grace; only then mark canceled.
              const ageMs = now - new Date(r.createdAt).getTime();
              if (ageMs >= 60000) {
                const hasFill = await repo.hasFillWithTakerOrderId(r.orderId);
                await repo.setTradeInstructionLiveInfo(r.id, { status: hasFill ? 'filled' : 'canceled', error: undefined });
              }
            }
          } else {
            await repo.setTradeInstructionLiveInfo(r.id, { error: msg });
          }
        }
      }
    } catch { /* ignore tick errors */ }
  }, periodMs);
  timers.set(key, timer);
}
