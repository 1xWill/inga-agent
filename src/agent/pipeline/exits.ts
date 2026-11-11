import type { OrderBookLevel, PolymarketClient } from "../../clients/polymarket";
import type { RuntimeConfig } from "../../config/schema";
import type { AgentRepository } from "../repository";
import type { AgentRepositoryAsync } from "../../storage/types";
import type { PortfolioManager } from "../portfolio";
import type { PortfolioManagerLive } from "../portfolio_live";
import type { AgentDefinition } from "../../config/schema";
import { submitMarketOrder, fetchConditionalBalance } from "../../clients/polymarket_live";
import { AssetType } from "@polymarket/clob-client";
import { ethers } from "ethers";
import { getContractConfig } from "@polymarket/clob-client/dist/config.js";
import { deriveEffectiveTargets } from "./targets";
import { computeExitPriceForSell } from "./pricing";

interface ManageExitsInput {
  agentId: string;
  runtime: RuntimeConfig;
  repo: AgentRepository | AgentRepositoryAsync;
  portfolio: PortfolioManager | PortfolioManagerLive;
  polymarket: PolymarketClient;
  // When provided along with agent, manageExits will submit live SELL orders instead of simulating fills
  agent?: AgentDefinition;
  liveTrading?: { client: any };
  log?: (msg: string, data?: unknown) => void;
  seedPositions?: Array<{
    id?: number;
    agentId?: string;
    marketId: string;
    optionId: string | number;
    direction?: string;
    quantity: number;
    averagePrice: number;
    status?: string;
    openedAt?: Date;
    updatedAt?: Date;
  }>;
}

// In-memory consecutive trigger tracking per position and reason
const exitSignalCounts = new Map<string, number>();

function key(agentId: string, marketId: string, optionId: string, reason: string) {
  return `${agentId}:${marketId}:${optionId}:${reason}`;
}

function sumTopNotional(levels: OrderBookLevel[] | undefined, k: number): number {
  if (!levels || levels.length === 0 || k <= 0) return 0;
  return levels.slice(0, k).reduce((acc, l) => acc + (l.price * l.quantity), 0);
}

type LogFn = (msg: string, data?: unknown) => void;

const RECENT_SELL_HOLDOFF_MS = 2 * 60 * 1000; // 2 minutes
const TERMINAL_SELL_STATUSES = new Set([
  "filled",
  "matched",
  "canceled",
  "failed",
  "not_submitted",
  "rejected",
]);
const EXIT_RETRY_MAX_PASSES = 4;
const EXIT_RETRY_DELAY_MS = 2500;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface LiveOrderParams {
  agentId: string;
  agent: AgentDefinition;
  runtime: RuntimeConfig;
  polymarket: PolymarketClient;
  liveTrading: { client: any };
  marketId: string;
  optionId: string | number;
  side: 'buy' | 'sell';
  tokenId: string;
  notional: number;
  expectedPrice?: number;
  minQty?: number;
  log?: LogFn;
}

export interface LiveOrderResult {
  posted: boolean;
  orderId?: string;
  notional: number;
  shares?: number;
  feeBps: number;
  feeSource: string;
  dryRun: boolean;
  error?: string;
  debug?: unknown;
}

export function formatLiveOrderError(base?: string, debug?: unknown): string | undefined {
  if (!base) return undefined;
  if (!debug) return base;
  let extra: string | undefined;
  if (typeof debug === "string") {
    extra = debug;
  } else {
    try {
      extra = JSON.stringify(debug);
    } catch {
      extra = undefined;
    }
  }
  if (!extra) return base;
  const trimmed = extra.length > 400 ? `${extra.slice(0, 400)}…` : extra;
  return `${base}: ${trimmed}`;
}

/**
 * Central helper for live BUY/SELL submissions.
 * - Preflights balances and allowances.
 * - Automatically submits ERC-20 / ERC-1155 approvals when needed.
 * - Calls submitMarketOrder only when preflight passes.
 */
export async function submitLiveOrderWithPreflight(params: LiveOrderParams): Promise<LiveOrderResult> {
  const {
    agentId,
    agent,
    runtime,
    polymarket,
    liveTrading,
    marketId,
    optionId,
    side,
    tokenId,
    notional,
    expectedPrice,
    minQty,
    log,
  } = params;

  const client = (liveTrading as any).client;
  const liveCfg = ((runtime as any)?.execution?.live ?? {}) as { dryRun?: boolean };
  const willDryRun = liveCfg.dryRun !== false ? true : false;

  const baseFeeSource = (runtime as any)?.fees?.source ?? 'config';
  let feeBps: number | undefined;
  try {
    feeBps = await polymarket.getFeeRateBps(tokenId);
  } catch {}
  const feeSource =
    typeof feeBps === 'number' ? 'clob_fee_rate' : baseFeeSource;
  const effectiveFeeBps =
    typeof feeBps === 'number'
      ? feeBps
      : ((runtime as any)?.fees?.trading?.takerBps ?? 0);

  if (!(notional > 0)) {
    return {
      posted: false,
      orderId: undefined,
      notional: 0,
      shares: side === 'sell' ? 0 : undefined,
      feeBps: effectiveFeeBps,
      feeSource,
      dryRun: true,
      error: 'invalid_notional',
    };
  }

  if (typeof tokenId !== 'string' || !/^\d+$/.test(tokenId)) {
    if (log)
      log('Live order skipped: non-numeric tokenId', {
        agentId,
        marketId,
        optionId,
        tokenId,
      });
    return {
      posted: false,
      orderId: undefined,
      notional: 0,
      shares: side === 'sell' ? 0 : undefined,
      feeBps: effectiveFeeBps,
      feeSource,
      dryRun: true,
      error: 'non_numeric_token_id',
    };
  }

  const chainId = Number(process.env.POLY_CHAIN_ID || 137);

  if (side === 'buy') {
    // BUY (USDC.e collateral) path
    try {
      const balCol = await client.getBalanceAllowance({
        asset_type: (AssetType as any).COLLATERAL,
      });
      const denom = Math.pow(10, 6);
      const balanceUnits = Number(((balCol as any)?.balance ?? '0')) / denom;
      const allowancesObj =
        (balCol as any)?.allowances || (balCol as any)?.allowance || {};

      const negRisk = await client.getNegRisk(tokenId).catch(() => false);
      const contracts = getContractConfig(chainId as any);
      const requiredSpenders: string[] = negRisk
        ? [
            (contracts as any).negRiskExchange as string,
            (contracts as any).negRiskAdapter as string,
          ]
        : [(contracts as any).exchange as string];

      const spenderAllowanceUnits =
        requiredSpenders.length > 0
          ? Math.min(
              ...requiredSpenders.map(
                (s) => Number((allowancesObj?.[s] ?? 0)) / denom,
              ),
            )
          : 0;
      const spendable = Math.min(balanceUnits, spenderAllowanceUnits);

      if (notional > spendable + 1e-6) {
        // Default ON: attempt USDC.e approval unless explicitly disabled via env
        const autoApproveEnv = String(
          process.env.POLY_AUTO_APPROVE_USDC || 'true',
        ).toLowerCase();
        const autoApproveEnabled = !(
          autoApproveEnv === '0' ||
          autoApproveEnv === 'false' ||
          autoApproveEnv === 'no'
        );
        if (autoApproveEnabled) {
          try {
            const { Wallet } = ethers as any;
            const rpcUrl =
              process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com';
            const pk = process.env[
              agent.walletPrivateKeyEnv as string
            ] as string | undefined;
            const owner =
              (process.env[
                agent.walletAddressEnv as string
              ] as string | undefined) ||
              (pk
                ? new Wallet(pk.startsWith('0x') ? pk : `0x${pk}`).address
                : undefined);
            if (!pk || !owner) throw new Error('missing_wallet_envs');

            const provider = new (ethers as any).providers.JsonRpcProvider(
              rpcUrl,
              chainId,
            );
            const contracts2 = getContractConfig(chainId as any);
            const usdcAddress =
              process.env.POLY_COLLATERAL_TOKEN ||
              (contracts2 as any).collateral;
            const ERC20_ABI = [
              'function approve(address spender, uint256 amount) external returns (bool)',
              'function allowance(address owner, address spender) external view returns (uint256)',
            ];
            const wallet = new Wallet(
              pk.startsWith('0x') ? pk : `0x${pk}`,
              provider,
            );
            const usdc = new (ethers as any).Contract(
              usdcAddress,
              ERC20_ABI,
              wallet,
            );

            const infiniteEnv = String(
              process.env.POLY_AUTO_APPROVE_INFINITE || '',
            ).toLowerCase();
            const approveInfinite =
              infiniteEnv === '1' ||
              infiniteEnv === 'true' ||
              infiniteEnv === 'yes';
            const amtEnv = process.env.POLY_USDC_APPROVE_AMOUNT;
            const approveHuman = approveInfinite
              ? 'infinite'
              : amtEnv && Number(amtEnv) > 0
                ? amtEnv
                : '25000';
            const amountWei = approveInfinite
              ? (ethers as any).constants.MaxUint256
              : (ethers as any).utils.parseUnits(String(approveHuman), 6);

            const fee = await provider.getFeeData();
            const minPrio = (ethers as any).utils.parseUnits('120', 'gwei');
            const prio =
              fee.maxPriorityFeePerGas &&
              fee.maxPriorityFeePerGas.gt(minPrio)
                ? fee.maxPriorityFeePerGas
                : minPrio;
            const base =
              fee.gasPrice ||
              (ethers as any).utils.parseUnits('100', 'gwei');
            let max = fee.maxFeePerGas;
            if (!max || max.lt(prio)) {
              const cand = base.mul(3).add(prio);
              const cand2 = prio.mul(8);
              max = cand.gt(cand2) ? cand : cand2;
            }

            const approveAllSpendersEnv = String(
              process.env.POLY_AUTO_APPROVE_ALL_SPENDERS || '',
            ).toLowerCase();
            const approveAllSpenders =
              approveAllSpendersEnv === '1' ||
              approveAllSpendersEnv === 'true' ||
              approveAllSpendersEnv === 'yes';
            const knownSpenders = [
              (contracts2 as any).exchange as string,
              (contracts2 as any).negRiskExchange as string,
              (contracts2 as any).negRiskAdapter as string,
            ];
            const defaultSet = requiredSpenders;
            const others = knownSpenders.filter(
              (s) =>
                !defaultSet
                  .map((x) => String(x).toLowerCase())
                  .includes(String(s).toLowerCase()),
            );
            const spendersToApprove: string[] = approveAllSpenders
              ? [...defaultSet, ...others]
              : [...defaultSet];

            for (const spender of spendersToApprove) {
              try {
                const current: any = await usdc.allowance(owner, spender);
                if (!approveInfinite) {
                  const currentNum =
                    Number((current as any).toString()) / denom;
                  if (currentNum >= Number(approveHuman)) {
                    continue;
                  }
                }
                const tx = await wallet.sendTransaction({
                  ...(await usdc.populateTransaction.approve(
                    spender,
                    amountWei,
                  )),
                  chainId,
                  type: 2,
                  maxPriorityFeePerGas: prio,
                  maxFeePerGas: max,
                });
                if (log)
                  log('Auto-approve USDC.e submitted', {
                    agentId,
                    marketId,
                    optionId,
                    spender,
                    amount: approveHuman,
                    tx: tx.hash,
                  });
                const confs = Math.max(
                  1,
                  Number(process.env.POLY_AUTO_APPROVE_CONFIRMATIONS || '1'),
                );
                const timeoutMs = Math.max(
                  60_000,
                  Number(
                    process.env.POLY_AUTO_APPROVE_TIMEOUT_MS || '300000',
                  ),
                );
                await provider
                  .waitForTransaction(tx.hash, confs, timeoutMs)
                  .catch(() => undefined);
              } catch (apErr) {
                if (log)
                  log('Auto-approve USDC.e failed for spender', {
                    agentId,
                    marketId,
                    optionId,
                    spender,
                    error: (apErr as Error)?.message,
                  });
              }
            }

            // Re-check spendable after approvals
            const bal2 = await client.getBalanceAllowance({
              asset_type: (AssetType as any).COLLATERAL,
            });
            const balUnits2 = Number(
              ((bal2 as any)?.balance ?? '0'),
            ) / denom;
            const allow2 =
              (bal2 as any)?.allowances || (bal2 as any)?.allowance || {};
            const spenderAllow2 =
              requiredSpenders.length > 0
                ? Math.min(
                    ...requiredSpenders.map(
                      (s) => Number((allow2?.[s] ?? 0)) / denom,
                    ),
                  )
                : 0;
            const spendable2 = Math.min(balUnits2, spenderAllow2);
            if (notional > spendable2 + 1e-6) {
              if (log)
                log('Live buy skipped after auto-approve: still insufficient', {
                  agentId,
                  marketId,
                  optionId,
                  notional,
                  spendable: spendable2,
                });
              return {
                posted: false,
                orderId: undefined,
                notional: 0,
                shares: undefined,
                feeBps: effectiveFeeBps,
                feeSource,
                dryRun: willDryRun,
                error: 'insufficient_allowance_or_balance',
              };
            }
          } catch (ae) {
            if (log)
              log('Live buy auto-approve error', {
                agentId,
                marketId,
                optionId,
                error: (ae as Error).message,
              });
            return {
              posted: false,
              orderId: undefined,
              notional: 0,
              shares: undefined,
              feeBps: effectiveFeeBps,
              feeSource,
              dryRun: willDryRun,
              error: 'autoapprove_error',
            };
          }
        } else {
          if (log)
            log('Live buy skipped: insufficient allowance/balance', {
              agentId,
              marketId,
              optionId,
              notional,
              spendable,
              balance: balanceUnits,
              allowance: spenderAllowanceUnits,
            });
          return {
            posted: false,
            orderId: undefined,
            notional: 0,
            shares: undefined,
            feeBps: effectiveFeeBps,
            feeSource,
            dryRun: willDryRun,
            error: 'insufficient_allowance_or_balance',
          };
        }
      }
    } catch (pfErr) {
      if (log)
        log('Live buy allowance preflight skipped', {
          agentId,
          marketId,
          optionId,
          error: (pfErr as Error).message,
        });
      // Fall through and let the CLOB enforce limits.
    }

    const res = await submitMarketOrder(client, {
      tokenId,
      side: 'buy',
      notional,
      expectedPrice,
      feeRateBps: effectiveFeeBps,
      dryRun: willDryRun,
    });

    if (log)
      log(
        res.posted && res.orderId
          ? 'Submitted live buy order'
          : willDryRun
            ? 'Built live buy order (dry-run)'
            : 'Live buy rejected',
        {
          agentId,
          marketId,
          optionId,
          notional,
          expectedPrice,
          orderId: res.orderId,
        },
      );

  return {
    posted: res.posted,
    orderId: res.orderId,
    notional: notional,
    shares: undefined,
    feeBps: effectiveFeeBps,
    feeSource,
    dryRun: willDryRun,
    error: !res.posted && !willDryRun ? 'submit_failed' : undefined,
    debug: res.debug,
  };
}

  // SELL (conditional ERC-1155) path
  const price = typeof expectedPrice === 'number' ? expectedPrice : 0;
  if (!(price > 0)) {
    return {
      posted: false,
      orderId: undefined,
      notional: 0,
      shares: 0,
      feeBps: effectiveFeeBps,
      feeSource,
      dryRun: true,
      error: 'invalid_size_or_price',
    };
  }

  const maxShares = notional / price;
  if (!(maxShares > 0)) {
    return {
      posted: false,
      orderId: undefined,
      notional: 0,
      shares: 0,
      feeBps: effectiveFeeBps,
      feeSource,
      dryRun: true,
      error: 'invalid_size_or_price',
    };
  }

  let sharesBudget = maxShares;
  // Track which operators must be approved so we can validate CLOB-side allowances
  // before posting a live sell.
  let requiredOps: string[] | undefined;

  try {
    const bal = await client.getBalanceAllowance({
      asset_type: (AssetType as any).CONDITIONAL,
      token_id: tokenId,
    });
    const rawBal = (bal as any)?.balance ?? '0';
    const balShares = Number(rawBal) / 1e6;
    if (Number.isFinite(balShares)) {
      sharesBudget = Math.min(sharesBudget, balShares);
    }

    const allowances =
      (bal as any)?.allowances || (bal as any)?.allowance || {};
    try {
      const negRisk = await client.getNegRisk(tokenId).catch(() => false);
      const cc = getContractConfig(chainId as any);
      requiredOps = negRisk
        ? [
            (cc as any).negRiskExchange as string,
            (cc as any).negRiskAdapter as string,
          ]
        : [(cc as any).exchange as string];
      const missing: string[] = requiredOps.filter(
        (op) => Number((allowances as any)?.[op] ?? 0) <= 0,
      );
      if (missing.length > 0) {
        const pk = process.env[
          agent.walletPrivateKeyEnv as string
        ] as string | undefined;
        const owner =
          (process.env[
            agent.walletAddressEnv as string
          ] as string | undefined) ||
          (pk
            ? new (ethers as any).Wallet(
                pk.startsWith('0x') ? pk : `0x${pk}`,
              ).address
            : undefined);
        if (pk && owner) {
          const provider = new (ethers as any).providers.JsonRpcProvider(
            process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com',
            chainId,
          );
          const CTF =
            process.env.POLY_CONDITIONAL_TOKENS ||
            ((cc as any).conditionalTokens as string);
          const ERC1155_ABI = [
            'function setApprovalForAll(address operator, bool approved) external',
            'function isApprovedForAll(address account, address operator) external view returns (bool)',
          ];
          const wallet = new (ethers as any).Wallet(
            pk.startsWith('0x') ? pk : `0x${pk}`,
            provider,
          );
          const ct = new (ethers as any).Contract(CTF, ERC1155_ABI, wallet);
          for (const op of missing) {
            const approved: boolean = await ct.isApprovedForAll(owner, op);
            if (!approved) {
              const fee = await provider.getFeeData();
              const minPrio = (ethers as any).utils.parseUnits('30', 'gwei');
              const prio =
                fee.maxPriorityFeePerGas &&
                fee.maxPriorityFeePerGas.gt(minPrio)
                  ? fee.maxPriorityFeePerGas
                  : minPrio;
              let max = fee.maxFeePerGas;
              if (!max) {
                const base =
                  fee.gasPrice ||
                  (ethers as any).utils.parseUnits('60', 'gwei');
                max = base.mul(2).add(prio);
              }
              const tx = await ct.setApprovalForAll(op, true, {
                type: 2,
                maxPriorityFeePerGas: prio,
                maxFeePerGas: max,
              });
              if (log) {
                log('Auto-approve ERC-1155 submitted', {
                  agentId,
                  marketId,
                  optionId,
                  operator: op,
                  tx: tx.hash,
                });
              }
              const confs = Math.max(
                1,
                Number(
                  process.env.POLY_AUTO_APPROVE_CONFIRMATIONS || '1',
                ),
              );
              const timeoutMs = Math.max(
                60_000,
                Number(
                  process.env.POLY_AUTO_APPROVE_TIMEOUT_MS || '300000',
                ),
              );
              await provider
                .waitForTransaction(tx.hash, confs, timeoutMs)
                .catch(() => undefined);
            }
          }
        } else if (log) {
          log('Skip auto-approval: missing wallet envs', {
            agentId,
            marketId,
            optionId,
          });
        }
      }
    } catch (e) {
      if (log)
        log('Auto approval (ERC-1155) failed or skipped', {
          agentId,
          marketId,
          optionId,
          error: (e as Error).message,
        });
    }
  } catch (e) {
    if (log)
      log('Live sell balance/allowance fetch failed', {
        agentId,
        marketId,
        optionId,
        error: (e as Error).message,
      });
  }

  let balShares = sharesBudget;
  try {
    const bal2 = await client.getBalanceAllowance({
      asset_type: (AssetType as any).CONDITIONAL,
      token_id: tokenId,
    });
    const s = Number((bal2 as any)?.balance ?? '0') / 1e6;
    if (Number.isFinite(s)) balShares = Math.min(sharesBudget, s);

    // If we know which operators must be approved, enforce that the CLOB now
    // reports a positive allowance for them before posting the sell. This
    // avoids race conditions where on-chain approvals are mined but the CLOB
    // indexer has not caught up yet, which would otherwise yield a 400
    // "not enough balance / allowance" on POST /order.
    if (requiredOps && requiredOps.length > 0) {
      const allowances2 =
        (bal2 as any)?.allowances || (bal2 as any)?.allowance || {};
      const missing2: string[] = requiredOps.filter(
        (op) => Number((allowances2 as any)?.[op] ?? 0) <= 0,
      );
      if (missing2.length > 0) {
        if (log) {
          log('Live sell skipped after auto-approve: insufficient allowance', {
            agentId,
            marketId,
            optionId,
            requiredOps,
            missing: missing2,
          });
        }
        return {
          posted: false,
          orderId: undefined,
          notional: 0,
          shares: 0,
          feeBps: effectiveFeeBps,
          feeSource,
          dryRun: willDryRun,
          error: 'insufficient_allowance_or_balance',
        };
      }
    }
  } catch {}

  if (!(balShares > 0.0)) {
    if (log)
      log('Live sell skipped: no share balance', {
        agentId,
        marketId,
        optionId,
        maxShares,
      });
    return {
      posted: false,
      orderId: undefined,
      notional: 0,
      shares: 0,
      feeBps: effectiveFeeBps,
      feeSource,
      dryRun: true,
      error: 'no_share_balance',
    };
  }

  const minQtyShares = typeof minQty === 'number' ? minQty : 0.01;
  const sharesToSell =
    Math.floor(Math.min(balShares, maxShares) * 100) / 100;
  if (!(sharesToSell >= minQtyShares)) {
    if (log)
      log('Live sell skipped: dust shares below minQty', {
        agentId,
        marketId,
        optionId,
        balance: balShares,
        sharesToSell,
        minQty: minQtyShares,
      });
    return {
      posted: false,
      orderId: undefined,
      notional: 0,
      shares: 0,
      feeBps: effectiveFeeBps,
      feeSource,
      dryRun: true,
      error: 'dust_below_minQty',
    };
  }

  const notionalRounded = sharesToSell * price;

  const res = await submitMarketOrder(client, {
    tokenId,
    side: 'sell',
    notional: notionalRounded,
    expectedPrice: price,
    feeRateBps: effectiveFeeBps,
    dryRun: willDryRun,
  });

  if (log)
    log(
      res.posted && res.orderId
        ? 'Submitted live sell order'
        : willDryRun
          ? 'Built live sell order (dry-run)'
          : 'Live sell rejected',
      {
        agentId,
        marketId,
        optionId,
        notional: notionalRounded,
        expectedPrice: price,
        orderId: res.orderId,
      },
    );

  return {
    posted: res.posted,
    orderId: res.orderId,
    notional: notionalRounded,
    shares: sharesToSell,
    feeBps: effectiveFeeBps,
    feeSource,
    dryRun: willDryRun,
    error: !res.posted && !willDryRun ? 'submit_failed' : undefined,
    debug: res.debug,
  };
}

export interface LiveSellParams {
  agentId: string;
  agent: AgentDefinition;
  runtime: RuntimeConfig;
  polymarket: PolymarketClient;
  liveTrading: { client: any };
  marketId: string;
  optionId: string | number;
  maxShares: number;
  minQty: number;
  price: number;
  log?: LogFn;
}

export interface LiveSellResult {
  posted: boolean;
  orderId?: string;
  shares: number;
  notional: number;
  feeBps: number;
  feeSource: string;
  dryRun: boolean;
  error?: string;
  debug?: unknown;
}

async function loadExitQuotes({
  pos,
  polymarket,
  repo,
  payoutCache,
  slugOf,
}: {
  pos: { marketId: string; optionId: string | number };
  polymarket: PolymarketClient;
  repo: AgentRepository | AgentRepositoryAsync;
  payoutCache: Map<string, any>;
  slugOf: (marketId: string) => Promise<string | undefined>;
}): Promise<{
  bestBid?: number;
  bestAsk?: number;
  bidLevels?: OrderBookLevel[];
  mid?: number;
}> {
  let bestBid: number | undefined;
  let bestAsk: number | undefined;
  let bidLevels: OrderBookLevel[] | undefined;
  try {
    let ob: any;
    if (typeof pos.optionId === "string" && /^\d+$/.test(pos.optionId)) {
      let resolvedPayout: number | undefined;
      try {
        const idx = await (repo as any).getOutcomeIndexByClobTokenId(
          pos.marketId,
          pos.optionId,
        );
        if (typeof idx === "number") {
          const slug = await slugOf(pos.marketId);
          if (slug) {
            let arr = payoutCache.get(slug);
            if (!arr) {
              arr = await polymarket.getMarketsBySlug(slug);
              payoutCache.set(slug, arr);
            }
            const mkt =
              Array.isArray(arr)
                ? arr.find((m: any) => (m as any)?.id === pos.marketId) ||
                  arr[0]
                : undefined;
            if (mkt) {
              const resolved =
                (mkt as any)?.closed === true &&
                String((mkt as any)?.umaResolutionStatus || "")
                  .toLowerCase()
                  .includes("resolved");
              if (resolved) {
                const prices = (mkt.outcomes ?? []).map((o: any) =>
                  typeof o.price === "number" ? o.price : NaN,
                );
                const v = prices[idx];
                resolvedPayout = Number.isFinite(v) ? (v as number) : undefined;
              }
            }
          }
        }
      } catch {}
      ob =
        typeof resolvedPayout !== "number"
          ? await polymarket.getOrderBook(pos.optionId)
          : undefined;
      if (!ob && typeof resolvedPayout === "number") {
        bestBid = resolvedPayout;
        bestAsk = resolvedPayout;
      }
    } else {
      try {
        ob = await (polymarket as any).getOrderBook(pos.optionId as any);
      } catch {}
    }
    if (ob) {
      const bids = Array.isArray(ob.bids)
        ? [...ob.bids].sort((a, b) => b.price - a.price)
        : [];
      const asks = Array.isArray(ob.asks)
        ? [...ob.asks].sort((a, b) => a.price - b.price)
        : [];
      bestBid = bids.length ? bids[0].price : undefined;
      bestAsk = asks.length ? asks[0].price : undefined;
      bidLevels = bids;
    } else {
      bestBid = undefined;
      bestAsk = undefined;
      bidLevels = undefined;
    }
  } catch {
    bestBid = undefined;
    bestAsk = undefined;
    bidLevels = undefined;
  }
  const mid =
    typeof bestBid === "number" && typeof bestAsk === "number"
      ? (bestBid + bestAsk) / 2
      : undefined;
  return { bestBid, bestAsk, bidLevels, mid };
}

export async function submitLiveSellWithApprovals(params: LiveSellParams): Promise<LiveSellResult> {
  const {
    agentId,
    agent,
    runtime,
    polymarket,
    liveTrading,
    marketId,
    optionId,
    maxShares,
    minQty,
    price,
    log,
  } = params;

  const tokenId = String(optionId);
  const notional = maxShares > 0 && price > 0 ? maxShares * price : 0;

  const res = await submitLiveOrderWithPreflight({
    agentId,
    agent,
    runtime,
    polymarket,
    liveTrading,
    marketId,
    optionId,
    side: 'sell',
    tokenId,
    notional,
    expectedPrice: price,
    minQty,
    log,
  });

  return {
    posted: res.posted,
    orderId: res.orderId,
    shares: res.shares ?? 0,
    notional: res.notional,
    feeBps: res.feeBps,
    feeSource: res.feeSource,
    dryRun: res.dryRun,
    error: res.error,
  };
}

/**
 * Checks open positions and exits based on configured thresholds:
 * - takeProfitPct: sell when bestBid >= avgPrice * (1 + tp)
 * - stopLossPct: sell when bestBid <= avgPrice * (1 - sl)
 * - maxHoldingMinutes: sell when holding exceeds configured minutes (time-based exit)
 */
export async function manageExits({
  agentId,
  runtime,
  repo,
  portfolio,
  polymarket,
  agent,
  liveTrading,
  log,
  seedPositions,
}: ManageExitsInput) {
  const exits = runtime.exits;
  if (!exits) return;

  const isLiveAgent = Boolean(agent && agent.paperTrading === false);
  const liveCfg = (runtime as any)?.execution?.live;
  if (isLiveAgent && (!liveTrading || !liveCfg || liveCfg.dryRun !== false)) {
    if (log)
      log('Live exits skipped (no client or dryRun enabled)', {
        agentId,
      });
    return;
  }

  const positions =
    Array.isArray(seedPositions) && seedPositions.length > 0
      ? seedPositions
      : await (repo as any).listOpenPositions(agentId);
  if (positions.length === 0) return;

  const now = new Date();
  const minQtyShares = Math.max(0, (runtime as any)?.ui?.minOpenQuantity ?? 0.01);

  // Near-resolution SELL guard helper (optional):
  // Blocks SELL exits within a time window around the market's scheduled close, and
  // also when Gamma reports the market as closed but not yet resolved by UMA.
  const resolutionGuardEnabled = Boolean(exits.resolutionGuardEnabled) &&
    typeof exits.resolutionGuardMinutes === 'number' && exits.resolutionGuardMinutes > 0;
  const guardMins = exits.resolutionGuardMinutes ?? 0;
  const payoutCache = new Map<string, any>(); // cache Gamma market arrays by slug for this tick
  const slugOf = async (marketId: string): Promise<string | undefined> => {
    try {
      const ev = await (repo as any).getLatestEvaluationSummary(marketId);
      const url = (ev as any)?.url as string | undefined;
      if (url) {
        const m = url.match(/\/market\/([a-z0-9\-]+)/i);
        if (m) return m[1];
      }
    } catch {}
    return undefined;
  };
  const isInResolutionGuardWindow = async (marketId: string): Promise<boolean> => {
    if (!resolutionGuardEnabled) return false;
    const slug = await slugOf(marketId);
    if (!slug) return false;
    let arr = payoutCache.get(slug);
    if (!arr) {
      try { arr = await polymarket.getMarketsBySlug(slug); payoutCache.set(slug, arr); } catch { return false; }
    }
    const mkt = Array.isArray(arr) ? (arr.find((m: any) => (m as any)?.id === marketId) || arr[0]) : undefined;
    if (!mkt) return false;
    const resolved = (mkt as any)?.closed === true && String((mkt as any)?.umaResolutionStatus || '').toLowerCase() === 'resolved';
    if ((mkt as any)?.closed === true && !resolved) {
      // Market is closed but not yet resolved — block sells
      return true;
    }
    const refIso: string | undefined = (mkt as any)?.closedTime || (mkt as any)?.endDate;
    if (!refIso) return false;
    const ref = new Date(refIso);
    if (!(ref instanceof Date) || isNaN(ref.getTime())) return false;
    const deltaMin = Math.abs((Date.now() - ref.getTime()) / 60000);
    return deltaMin <= guardMins;
  };

  // Build name/title maps from recent evaluations for logging context
  const evals = await (repo as any).listRecentMarketEvaluations(200, agentId);
  const titleMap = new Map<string, string>();
  const nameMap = new Map<string, string>();
  for (const e of evals) {
    titleMap.set(e.marketId, e.title);
    for (const o of e.outcomes as Array<{ id: string; name: string }>) {
      nameMap.set(`${e.marketId}:${o.id}`, o.name);
    }
  }

  // Latest BUY entry per (market, option) for TP/SL derivation
  const recentTrades: any[] = await (repo as any).listRecentTradeInstructions(
    200,
    agentId,
  );
  const lastEntryMap = new Map<string, any>();
  const lastSellMap = new Map<
    string,
    { createdAt: Date; liveStatus?: string | undefined }
  >();
  for (const t of recentTrades) {
    if (t.direction === "buy") {
      const key = `${t.marketId}:${t.optionId}`;
      const prev = lastEntryMap.get(key);
      if (!prev || new Date(t.createdAt) > new Date(prev.createdAt)) {
        lastEntryMap.set(key, t);
      }
    } else if (t.direction === "sell") {
      const created = new Date(t.createdAt);
      if (!Number.isFinite(created.getTime())) continue;
      const key = `${t.marketId}:${t.optionId}`;
      const prev = lastSellMap.get(key);
      if (!prev || created.getTime() > prev.createdAt.getTime()) {
        lastSellMap.set(key, { createdAt: created, liveStatus: t.liveStatus });
      }
    }
  }

  for (const pos of positions) {
    const posKey = `${pos.marketId}:${pos.optionId}`;
    const pendingSell = lastSellMap.get(posKey);
    if (pendingSell) {
      const ageMs = now.getTime() - pendingSell.createdAt.getTime();
      const status = String(pendingSell.liveStatus ?? "").toLowerCase();
      const isTerminal = TERMINAL_SELL_STATUSES.has(status);
      if (ageMs < RECENT_SELL_HOLDOFF_MS && !isTerminal) {
        if (log)
          log("Exit skipped (sell already pending)", {
            marketId: pos.marketId,
            optionId: pos.optionId,
            liveStatus: status || undefined,
            seconds: Math.round(ageMs / 1000),
          });
        continue;
      }
    }
    // Skip dust positions to avoid generating un-submittable exits
    if (pos.quantity < minQtyShares) {
      if (log)
        log("Exit skipped (dust position)", {
          marketId: pos.marketId,
          optionId: pos.optionId,
          quantity: pos.quantity,
          minQty: minQtyShares,
        });
      continue;
    }
    // Holding guard
    const minHoldMin = exits.minHoldingMinutes ?? 0;
    const heldMinutes = (now.getTime() - pos.openedAt.getTime()) / 60000;
    if (heldMinutes < minHoldMin) {
      continue;
    }

    // Resolution guard: defer SELL exits near scheduled close/resolution
    try {
      if (await isInResolutionGuardWindow(pos.marketId)) {
        if (log) log('Exit deferred (resolution guard window)', { marketId: pos.marketId, optionId: pos.optionId, minutes: guardMins });
        continue;
      }
    } catch {}

    // Orderbook and price derivation
    const { bestBid, bestAsk, bidLevels, mid } = await loadExitQuotes({
      pos,
      polymarket,
      repo,
      payoutCache,
      slugOf,
    });

    const priceForThresholds =
      typeof bestBid === "number" ? bestBid : undefined;

    const priceFloor = exits.priceFloor ?? 0.0;
    const priceCeiling = exits.priceCeiling ?? 1.0;
    const levels = runtime.tradeEvaluation.gating?.liquidityLevels ?? 1;
    const minExitNotional = exits.minExitTopBookNotional ?? 0;

    // Per-position TP/SL thresholds derived from the latest BUY instruction
    // when available; fall back to config-level exits for legacy positions.
    let tpLevel: number | undefined;
    let slLevel: number | undefined;
    const lastEntry = lastEntryMap.get(
      `${pos.marketId}:${pos.optionId}`,
    ) as
      | {
          expectedPrice?: number;
          takeProfitPrice?: number;
          stopPrice?: number;
        }
      | undefined;
    if (lastEntry) {
      const eff = deriveEffectiveTargets(
        {
          expectedPrice: lastEntry.expectedPrice,
          takeProfitPrice: lastEntry.takeProfitPrice,
          stopPrice: lastEntry.stopPrice,
        },
        runtime as any,
      );
      tpLevel = eff.tpEff;
      slLevel = eff.slEff;
    } else {
      // Generic legacy fallback using config exits against avg entry
      const avg = pos.averagePrice;
      if (typeof exits.takeProfitPct === "number") {
        const rawTp = avg * (1 + exits.takeProfitPct);
        tpLevel = Math.min(priceCeiling, Math.max(priceFloor, rawTp));
      }
      if (typeof exits.stopLossPct === "number") {
        const rawSl = avg * (1 - exits.stopLossPct);
        slLevel = Math.min(priceCeiling, Math.max(priceFloor, rawSl));
      }
    }

    // Evaluate exits in priority order: stop loss -> take profit -> time-based
    const avg = pos.averagePrice;
    const quantity = pos.quantity;
    const entryBasis =
      typeof lastEntry?.expectedPrice === "number"
        ? lastEntry.expectedPrice
        : avg;
    const describeTrigger = (
      kind: "tp" | "sl",
      pct?: number,
      level?: number,
    ) => {
      const pctText =
        typeof pct === "number"
          ? `${(pct * 100).toFixed(1).replace(/\.0$/, "")}%`
          : undefined;
      const priceText =
        typeof level === "number" ? level.toFixed(3) : undefined;
      const label = kind === "tp" ? "Take profit" : "Stop loss";
      if (pctText && priceText) return `${label} at ${pctText} (price ${priceText})`;
      if (pctText) return `${label} at ${pctText}`;
      if (priceText) return `${label} at price ${priceText}`;
      return label;
    };

    const tpPctEff =
      typeof entryBasis === "number" &&
      entryBasis > 0 &&
      typeof tpLevel === "number"
        ? (tpLevel / entryBasis) - 1
        : undefined;
    const slPctEff =
      typeof entryBasis === "number" &&
      entryBasis > 0 &&
      typeof slLevel === "number"
        ? 1 - slLevel / entryBasis
        : undefined;

    let reason: string | undefined;
    let reasonKey: string | undefined;

    // Stop loss
    if (typeof slLevel === "number" && typeof priceForThresholds === "number") {
      if (
        priceForThresholds >= priceFloor &&
        priceForThresholds <= priceCeiling &&
        priceForThresholds <= slLevel + 1e-9
      ) {
        reason = describeTrigger("sl", slPctEff, slLevel);
        reasonKey = "sl";
      }
    }

    // Take profit
    if (
      !reason &&
      typeof tpLevel === "number" &&
      typeof priceForThresholds === "number"
    ) {
      if (
        priceForThresholds >= priceFloor &&
        priceForThresholds <= priceCeiling &&
        priceForThresholds >= tpLevel - 1e-9
      ) {
        reason = describeTrigger("tp", tpPctEff, tpLevel);
        reasonKey = "tp";
      }
    }

    // Time-based
    if (!reason && typeof exits.maxHoldingMinutes === "number") {
      const heldMinutes =
        (now.getTime() - pos.openedAt.getTime()) / 60000;
      if (heldMinutes >= exits.maxHoldingMinutes) {
        reason = `Time-based exit at ${exits.maxHoldingMinutes}m`;
        reasonKey = "time";
      }
    }
    if (!reason || quantity <= 0) continue;

    // Consecutive trigger requirement
    const required = exits.consecutiveTriggers ?? 1;
    if (required > 1 && reasonKey) {
      const k = key(agentId, pos.marketId, pos.optionId, reasonKey);
      const prev = exitSignalCounts.get(k) ?? 0;
      const next = prev + 1;
      exitSignalCounts.set(k, next);
      if (next < required) {
        if (log) log('Exit signal observed (waiting for confirmation)', { marketId: pos.marketId, optionId: pos.optionId, reason, count: next, required });
        continue;
      }
      // reset after firing
      exitSignalCounts.delete(k);
    }

    const paperMode = agent ? (agent.paperTrading !== false ? true : false) : true;
    const tokenIdStr = String(pos.optionId);
    const tokenIsNumeric = /^\d+$/.test(tokenIdStr);
    const syncLivePositionQuantity = async (qty: number) => {
      if (paperMode) return;
      const upsert = (repo as any)?.upsertPosition;
      const closer = (repo as any)?.closePosition;
      try {
        if (qty <= minQtyShares) {
          if (typeof closer === "function") {
            await closer(agentId, pos.marketId, pos.optionId, new Date());
            return;
          }
          if (typeof upsert === "function") {
            await upsert({
              agentId,
              marketId: pos.marketId,
              optionId: pos.optionId,
              direction: pos.direction ?? "buy",
              quantity: 0,
              averagePrice: pos.averagePrice,
              status: "closed",
            });
          }
        } else if (typeof upsert === "function") {
          await upsert({
            agentId,
            marketId: pos.marketId,
            optionId: pos.optionId,
            direction: pos.direction ?? "buy",
            quantity: qty,
            averagePrice: pos.averagePrice,
            status: "open",
          });
        }
      } catch (err) {
        if (log)
          log("Exit live position sync failed", {
            marketId: pos.marketId,
            optionId: pos.optionId,
            error: (err as Error).message,
          });
      }
    };
    let sharesRemaining = quantity;
    if (!paperMode && tokenIsNumeric && liveTrading) {
      try {
        const liveBal = await fetchConditionalBalance(
          (liveTrading as any).client,
          tokenIdStr,
        );
        if (Number.isFinite(liveBal)) {
          sharesRemaining = Math.max(0, Number(liveBal));
          await syncLivePositionQuantity(sharesRemaining);
        }
      } catch {}
    }
    let pass = 0;
    let quotes: {
      bestBid?: number;
      bestAsk?: number;
      mid?: number;
      bidLevels?: OrderBookLevel[];
    } = { bestBid, bestAsk, mid, bidLevels };

    while (sharesRemaining >= minQtyShares && pass < EXIT_RETRY_MAX_PASSES) {
      pass += 1;

      const topBidNotional = sumTopNotional(quotes.bidLevels, levels);
      if (topBidNotional + 1e-9 < minExitNotional) {
        if (log)
          log("Exit deferred (insufficient bid depth)", {
            marketId: pos.marketId,
            marketTitle: titleMap.get(pos.marketId),
            optionId: pos.optionId,
            outcomeName: nameMap.get(`${pos.marketId}:${pos.optionId}`),
            required: minExitNotional,
            topBidNotional,
          });
        break;
      }

      const computed = computeExitPriceForSell({
        bestBid: quotes.bestBid,
        mid: quotes.mid,
        averagePrice: avg,
        quantity: sharesRemaining,
        exitsConfig: exits,
      });
      if (!computed) break;
      const { exitPrice, notional } = computed;

      const instructionId = await (repo as any).recordTradeInstruction({
        evaluationId: 0,
        agentId,
        marketId: pos.marketId,
        optionId: pos.optionId,
        direction: "sell",
        notional,
        expectedPrice: exitPrice,
        reason,
        createdAt: new Date(),
      });

      if (paperMode || !agent || !liveTrading) {
        let feeBps: number | undefined;
        try {
          const tokenId2 =
            typeof pos.optionId === "string" && tokenIsNumeric
              ? pos.optionId
              : undefined;
          feeBps = tokenId2
            ? await polymarket.getFeeRateBps(tokenId2)
            : undefined;
        } catch {}
        const feeSource =
          typeof feeBps === "number"
            ? "clob_fee_rate"
            : (runtime as any)?.fees?.source ?? "config";
        const effectiveFeeBps =
          typeof feeBps === "number"
            ? feeBps
            : (runtime as any)?.fees?.trading?.takerBps ?? 0;

        const fill = await (portfolio as any).executeTrade({
          tradeInstructionId: instructionId,
          marketId: pos.marketId,
          optionId: pos.optionId,
          direction: "sell",
          price: exitPrice,
          notional,
          metadata: { feeBps: effectiveFeeBps, feeSource },
        });
        await (repo as any).clearMarketCooldowns(agentId, pos.marketId);

        const returnPct = avg > 0 ? (exitPrice - avg) / avg : 0;
        if (log)
          log("Exit executed", {
            positionId: pos.id,
            marketId: pos.marketId,
            marketTitle: titleMap.get(pos.marketId),
            optionId: pos.optionId,
            outcomeName: nameMap.get(`${pos.marketId}:${pos.optionId}`),
            instructionId,
            reason,
            qty: sharesRemaining,
            price: exitPrice,
            avgEntry: avg,
            returnPct,
            pnl: fill.pnl,
          });
        sharesRemaining = 0;
        break;
      }

      const maxAttempts = 3;
      let attempt = 0;
      let resLive: LiveSellResult | undefined;
      let lastError: Error | undefined;

      while (attempt < maxAttempts && !resLive) {
        attempt += 1;
        try {
          const candidate = await submitLiveSellWithApprovals({
            agentId,
            agent,
            runtime,
            polymarket,
            liveTrading,
            marketId: pos.marketId,
            optionId: pos.optionId,
            maxShares: notional / exitPrice,
            minQty: minQtyShares,
            price: exitPrice,
            log,
          });
          resLive = candidate;
        } catch (err) {
          lastError = err as Error;
          if (attempt < maxAttempts) {
            const backoffMs = attempt === 1 ? 500 : 1500;
            await sleep(backoffMs);
          }
        }
      }

      if (!resLive) {
        if (log)
          log("Live exit submission failed", {
            marketId: pos.marketId,
            optionId: pos.optionId,
            error: lastError?.message ?? "unknown_error",
          });
        try {
          await (repo as any).setTradeInstructionLiveInfo(instructionId, {
            status: "failed",
            error: lastError?.message ?? "live_exit_retry_exhausted",
            updatedAt: new Date(),
          });
        } catch {}
        break;
      }

      if (resLive.orderId) {
        try {
          await (repo as any).setTradeInstructionLiveInfo(instructionId, {
            orderId: resLive.orderId,
            status: resLive.dryRun
              ? "dry_run"
              : resLive.posted
                ? "open"
                : "failed",
            updatedAt: new Date(),
          });
        } catch {}
      } else if (!resLive.dryRun) {
        const formattedError = formatLiveOrderError(
          resLive.error ?? "live_sell_not_posted",
          resLive.debug,
        );
        try {
          await (repo as any).setTradeInstructionLiveInfo(instructionId, {
            status: "failed",
            error: formattedError ?? resLive.error ?? "live_sell_not_posted",
            updatedAt: new Date(),
          });
        } catch {}
      }

      const effectiveFeeSource = resLive.feeSource;
      const effectiveFeeBps = resLive.feeBps;
      const notionalForFill =
        resLive.dryRun || (resLive.posted && resLive.orderId)
          ? resLive.notional
          : 0;
      if (notionalForFill > 0) {
        await (portfolio as any).executeTrade({
          tradeInstructionId: instructionId,
          marketId: pos.marketId,
          optionId: pos.optionId,
          direction: "sell",
          price: exitPrice,
          notional: notionalForFill,
          metadata: {
            feeBps: effectiveFeeBps,
            feeSource: effectiveFeeSource,
          },
        });
      }

      await (repo as any).clearMarketCooldowns(agentId, pos.marketId);
      if (log) {
        if (notionalForFill > 0) {
          log("Exit executed (live)", {
            positionId: pos.id,
            marketId: pos.marketId,
            marketTitle: titleMap.get(pos.marketId),
            optionId: pos.optionId,
            outcomeName: nameMap.get(`${pos.marketId}:${pos.optionId}`),
            instructionId,
            reason,
            qty: sharesRemaining,
            price: exitPrice,
            liveSubmitted: resLive.posted && !!resLive.orderId,
            attempt: pass,
          });
        } else {
          log("Live exit submission failed", {
            marketId: pos.marketId,
            optionId: pos.optionId,
            error: resLive.error ?? "live_sell_not_posted",
          });
        }
      }

      const executedShares =
        notionalForFill > 0 && typeof resLive.shares === "number"
          ? resLive.shares
          : 0;

      if (resLive.dryRun) {
        break;
      }

      let nextRemaining = sharesRemaining;
      if (tokenIsNumeric) {
        await sleep(EXIT_RETRY_DELAY_MS);
        try {
          const fresh = await fetchConditionalBalance(
            (liveTrading as any).client,
            tokenIdStr,
          );
          if (Number.isFinite(fresh)) {
            const freshVal = Math.max(0, Number(fresh));
            if (
              executedShares > 0 &&
              Math.abs(freshVal - sharesRemaining) < 1e-6
            ) {
              nextRemaining = Math.max(0, sharesRemaining - executedShares);
            } else {
              nextRemaining = freshVal;
            }
          } else {
            nextRemaining = Math.max(0, sharesRemaining - executedShares);
          }
        } catch {
          nextRemaining = Math.max(0, sharesRemaining - executedShares);
        }
      } else {
        nextRemaining = Math.max(0, sharesRemaining - executedShares);
      }
      sharesRemaining = Math.max(0, nextRemaining);
      await syncLivePositionQuantity(sharesRemaining);
      if (sharesRemaining < minQtyShares) {
        break;
      }
      quotes = await loadExitQuotes({
        pos,
        polymarket,
        repo,
        payoutCache,
        slugOf,
      });
    }

    if (sharesRemaining >= minQtyShares && !paperMode) {
      if (log)
        log("Exit incomplete after retries", {
          marketId: pos.marketId,
          optionId: pos.optionId,
          remainingShares: sharesRemaining,
        });
    }
  }
}
