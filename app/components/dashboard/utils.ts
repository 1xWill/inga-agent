export const fmtPrice = (v?: number): string =>
  typeof v === "number" ? v.toFixed(3) : "—";

export const fmtNotional = (v?: number): string =>
  typeof v === "number" ? v.toFixed(2) : "—";

export const fmtSignedUsd = (v?: number): string => {
  if (typeof v !== "number") return "—";
  if (Math.abs(v) < 0.0005) return "$0.00";
  const abs = Math.abs(v).toFixed(2);
  const sign = v > 0 ? "+" : "-";
  return `${sign}$${abs}`;
};

export const clsNumber = (v?: number): string =>
  typeof v === "number"
    ? v > 0
      ? "text-emerald-400"
      : v < 0
        ? "text-rose-400"
        : ""
    : "";

export const fmtPnl = (
  abs?: number,
  cost?: number,
): { abs: string; pct: string } => {
  if (typeof abs !== "number" || typeof cost !== "number" || cost === 0) {
    return { abs: "—", pct: "—" };
  }
  const pct = (abs / cost) * 100;
  const sign = abs > 0 ? "+" : "";
  return {
    abs: `${sign}${abs.toFixed(2)}`,
    pct: `${sign}${pct.toFixed(1)}%`,
  };
};

export const colorForLabel = (label?: string): string => {
  if (!label) return "";
  const upper = label.toUpperCase();
  if (upper.includes("BUY") || upper.includes("ACCEPTED"))
    return "text-emerald-400";
  if (upper.includes("SELL") || upper.includes("REJECTED"))
    return "text-rose-400";
  return "";
};
