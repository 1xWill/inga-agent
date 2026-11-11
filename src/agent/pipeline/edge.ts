import type { RuntimeConfig } from "../../config/schema";

/**
 * Determine the executor-level minimum edge (in bps). When the operator does
 * not provide `minEdgeBpsNet`, derive one from the quick-phase requirement
 * plus a buffer that approximates half of the allowed spread and the taker fee.
 */
export function getMinEdgeBpsNet(runtime: RuntimeConfig): number | undefined {
  const configured = (runtime.tradeEvaluation as any)?.minEdgeBpsNet;
  if (typeof configured === "number" && Number.isFinite(configured)) {
    return configured;
  }
  const promptEdge = (runtime.tradeEvaluation as any)?.minEdgeBps;
  const gatingSpread = Number(
    runtime.tradeEvaluation?.gating?.maxSpreadPct ?? 0,
  );
  const boundedSpread = Math.min(1, Math.max(0, gatingSpread));
  const defaultHalfSpreadBps = Math.round(boundedSpread * 5000);
  const takerBps = Math.max(
    0,
    Number((runtime as any)?.fees?.trading?.takerBps ?? 0),
  );
  const baseEdge = typeof promptEdge === "number" ? promptEdge : 0;
  const derived = Math.max(0, baseEdge + defaultHalfSpreadBps + takerBps);
  return derived > 0 ? derived : undefined;
}
