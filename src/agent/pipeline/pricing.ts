import type { RuntimeConfig } from "../../config/schema";

/**
 * Shared helper for SELL exit pricing.
 *
 * Given current orderbook marks and a planned share quantity, derives a
 * conservative executable exit price for SELL orders:
 *   - Prefer best bid when available.
 *   - Fall back to midpoint when best bid is unavailable but a mid exists.
 *   - Finally fall back to the position's average entry price.
 * The resulting price is clamped to the configured priceFloor/priceCeiling.
 */
export function computeExitPriceForSell(params: {
  bestBid?: number;
  mid?: number;
  averagePrice: number;
  quantity: number;
  exitsConfig?: RuntimeConfig["exits"];
}): { exitPrice: number; notional: number } | undefined {
  const { bestBid, mid, averagePrice, quantity, exitsConfig } = params;

  const floor =
    typeof exitsConfig?.priceFloor === "number" ? exitsConfig.priceFloor : 0.0;
  const ceiling =
    typeof exitsConfig?.priceCeiling === "number"
      ? exitsConfig.priceCeiling
      : 1.0;

  let exitPrice: number | undefined;

  if (typeof bestBid === "number" && bestBid > 0) {
    exitPrice = bestBid;
  } else if (typeof mid === "number" && mid > 0) {
    exitPrice = mid;
  } else if (averagePrice > 0) {
    exitPrice = averagePrice;
  }

  if (!(exitPrice && exitPrice > 0)) return undefined;

  // Clamp to configured bounds
  exitPrice = Math.max(floor, Math.min(ceiling, exitPrice));

  if (!(quantity > 0)) return undefined;
  const notional = exitPrice * quantity;
  if (!(notional > 0)) return undefined;

  return { exitPrice, notional };
}

