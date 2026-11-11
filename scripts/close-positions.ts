#!/usr/bin/env tsx
/**
 * Manually close all open positions for all enabled agents or a specified agent.
 *
 * Behavior
 * - Paper mode: records SELL fills immediately (simulated) and updates positions/portfolio.
 * - Live mode: submits market SELL orders on the CLOB for the full position size.
 *   - Does NOT simulate local fills. The dashboard fills refresher will ingest real fills.
 *   - Respects runtime.execution.live.dryRun unless --submit is passed.
 *
 * Usage:
 *   npm run positions:close                 # close for all enabled agents using default DB
 *   npm run positions:close -- --agent agent_grok
 *   npm run positions:close -- --db data/inga.sqlite
 *   npm run positions:close -- --agent agent_grok --submit   # override live dryRun and submit orders
 */
import "dotenv/config";
import { resolve } from "node:path";
import Database from "better-sqlite3";

import { loadAgentsConfig, loadRuntimeConfig } from "../src/config/loaders";
import { AgentRepository } from "../src/agent/repository";
import { openDatabase, initializeSchema, closeDatabase } from "../src/agent/db";
import { PortfolioManager } from "../src/agent/portfolio";
import { createHttpClient } from "../src/http/client";
import { createPolymarketClient } from "../src/clients/polymarket";
import {
  createClobClientForAgent,
  submitMarketOrder,
} from "../src/clients/polymarket_live";
import { AssetType } from "@polymarket/clob-client";
import { getContractConfig } from "@polymarket/clob-client/dist/config.js";
import { ethers } from "ethers";
import { computeExitPriceForSell } from "../src/agent/pipeline/pricing";

function argVal(name: string, def?: string): string | undefined {
  const k = `--${name}`;
  const i = process.argv.indexOf(k);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return def;
}
function argFlag(name: string): boolean {
  const k = `--${name}`;
  return process.argv.includes(k);
}

async function main() {
  const root = process.cwd();
  const specificAgent = argVal("agent");
  const submitOverride = argFlag("submit");
  const dbArg = argVal("db") || argVal("file");
  const dbPath = dbArg
    ? resolve(root, dbArg)
    : process.env.PAPER_DB_FILE
      ? resolve(root, process.env.PAPER_DB_FILE)
      : resolve(root, "data/inga.sqlite");

  // Load config and clients
  const runtime = await loadRuntimeConfig(root);
  const agentsCfg = await loadAgentsConfig(root);
  const agents = specificAgent
    ? agentsCfg.agents.filter((a) => a.id === specificAgent)
    : agentsCfg.agents.filter((a) => a.enabled);
  if (agents.length === 0) {
    throw new Error(
      specificAgent
        ? `Agent not found: ${specificAgent}`
        : "No enabled agents found",
    );
  }
  const minQty = Math.max(0, (runtime.ui as any)?.minOpenQuantity ?? 0.01);

  const http = createHttpClient(runtime.http as any);
  const clobOv =
    (runtime.http as any)?.hostOverrides?.["clob.polymarket.com"] ?? {};
  const polymarket = createPolymarketClient({
    httpClient: http,
    marketConfig: runtime.marketData,
    memoize: {
      orderBookTtlMs: (runtime.http as any)?.memoize?.clobOrderBookTtlMs,
      feeRateTtlMs: (runtime.http as any)?.memoize?.clobFeeRateTtlMs,
    },
    concurrency: { maxConcurrent: clobOv?.maxConcurrent },
  });
  const chainId = Number(process.env.POLY_CHAIN_ID || 137);
  const provider = new ethers.providers.JsonRpcProvider(
    process.env.POLYGON_RPC_URL || "https://polygon-rpc.com",
    chainId,
  );
  const CTF =
    process.env.POLY_CONDITIONAL_TOKENS ||
    (getContractConfig(chainId as any).conditionalTokens as string);
  const ERC1155_ABI = [
    "function setApprovalForAll(address operator, bool approved) external",
    "function isApprovedForAll(address account, address operator) external view returns (bool)",
  ];
  // Spenders are derived dynamically from CLOB allowances per token; fallback to known exchange operators
  const SPENDERS_FALLBACK = [
    "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E",
    "0xC5d563A36AE78145C45a50134d48A1215220f80a",
    "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296",
  ];

  // Open DB
  const db = openDatabase(dbPath ? { filePath: dbPath } : {});
  initializeSchema(db);
  const repo = new AgentRepository(db);

  const results: any[] = [];

  for (const agent of agents) {
    const paperMode = agent.paperTrading !== false;
    const liveCfg = ((runtime as any)?.execution?.live ?? {}) as {
      dryRun?: boolean;
    };
    const live = !paperMode ? createClobClientForAgent(agent) : undefined;
    if (!paperMode && !live) {
      console.error(
        JSON.stringify({
          agentId: agent.id,
          error: "missing_live_credentials",
        }),
      );
      continue;
    }

    const portfolio = new PortfolioManager(repo, {
      agentId: agent.id,
      initialBalance: runtime.portfolio.initialBalance,
      baseCurrency: runtime.portfolio.baseCurrency,
    });
    let positions = repo.listOpenPositions(agent.id);

    // Live mode fallback: if DB has no open positions, infer current holdings from recent trades
    if (!paperMode && positions.length === 0 && live?.client) {
      try {
        const trades: any[] = await live.client.getTrades({}, true);
        type Pos = { qty: number; avg: number; marketId: string };
        const map = new Map<string, Pos>();
        // Sort ascending by time to replay accurately
        const sorted = [...trades].sort(
          (a, b) => Number(a?.match_time || 0) - Number(b?.match_time || 0),
        );
        for (const t of sorted) {
          const side = String(t?.side || "").toLowerCase();
          const price = Number(t?.price || 0);
          const size = Number(t?.size || 0);
          const tokenId = String(t?.asset_id || "");
          const marketId = String(t?.market || t?.asset_id || "");
          if (!tokenId || price <= 0 || size <= 0) continue;
          const prev = map.get(tokenId) || { qty: 0, avg: 0, marketId };
          if (side === "sell") {
            const sellQty = Math.min(prev.qty, size);
            const remaining = Math.max(0, prev.qty - sellQty);
            map.set(tokenId, { qty: remaining, avg: prev.avg, marketId });
          } else {
            const newQty = prev.qty + size;
            const newAvg =
              newQty > 0
                ? (prev.avg * prev.qty + price * size) / newQty
                : price;
            map.set(tokenId, { qty: newQty, avg: newAvg, marketId });
          }
        }
        positions = Array.from(map.entries())
          .filter(([_, v]) => v.qty > 0)
          .map(([tokenId, v]) => ({
            id: 0,
            agentId: agent.id,
            marketId: v.marketId,
            optionId: tokenId,
            direction: "buy" as const,
            quantity: v.qty,
            averagePrice: v.avg,
            status: "open" as const,
            openedAt: new Date(),
            updatedAt: new Date(),
          }));
      } catch {}
    }
    if (positions.length === 0) {
      console.log(
        JSON.stringify({
          agentId: agent.id,
          action: "noop",
          reason: "no_open_positions",
        }),
      );
      continue;
    }

    for (const pos of positions) {
      // Derive expected exit price from shared helper (best bid → fallbacks).
      let bestBid: number | undefined = undefined;
      try {
        const tokenOk =
          typeof pos.optionId === "string" && /^\d+$/.test(pos.optionId);
        if (tokenOk) {
          const ob = await polymarket.getOrderBook(pos.optionId);
          bestBid = ob?.bids?.[0]?.price;
        }
      } catch {}
      const priceInfo = computeExitPriceForSell({
        bestBid,
        mid: undefined,
        averagePrice: pos.averagePrice,
        quantity: 1,
        exitsConfig: runtime.exits,
      });
      const exitPrice = priceInfo?.exitPrice ?? 0;
      // Preflight: check on-chain CTF share balance and allowance via CLOB
      let shareBalance = pos.quantity;
      let hasAnyAllowance = true;
      let dynamicSpenders: string[] = [];
      try {
        if (!live) throw new Error("no_live");
        const bal = await live.client.getBalanceAllowance({
          asset_type: AssetType.CONDITIONAL,
          token_id: String(pos.optionId),
        });
        const balShares = Number(bal?.balance ?? "0") / 1e6; // ERC-1155 uses 6 decimals
        shareBalance = Number.isFinite(balShares)
          ? Math.min(pos.quantity, balShares)
          : pos.quantity;
        const allowances =
          (bal as any)?.allowances || (bal as any)?.allowance || {};
        dynamicSpenders = Object.keys(allowances ?? {});
        const vals: number[] = Object.values(allowances).map((v: any) =>
          Number(v),
        );
        hasAnyAllowance = vals.some((n) => Number.isFinite(n) && n > 0);
      } catch {}
      if (!hasAnyAllowance) {
        try {
          const pk = process.env[agent.walletPrivateKeyEnv as string];
          const owner =
            process.env[agent.walletAddressEnv as string] ||
            (pk
              ? new ethers.Wallet(pk.startsWith("0x") ? pk : `0x${pk}`).address
              : undefined);
          if (!pk || !owner) throw new Error("missing_wallet_env");
          const wallet = new ethers.Wallet(
            pk.startsWith("0x") ? pk : `0x${pk}`,
            provider,
          );
          const ct = new ethers.Contract(CTF, ERC1155_ABI, wallet);
          // Approve all spenders; tolerate partial failures
          const spenders =
            dynamicSpenders.length > 0 ? dynamicSpenders : SPENDERS_FALLBACK;
          for (const op of spenders) {
            const approved: boolean = await ct.isApprovedForAll(owner, op);
            if (!approved) {
              const fee = await provider.getFeeData();
              const minPrio = ethers.utils.parseUnits("30", "gwei");
              const prio =
                fee.maxPriorityFeePerGas && fee.maxPriorityFeePerGas.gt(minPrio)
                  ? fee.maxPriorityFeePerGas
                  : minPrio;
              let max = fee.maxFeePerGas;
              if (!max) {
                const base =
                  fee.gasPrice ?? ethers.utils.parseUnits("60", "gwei");
                max = base.mul(2).add(prio);
              }
              await ct.setApprovalForAll(op, true, {
                type: 2,
                maxPriorityFeePerGas: prio,
                maxFeePerGas: max,
              });
            }
          }
          // Recheck
          try {
            if (!live) throw new Error("no_live");
            const bal2 = await live.client.getBalanceAllowance({
              asset_type: AssetType.CONDITIONAL,
              token_id: String(pos.optionId),
            });
            const allowances2 =
              (bal2 as any)?.allowances || (bal2 as any)?.allowance || {};
            const vals2: number[] = Object.values(allowances2).map((v: any) =>
              Number(v),
            );
            hasAnyAllowance = vals2.some((n) => Number.isFinite(n) && n > 0);
          } catch {}
        } catch (err) {
          console.error(
            JSON.stringify({
              agentId: agent.id,
              marketId: pos.marketId,
              optionId: pos.optionId,
              error: "conditional_token_approval_failed",
              detail: (err as any)?.message,
            }),
          );
        }
        if (!hasAnyAllowance) {
          console.error(
            JSON.stringify({
              agentId: agent.id,
              marketId: pos.marketId,
              optionId: pos.optionId,
              error: "missing_conditional_token_approval_after_attempt",
            }),
          );
          continue;
        }
      }
      if (!(shareBalance > 0)) {
        console.log(
          JSON.stringify({
            agentId: agent.id,
            marketId: pos.marketId,
            optionId: pos.optionId,
            action: "skip",
            reason: "no_share_balance",
            estimatedFromDb: pos.quantity,
          }),
        );
        continue;
      }
      // CLOB supports 2 decimal places for share size; align dust threshold with ui.minOpenQuantity
      if (shareBalance < minQty) {
        console.log(
          JSON.stringify({
            agentId: agent.id,
            marketId: pos.marketId,
            optionId: pos.optionId,
            action: "skip",
            reason: "dust_shares_lt_minQty",
            minQty,
            quantity: shareBalance,
          }),
        );
        continue;
      }
      // Pre-round to 2 decimals to avoid residuals becoming invalid-size
      const sharesToSell = Math.floor(shareBalance * 100) / 100;
      const notional = exitPrice * sharesToSell;
      if (!(notional > 0)) {
        console.log(
          JSON.stringify({
            agentId: agent.id,
            marketId: pos.marketId,
            optionId: pos.optionId,
            action: "skip",
            reason: "non_positive_notional",
            exitPrice,
            quantity: pos.quantity,
          }),
        );
        continue;
      }

      // Resolve fee bps from CLOB; fallback to config taker bps
      let feeBps: number | undefined = undefined;
      try {
        const tokenOk =
          typeof pos.optionId === "string" && /^\d+$/.test(pos.optionId);
        feeBps = tokenOk
          ? await polymarket.getFeeRateBps(pos.optionId)
          : undefined;
      } catch {}
      const feeSource =
        typeof feeBps === "number"
          ? "clob_fee_rate"
          : ((runtime as any)?.fees?.source ?? "config");
      const effectiveFeeBps =
        typeof feeBps === "number"
          ? feeBps
          : ((runtime as any)?.fees?.trading?.takerBps ?? 0);

      // Record instruction
      const instructionId = repo.recordTradeInstruction({
        evaluationId: 0,
        agentId: agent.id,
        marketId: pos.marketId,
        optionId: pos.optionId,
        direction: "sell",
        notional,
        expectedPrice: exitPrice,
        reason: "Strategic exit",
        createdAt: new Date(),
      });

      if (paperMode) {
        const fill = portfolio.executeTrade({
          tradeInstructionId: instructionId,
          marketId: pos.marketId,
          optionId: pos.optionId,
          direction: "sell",
          price: exitPrice,
          notional,
          metadata: { feeBps: effectiveFeeBps, feeSource },
        });
        results.push({
          agentId: agent.id,
          mode: "paper",
          marketId: pos.marketId,
          optionId: pos.optionId,
          instructionId,
          quantity: fill.quantity,
          price: exitPrice,
          pnl: fill.pnl,
        });
      } else if (live && live.client) {
        const tokenOk =
          typeof pos.optionId === "string" && /^\d+$/.test(pos.optionId);
        if (!tokenOk) {
          console.error(
            JSON.stringify({
              agentId: agent.id,
              marketId: pos.marketId,
              optionId: pos.optionId,
              error: "non_numeric_token_id",
            }),
          );
          continue;
        }
        try {
          const willDryRun = submitOverride ? false : liveCfg.dryRun !== false;
          let remaining = shareBalance;
          let loops = 0;
          let lastBal = remaining;
          while (remaining > 0 && loops < 3) {
            const sellQty = Math.floor(remaining * 100) / 100; // 2-decimal shares
            // Refresh best bid & price each loop via shared helper
            let bestBidNow: number | undefined =
              exitPrice > 0 ? exitPrice : undefined;
            try {
              const ob = await polymarket.getOrderBook(String(pos.optionId));
              bestBidNow = ob?.bids?.[0]?.price ?? bestBidNow;
            } catch {}
            const priceLoop = computeExitPriceForSell({
              bestBid: bestBidNow,
              mid: undefined,
              averagePrice: exitPrice > 0 ? exitPrice : pos.averagePrice,
              quantity: sellQty,
              exitsConfig: runtime.exits,
            });
            const bidNow = priceLoop?.exitPrice ?? bestBidNow ?? exitPrice;
            const sellNotional =
              priceLoop?.notional ?? Math.max(0, bidNow * sellQty);
            if (!(sellNotional > 0)) break;
            if (sellQty < minQty) {
              console.log(
                JSON.stringify({
                  agentId: agent.id,
                  marketId: pos.marketId,
                  optionId: pos.optionId,
                  action: "skip",
                  reason: "dust_shares_lt_minQty",
                  minQty,
                  quantity: remaining,
                }),
              );
              break;
            }
            const res = await submitMarketOrder(live.client, {
              tokenId: String(pos.optionId),
              side: "sell",
              notional: sellNotional,
              expectedPrice: bidNow,
              feeRateBps: effectiveFeeBps,
              dryRun: willDryRun,
            });
            if (res.orderId) {
              try {
                repo.setTradeInstructionLiveInfo(instructionId, {
                  orderId: res.orderId,
                  status: "open",
                  updatedAt: new Date(),
                });
              } catch {}
            }
            results.push({
              agentId: agent.id,
              mode: willDryRun ? "live-dry-run" : "live",
              marketId: pos.marketId,
              optionId: pos.optionId,
              instructionId,
              orderId: res.orderId,
              notional: sellNotional,
              expectedPrice: bidNow,
            });
            // Re-fetch balanceAllowance to see if remaining decreased
            try {
              const bal3 = await live.client.getBalanceAllowance({
                asset_type: AssetType.CONDITIONAL,
                token_id: String(pos.optionId),
              });
              const balShares3 = Number(bal3?.balance ?? "0") / 1e6;
              remaining = Math.max(0, Math.min(pos.quantity, balShares3));
            } catch {
              break;
            }
            if (Math.abs(remaining - lastBal) < 1e-6) break; // no progress
            lastBal = remaining;
            loops++;
          }
        } catch (e) {
          console.error(
            JSON.stringify({
              agentId: agent.id,
              marketId: pos.marketId,
              optionId: pos.optionId,
              error: (e as Error).message,
            }),
          );
        }
      }
    }
  }

  console.log(JSON.stringify({ ok: true, results }));
  closeDatabase(db);
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exit(1);
});
