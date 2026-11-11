import type { RuntimeConfig } from "../../config/schema";

// Per-position exit targets are always derived from the latest BUY
// trade_instruction for that (agentId, marketId, optionId). This helper is the
// single source of truth used by monitor, exits, and server-side UI enrichment.

export interface EntryTargetsInput {
  expectedPrice?: number | null;
  takeProfitPrice?: number | null;
  stopPrice?: number | null;
}

export interface EntryTargetsOutput {
  tpOrig?: number;
  slOrig?: number;
  tpEff?: number;
  slEff?: number;
}

/**
 * Derive effective TP/SL absolute price levels for a position from the latest
 * entry instruction and runtime exits config. This is the single source of
 * truth used by monitor, exits, and server-side enrichment for UI.
 */
export function deriveEffectiveTargets(
  entry: EntryTargetsInput | undefined,
  runtime: RuntimeConfig | (RuntimeConfig & { exits?: RuntimeConfig["exits"] }) | any,
): EntryTargetsOutput {
  const exits = (runtime as any)?.exits ?? {};
  const floorB = typeof exits.priceFloor === "number" ? exits.priceFloor : 0.0;
  const ceilB = typeof exits.priceCeiling === "number" ? exits.priceCeiling : 1.0;

  const clamp = (v?: number | null) => {
    if (typeof v !== "number") return undefined;
    return Math.min(ceilB, Math.max(floorB, v));
  };

  // Quantize effective thresholds to a 0.001 grid so targets line up with
  // Polymarket UI pricing and avoid half-tick artifacts like 0.9995.
  const quantize = (v?: number | null) => {
    if (typeof v !== "number") return undefined;
    const q = Math.round(v * 1000) / 1000;
    return Math.min(ceilB, Math.max(floorB, q));
  };

  const tpStored =
    typeof entry?.takeProfitPrice === "number" ? (entry.takeProfitPrice as number) : undefined;
  const slStored =
    typeof entry?.stopPrice === "number" ? (entry.stopPrice as number) : undefined;
  const exp =
    typeof entry?.expectedPrice === "number" ? (entry.expectedPrice as number) : undefined;

  const tpStoredClamped = clamp(tpStored);
  const slStoredClamped = clamp(slStored);

  const tpCapPct =
    typeof exits.maxTakeProfitPct === "number"
      ? (exits.maxTakeProfitPct as number)
      : undefined;
  const slCapPct =
    typeof exits.maxStopLossPct === "number"
      ? (exits.maxStopLossPct as number)
      : undefined;
  const tpDefaultPct =
    typeof exits.takeProfitPct === "number"
      ? (exits.takeProfitPct as number)
      : undefined;
  const slDefaultPct =
    typeof exits.stopLossPct === "number"
      ? (exits.stopLossPct as number)
      : undefined;

  const tpPctOrig =
    typeof exp === "number" && typeof tpStoredClamped === "number" && exp > 0
      ? tpStoredClamped / exp - 1
      : undefined;
  const slPctOrig =
    typeof exp === "number" && typeof slStoredClamped === "number" && exp > 0
      ? 1 - slStoredClamped / exp
      : undefined;

  // Base percentages come from stored TP/SL when available; otherwise fall
  // back to config-level defaults. Caps are pure caps on these base values:
  // they can only tighten, never enlarge, the effective TP/SL vs the base.
  const tpBasePct =
    typeof tpPctOrig === "number" ? tpPctOrig : tpDefaultPct;
  const slBasePct =
    typeof slPctOrig === "number" ? slPctOrig : slDefaultPct;

  const applyCap = (
    basePct: number | undefined,
    capPct: number | undefined,
  ): number | undefined => {
    if (typeof basePct !== "number") return undefined;
    if (typeof capPct === "number") {
      return Math.min(basePct, capPct);
    }
    return basePct;
  };

  const tpPctEff = applyCap(tpBasePct, tpCapPct);
  const slPctEff = applyCap(slBasePct, slCapPct);

  const tpCapAbs =
    typeof exp === "number" && typeof tpPctEff === "number"
      ? clamp(exp * (1 + tpPctEff))
      : undefined;
  const slCapAbs =
    typeof exp === "number" && typeof slPctEff === "number"
      ? clamp(exp * (1 - slPctEff))
      : undefined;

  const tp = typeof tpCapAbs === "number" ? tpCapAbs : tpStoredClamped;
  const sl = typeof slCapAbs === "number" ? slCapAbs : slStoredClamped;

  return {
    tpOrig: tpStoredClamped,
    slOrig: slStoredClamped,
    tpEff: quantize(tp),
    slEff: quantize(sl),
  };
}
