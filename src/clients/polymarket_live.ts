import { ClobClient, Side, OrderType, AssetType, type ApiKeyCreds } from '@polymarket/clob-client';
import { COLLATERAL_TOKEN_DECIMALS } from '@polymarket/clob-client/dist/config';
import { Wallet } from 'ethers';

import type { AgentDefinition } from '../config/schema';

export interface LiveEnv {
  host: string;
  chainId: number;
  signatureType: number; // 0 = browser, 1 = Magic
  walletPrivateKey: string;
  walletAddress: string;
  funderAddress?: string;
  l2: ApiKeyCreds;
}

function deriveSuffixFromEnvVar(name: string): string | undefined {
  if (!name) return undefined;
  const idx = name.lastIndexOf('_');
  if (idx < 0 || idx === name.length - 1) return undefined;
  return name.slice(idx + 1);
}

export function resolveLiveTradingEnv(agent: AgentDefinition, env: Record<string, string | undefined> = process.env): LiveEnv | undefined {
  const host = env.POLY_CLOB_HOST || 'https://clob.polymarket.com';
  const chainId = Number(env.POLY_CHAIN_ID || 137);
  const signatureType = Number(env.POLY_SIGNATURE_TYPE || 0);

  const pk = env[agent.walletPrivateKeyEnv];
  let address = env[agent.walletAddressEnv];
  if (!pk) return undefined;
  // Derive address when not explicitly provided
  if (!address) {
    try { address = new Wallet(pk.startsWith('0x') ? pk : `0x${pk}`).address; } catch {}
  }
  if (!address) return undefined;

  // Try per-agent L2 env names first, falling back to global POLY_API_* vars
  const suffix = deriveSuffixFromEnvVar(agent.walletPrivateKeyEnv) || deriveSuffixFromEnvVar(agent.walletAddressEnv);
  const key = (suffix && env[`POLY_API_KEY_${suffix}`]) || env.POLY_API_KEY;
  const secret = (suffix && env[`POLY_API_SECRET_${suffix}`]) || env.POLY_API_SECRET;
  const passphrase = (suffix && env[`POLY_API_PASSPHRASE_${suffix}`]) || env.POLY_API_PASSPHRASE;
  if (!key || !secret || !passphrase) return undefined;

  const funderAddress = env.POLY_FUNDER_ADDRESS || address;

  return {
    host,
    chainId,
    signatureType,
    walletPrivateKey: pk.startsWith('0x') ? pk : `0x${pk}`,
    walletAddress: address,
    funderAddress,
    l2: { key, secret, passphrase }
  };
}

export function createClobClientForAgent(agent: AgentDefinition, env: Record<string, string | undefined> = process.env): { client: ClobClient; walletAddress: string } | undefined {
  const cfg = resolveLiveTradingEnv(agent, env);
  if (!cfg) return undefined;
  const signer = new Wallet(cfg.walletPrivateKey);
  const client = new ClobClient(cfg.host, cfg.chainId as any, signer, cfg.l2, cfg.signatureType as any, cfg.funderAddress);
  return { client, walletAddress: cfg.walletAddress };
}

function isClientErrorResponse(res: unknown): res is { error: unknown; status?: unknown } {
  return !!res && typeof res === 'object' && 'error' in (res as any);
}

export async function fetchUsdcBalance(client: ClobClient): Promise<number> {
  const res: any = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  // @polymarket/clob-client returns {error,status} on HTTP failures (it does not throw).
  // Treat that as a hard failure rather than silently mapping to 0.
  if (isClientErrorResponse(res)) {
    throw new Error(`[CLOB] getBalanceAllowance(COLLATERAL) failed: ${String(res.error)}${res.status ? ` (status=${String(res.status)})` : ''}`);
  }
  const raw = res?.balance;
  if (!(typeof raw === 'string' || typeof raw === 'number')) {
    throw new Error('[CLOB] getBalanceAllowance(COLLATERAL) returned an unexpected payload (missing balance)');
  }
  // The CLOB returns USDC.e balance as a string in base units (6 decimals)
  // Normalize to human units for UI/portfolio math.
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error('[CLOB] getBalanceAllowance(COLLATERAL) returned a non-numeric balance');
  }
  const denom = Math.pow(10, COLLATERAL_TOKEN_DECIMALS || 6);
  return n / denom;
}

/**
 * Fetch live CONDITIONAL (ERC‑1155) balance for a specific outcome token.
 * Returns shares in human units (assuming 6 decimals, consistent with the CLOB).
 */
export async function fetchConditionalBalance(client: ClobClient, tokenId: string): Promise<number> {
  if (!tokenId) return 0;
  const res: any = await client.getBalanceAllowance({ asset_type: AssetType.CONDITIONAL, token_id: tokenId });
  if (isClientErrorResponse(res)) {
    throw new Error(`[CLOB] getBalanceAllowance(CONDITIONAL) failed: ${String(res.error)}${res.status ? ` (status=${String(res.status)})` : ''}`);
  }
  const raw = (res as any)?.balance;
  if (!(typeof raw === 'string' || typeof raw === 'number')) {
    throw new Error('[CLOB] getBalanceAllowance(CONDITIONAL) returned an unexpected payload (missing balance)');
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error('[CLOB] getBalanceAllowance(CONDITIONAL) returned a non-numeric balance');
  }
  // Polymarket conditional tokens use 6 decimals for balances.
  const denom = Math.pow(10, 6);
  return n / denom;
}

export interface SubmitOrderParams {
  tokenId: string; // numeric CLOB token id as string
  side: 'buy' | 'sell';
  notional: number; // USD for buys; USD notional for sells (converted to shares via price)
  expectedPrice?: number; // used to convert sell notional -> shares
  feeRateBps?: number;
  orderType?: OrderType.FOK | OrderType.FAK;
  dryRun?: boolean;
}

export async function submitMarketOrder(
  client: ClobClient,
  params: SubmitOrderParams
): Promise<{ posted: boolean; orderId?: string; debug?: unknown }>
{
  const { tokenId, side, notional, expectedPrice, feeRateBps, orderType = OrderType.FAK, dryRun } = params;
  const s = side === 'sell' ? Side.SELL : Side.BUY;
  if (notional <= 0) return { posted: false, debug: { reason: 'notional<=0' } };

  if (dryRun) {
    // Build signed order but do not post to the exchange
    if (s === Side.BUY) {
      const signed = await client.createMarketOrder({ tokenID: tokenId, side: s, amount: notional, price: expectedPrice, feeRateBps }, { tickSize: await client.getTickSize(tokenId) });
      return { posted: false, debug: { signed } };
    } else {
      // SELL: amount is in shares; derive from notional / price
      const price = typeof expectedPrice === 'number' ? expectedPrice : undefined;
      const qty = price ? notional / price : 0;
      const signed = await client.createMarketOrder({ tokenID: tokenId, side: s, amount: qty, price, feeRateBps }, { tickSize: await client.getTickSize(tokenId) });
      return { posted: false, debug: { signed } };
    }
  }

  // Live submit: use market order helper with FAK (partial ok)
  if (s === Side.BUY) {
    try {
      const resp: any = await client.createAndPostMarketOrder(
        { tokenID: tokenId, side: s, amount: notional, price: expectedPrice, feeRateBps },
        { tickSize: await client.getTickSize(tokenId) },
        orderType,
      );
      const orderId = resp && (resp.orderID || resp.id);
      const hasError =
        !resp ||
        resp.error ||
        (typeof resp.status === 'number' && resp.status >= 400) ||
        resp.success === false ||
        !orderId;
      if (hasError) {
        return { posted: false, orderId: undefined, debug: resp };
      }
      return { posted: true, orderId: String(orderId), debug: resp };
    } catch (e) {
      return { posted: false, orderId: undefined, debug: e };
    }
  } else {
    const price = typeof expectedPrice === 'number' ? expectedPrice : undefined;
    const qty = price ? notional / price : 0;
    if (!(qty > 0)) {
      return { posted: false, orderId: undefined, debug: { reason: 'quantity<=0' } };
    }
    try {
      const resp: any = await client.createAndPostMarketOrder(
        { tokenID: tokenId, side: s, amount: qty, price, feeRateBps },
        { tickSize: await client.getTickSize(tokenId) },
        orderType,
      );
      const orderId = resp && (resp.orderID || resp.id);
      const hasError =
        !resp ||
        resp.error ||
        (typeof resp.status === 'number' && resp.status >= 400) ||
        resp.success === false ||
        !orderId;
      if (hasError) {
        return { posted: false, orderId: undefined, debug: resp };
      }
      return { posted: true, orderId: String(orderId), debug: resp };
    } catch (e) {
      return { posted: false, orderId: undefined, debug: e };
    }
  }
}
