#!/usr/bin/env tsx
/**
 * Inspect a Polymarket account (balance, trades, open orders, inferred positions).
 *
 * Requires valid L2 API credentials for the wallet (POLY_API_KEY/SECRET/PASSPHRASE
 * or suffixed per agent). Use --agent to select a configured agent, or rely on the
 * first enabled agent by default.
 *
 * Examples:
 *   npm run polymarket:account
 *   npm run polymarket:account -- --agent agent_grok --limit 50
 */
import 'dotenv/config';

import { loadAgentsConfig, loadRuntimeConfig } from '../src/config/loaders';
import { createClobClientForAgent } from '../src/clients/polymarket_live';
import { createHttpClient } from '../src/http/client';
import { createPolymarketClient } from '../src/clients/polymarket';
import { AssetType } from '@polymarket/clob-client';
import { getLiveAccountSnapshot } from '../src/server/liveAccount';

type TradeRow = {
  id: string;
  side: 'buy' | 'sell';
  price: number;
  size: number; // shares
  market: string;
  asset_id: string;
  match_time: string;
  taker_order_id?: string;
  fee_rate_bps?: number;
};

function argVal(name: string, def?: string): string | undefined {
  const k = `--${name}`;
  const i = process.argv.indexOf(k);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return def;
}
function hasFlag(name: string): boolean { return process.argv.includes(`--${name}`); }

function parseNum(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : (typeof v === 'number' ? v : NaN);
  return Number.isFinite(n) ? n : undefined;
}

async function main() {
  const root = process.cwd();
  const runtime = await loadRuntimeConfig(root);
  const agents = await loadAgentsConfig(root);
  const agentId = argVal('agent') || agents.agents.find(a => a.enabled)?.id || agents.agents[0]?.id;
  if (!agentId) throw new Error('No agent configured');
  const ag = agents.agents.find(a => a.id === agentId)!;

  const http = createHttpClient(runtime.http as any);
  const poly = createPolymarketClient({ httpClient: http, marketConfig: runtime.marketData, memoize: { orderBookTtlMs: (runtime.http as any)?.memoize?.clobOrderBookTtlMs, feeRateTtlMs: (runtime.http as any)?.memoize?.clobFeeRateTtlMs } });

  const limit = Math.max(1, Number(argVal('limit') || '100'));
  const mode = (argVal('mode', 'snapshot') as 'snapshot'|'balance'|'trades'|'scope');
  const token = argVal('token');

  const liveClient = createClobClientForAgent(ag as any);
  if (!liveClient) throw new Error('Missing live trading credentials for this agent');
  const client = liveClient.client;

  // Canonical live snapshot (deep trade window) for this agent
  const snap = await getLiveAccountSnapshot(ag as any, runtime as any, { tradesLimit: limit, includeOrders: true, deepClosed: true });
  const usdc = typeof snap.balance === 'number' ? snap.balance : 0;
  const trades: TradeRow[] = (snap.trades ?? [])
    .map((t: any) => ({
      id: String(t?.id ?? ''),
      side: (String(t?.side ?? '').toLowerCase() === 'sell' ? 'sell' : 'buy') as 'buy' | 'sell',
      price: parseNum(t?.price) ?? 0,
      size: parseNum(t?.size) ?? 0,
      market: String((t?.marketId || t?.tokenId) ?? ''),
      asset_id: String(t?.tokenId ?? ''),
      match_time: String(t?.matchTime ?? ''),
      taker_order_id: t?.takerOrderId ? String(t?.takerOrderId) : undefined,
      fee_rate_bps: parseNum(t?.feeRateBps),
    }))
    .filter((r) => r.id && r.price > 0 && r.size > 0)
    .slice(0, limit);

  // Early modes
  if (mode === 'balance') {
    console.log(JSON.stringify({ agentId, wallet: liveClient.walletAddress, usdc }, null, 2));
    return;
  }
  if (mode === 'trades') {
    console.log(JSON.stringify({ agentId, wallet: liveClient.walletAddress, trades }, null, 2));
    return;
  }
  if (mode === 'scope') {
    const apiKeys = await client.getApiKeys().catch((e:any)=>({ error: String(e?.message||e) }));
    const balCol = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL }).catch((e:any)=>({ error: String(e?.message||e) }));
    // The CLOB requires a valid token_id for CONDITIONAL (ERC-1155) queries; do not call without it.
    const balCond = token
      ? await client.getBalanceAllowance({ asset_type: AssetType.CONDITIONAL, token_id: token }).catch((e:any)=>({ error: String(e?.message||e), status: (e as any)?.status }))
      : { note: 'skipped: pass --token <tokenId> to query CONDITIONAL (ERC-1155) balance/allowance for a specific token' };
    console.log(JSON.stringify({ agentId, wallet: liveClient.walletAddress, apiKeys, balCol, balCond }, null, 2));
    return;
  }

  // Open Orders come from the snapshot when requested
  const openOrders = snap.openOrders ?? [];

  // Open positions are provided by the live snapshot (already enriched with
  // bestBid/bestAsk and mark-to-market).
  const openPositions: Array<{ tokenId: string; marketId: string; quantity: number; averagePrice: number; bestBid?: number; bestAsk?: number; mtm?: number }>
    = (snap.openPositions ?? []).map((p) => ({
      tokenId: p.tokenId,
      marketId: p.marketId,
      quantity: p.quantity,
      averagePrice: p.averagePrice,
      bestBid: p.bestBid,
      bestAsk: p.bestAsk,
      mtm: p.mtm,
    }));

  const out = {
    agentId,
    wallet: liveClient.walletAddress,
    usdc,
    openOrders: (openOrders ?? []).length,
    openOrdersSample: (openOrders ?? []).slice(0, 10).map((o: any) => ({
      id: String(o?.id),
      side: String(o?.side),
      market: String(o?.marketId ?? o?.market ?? ''),
      asset_id: String(o?.tokenId ?? o?.asset_id ?? ''),
      price: parseNum(o?.price) ?? 0,
      size: parseNum(o?.sizeRemaining ?? o?.size_remaining ?? o?.original_size) ?? 0,
      status: String(o?.status ?? 'open'),
    })),
    openPositions,
    tradesSample: trades.slice(-10),
  };

  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exit(1);
});
