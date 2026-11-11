import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

function parseArgs() {
  const args = process.argv.slice(2);
  const result: { dbPath?: string; agentId?: string } = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--db" || arg === "--database") {
      result.dbPath = args[i + 1];
      i += 1;
    } else if (arg === "--agent") {
      result.agentId = args[i + 1];
      i += 1;
    }
  }
  return result;
}

function stats(values: number[]) {
  if (values.length === 0) {
    return { count: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const mean = sum / sorted.length;
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  const pct = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  return {
    count: sorted.length,
    min,
    median,
    max,
    mean,
    p10: pct(10),
    p25: pct(25),
    p75: pct(75),
    p90: pct(90),
  };
}

function cleanReason(reason: string) {
  const trimmed = reason.trim();
  const withoutMeta = trimmed
    .replace(/^meta\[[^\]]+\];\s*/, "")
    .replace(/^Gates passed;\s*/, "");
  return withoutMeta.length > 0 ? withoutMeta : trimmed;
}

function main() {
  const args = parseArgs();
  const dbPath = resolve(args.dbPath ?? "data/inga.sqlite");
  if (!existsSync(dbPath)) {
    throw new Error(`SQLite file not found at ${dbPath}`);
  }

  const db = new Database(dbPath, { readonly: true });

  const evalStmt = db.prepare(`
    SELECT id, market_id, title, created_at, trade_flag, rationale, risk_notes, debug_market_payload_json
    FROM market_evaluations
    ${args.agentId ? "WHERE agent_id = @agentId" : ""}
    ORDER BY datetime(created_at) DESC
  `);
  const evalRows = evalStmt.all(
    args.agentId ? { agentId: args.agentId } : undefined,
  ) as Array<{
    id: number;
    market_id: string;
    title: string;
    created_at: string;
    trade_flag: number;
    rationale: string;
    risk_notes?: string | null;
    debug_market_payload_json?: string | null;
  }>;

  const ttlMinutes: number[] = [];
  for (const row of evalRows) {
    if (!row.debug_market_payload_json) continue;
    try {
      const payload = JSON.parse(row.debug_market_payload_json) as Array<{
        ttlMinutes?: number | null;
      }>;
      for (const entry of payload) {
        if (
          typeof entry?.ttlMinutes === "number" &&
          Number.isFinite(entry.ttlMinutes) &&
          entry.ttlMinutes >= 0
        ) {
          ttlMinutes.push(entry.ttlMinutes);
        }
      }
    } catch (e) {
      console.warn(
        `Failed to parse debug payload for evaluation ${row.id}: ${(e as Error).message}`,
      );
    }
  }

  const ttlHours = ttlMinutes.map((m) => Number((m / 60).toFixed(2)));
  const ttlStats = stats(ttlHours);
  const ttlBelow96 = ttlHours.filter((h) => h <= 96).length;
  const ttlBelow48 = ttlHours.filter((h) => h <= 48).length;

  const planStmt = db.prepare(`
    SELECT status, reason, created_at
    FROM plan_decisions
    ${args.agentId ? "WHERE agent_id = @agentId" : ""}
    ORDER BY datetime(created_at) DESC
  `);
  const planRows = planStmt.all(
    args.agentId ? { agentId: args.agentId } : undefined,
  ) as Array<{
    status: "accepted" | "rejected";
    reason?: string | null;
    created_at: string;
  }>;

  const edgeAccepted: number[] = [];
  const edgeRejected: number[] = [];
  const basisCounts = new Map<string, number>();
  const rejectionReasons = new Map<string, number>();

  for (const row of planRows) {
    const reason = row.reason ?? "";
    const edgeMatch = reason.match(/edgeBps=([-\d.]+)/i);
    if (edgeMatch) {
      const edge = Number(edgeMatch[1]);
      if (Number.isFinite(edge)) {
        if (row.status === "accepted") edgeAccepted.push(edge);
        else edgeRejected.push(edge);
      }
    }
    const basisMatch = reason.match(/basis=([a-z]+)/i);
    if (basisMatch) {
      const key = basisMatch[1].toLowerCase();
      basisCounts.set(key, (basisCounts.get(key) ?? 0) + 1);
    }
    if (row.status === "rejected") {
      const cleaned = cleanReason(reason || "unknown");
      const key = cleaned.split(" | ")[0];
      rejectionReasons.set(key, (rejectionReasons.get(key) ?? 0) + 1);
    }
  }

  const edgeAcceptedStats = stats(edgeAccepted);
  const edgeRejectedStats = stats(edgeRejected);

  const topRejections = Array.from(rejectionReasons.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([reason, count]) => ({ reason, count }));

  console.log("Evaluation TTL (hours) stats:", ttlStats);
  console.log("TTL <= 96h count:", ttlBelow96, "of", ttlHours.length);
  console.log("TTL <= 48h count:", ttlBelow48, "of", ttlHours.length);
  console.log("Accepted edge bps stats:", edgeAcceptedStats);
  console.log("Rejected edge bps stats:", edgeRejectedStats);
  console.log("Basis distribution:", Object.fromEntries(basisCounts));
  console.log("Top rejection reasons:", topRejections);
}

main();
