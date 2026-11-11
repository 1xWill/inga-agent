#!/usr/bin/env tsx
/**
 * Enable USDC for a live agent wallet by setting ERC-20 allowances to Polymarket exchange contracts.
 *
 * What this does:
 * - Reads agent config (default: agent_grok)
 * - Uses the agent's private key to approve USDC.e (0x2791... on Polygon) for Polymarket spender contracts
 * - Verifies allowances after approval
 *
 * Safety:
 * - This sends on-chain transactions on Polygon (chainId 137) and requires MATIC for gas.
 * - Defaults to approving a configurable finite amount (not infinite). You can re-run to top up.
 */
import 'dotenv/config';
import { ethers } from 'ethers';
import { loadAgentsConfig } from '../src/config/loaders';

type SpenderKey = 'exchange' | 'negRiskExchange' | 'negRiskAdapter';

const USDC_E_POLYGON = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const SPENDERS: Record<SpenderKey, string> = {
  exchange: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E',
  negRiskAdapter: '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296',
  negRiskExchange: '0xC5d563A36AE78145C45a50134d48A1215220f80a',
};

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function balanceOf(address owner) external view returns (uint256)',
  'function decimals() external view returns (uint8)',
  'function symbol() external view returns (string)'
];

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
  const specificAgent = argVal('agent'); // when omitted, fan out to all enabled agents
  const spenderArg = (argVal('spender') as SpenderKey | undefined);
  const allFlag = argFlag('all');
  const approveAll = argFlag('infinite');
  const amountArg = argVal('amount'); // human units (e.g., 25000)
  const rpcUrl = argVal('rpc') || process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com';
  const confirmations = (() => { const s = argVal('confirmations'); const n = s ? parseInt(s, 10) : 1; return Number.isFinite(n) && n > 0 ? n : 1; })();
  const timeoutSec = (() => {
    const sCli = argVal('timeout');
    const sEnv = process.env.POLY_APPROVE_TIMEOUT_SEC;
    const raw = sCli ?? sEnv ?? '600';
    const n = parseInt(String(raw), 10);
    return Number.isFinite(n) && n > 0 ? n : 600;
  })();
  const noWait = argFlag('no-wait');
  const legacy = argFlag('legacy');
  const cliMaxPrio = (() => { const s = argVal('maxPrioGwei'); return s ? ethers.utils.parseUnits(s, 'gwei') : undefined; })();
  const cliMaxFee = (() => { const s = argVal('maxFeeGwei'); return s ? ethers.utils.parseUnits(s, 'gwei') : undefined; })();

  const cfg = await loadAgentsConfig(process.cwd());
  const agents = specificAgent
    ? cfg.agents.filter(a => a.id === specificAgent)
    : cfg.agents.filter(a => a.enabled);

  if (agents.length === 0) {
    throw new Error(specificAgent ? `Agent not found: ${specificAgent}` : 'No enabled agents found');
  }

  const provider = new ethers.providers.JsonRpcProvider(rpcUrl, 137);
  // Default to approving only 'exchange' to avoid multiple pending nonces; use --all to approve every spender
  const spenders = spenderArg ? [spenderArg] : (allFlag ? (Object.keys(SPENDERS) as SpenderKey[]) : (['exchange'] as SpenderKey[]));

  for (const ag of agents) {
    const pk = process.env[ag.walletPrivateKeyEnv as string];
    const address = process.env[ag.walletAddressEnv as string];
    if (!pk) {
      console.error(`skip agent ${ag.id}: missing ${ag.walletPrivateKeyEnv}`);
      continue;
    }
    const wallet = new ethers.Wallet(pk.startsWith('0x') ? pk : `0x${pk}`, provider);
    const owner = address || wallet.address;

    const usdc = new ethers.Contract(USDC_E_POLYGON, ERC20_ABI, wallet);
    const decimals: number = await usdc.decimals();
    const symbol: string = await usdc.symbol();
    const bal = await usdc.balanceOf(owner);

    console.log(JSON.stringify({ agentId: ag.id, owner, symbol, decimals, balance: bal.toString() }));
    if (bal.isZero()) {
      console.error(`agent ${ag.id}: USDC.e balance is 0. Top up 0x2791... (USDC.e) on Polygon for this wallet first.`);
    }

    let amountWei: ethers.BigNumber;
    if (approveAll) {
      amountWei = ethers.constants.MaxUint256;
    } else if (amountArg) {
      amountWei = ethers.utils.parseUnits(amountArg, decimals);
    } else {
      // default finite cap: 25,000 USDC
      amountWei = ethers.utils.parseUnits('25000', decimals);
    }

    for (const key of spenders) {
      const spender = SPENDERS[key];
      const current: ethers.BigNumber = await usdc.allowance(owner, spender);
      console.log(JSON.stringify({ agentId: ag.id, spenderKey: key, spender, currentAllowance: current.toString() }));
      if (current.gte(amountWei)) {
        console.log(`agent ${ag.id}: skip approve for ${key} — allowance already >= requested amount`);
        continue;
      }
      // Build robust fee overrides for Polygon
      const fee = await provider.getFeeData();
      const minPrio = ethers.utils.parseUnits('120', 'gwei'); // stronger floor priority on Polygon (safer default)
      const prio0 = cliMaxPrio ?? fee.maxPriorityFeePerGas ?? minPrio;
      const maxPriorityFeePerGas = prio0.lt(minPrio) ? minPrio : prio0;
      const base = fee.gasPrice ?? ethers.utils.parseUnits('100', 'gwei');
      let maxFeePerGas = cliMaxFee ?? fee.maxFeePerGas;
      if (!maxFeePerGas || maxFeePerGas.lt(maxPriorityFeePerGas)) {
        const cand = base.mul(3).add(maxPriorityFeePerGas);
        const cand2 = maxPriorityFeePerGas.mul(8);
        maxFeePerGas = cand.gt(cand2) ? cand : cand2;
      }
      const nonce = await provider.getTransactionCount(owner, 'pending');
      const gasLimit = await usdc.estimateGas.approve(spender, amountWei).catch(() => ethers.BigNumber.from(100000));
      const txReq: ethers.providers.TransactionRequest = await usdc.populateTransaction.approve(spender, amountWei);
      txReq.chainId = 137;
      txReq.nonce = nonce;
      txReq.gasLimit = gasLimit;
      if (legacy || (!fee.maxFeePerGas && !cliMaxFee)) {
        // Legacy gasPrice mode fallback
        const gasPrice = fee.gasPrice && fee.gasPrice.gt(0) ? fee.gasPrice : ethers.utils.parseUnits('60', 'gwei');
        txReq.gasPrice = gasPrice;
      } else {
        // EIP-1559
        txReq.type = 2;
        txReq.maxPriorityFeePerGas = maxPriorityFeePerGas;
        txReq.maxFeePerGas = maxFeePerGas;
      }
      console.log(`agent ${ag.id}: approving ${symbol} for ${key} (${spender}) to ${ethers.utils.formatUnits(amountWei, decimals)} ${symbol} ...`);
      console.log(JSON.stringify({ agentId: ag.id, nonce, gasLimit: gasLimit.toString(), maxPriorityFeePerGas: txReq.maxPriorityFeePerGas?.toString(), maxFeePerGas: txReq.maxFeePerGas?.toString(), gasPrice: txReq.gasPrice?.toString() }));
      const tx = await wallet.sendTransaction(txReq);
      console.log(`agent ${ag.id}: sent ${tx.hash}`);
      if (!noWait) {
        console.log(`agent ${ag.id}: waiting for ${confirmations} confirmation(s) (timeout ${timeoutSec}s) … https://polygonscan.com/tx/${tx.hash}`);
        try {
          const rc = await wallet.provider!.waitForTransaction(tx.hash, confirmations, timeoutSec * 1000);
          if (rc && rc.blockNumber) {
            console.log(`agent ${ag.id}: confirmed in block ${rc.blockNumber}`);
          } else {
            console.log(`agent ${ag.id}: wait completed but receipt missing block number`);
          }
        } catch (err) {
          console.error(`agent ${ag.id}: waitForTransaction timed out after ${timeoutSec}s — check polygonscan: https://polygonscan.com/tx/${tx.hash}`);
          // fall through to read current allowance
        }
      }
      const after = await usdc.allowance(owner, spender);
      console.log(JSON.stringify({ agentId: ag.id, spenderKey: key, spender, newAllowance: after.toString() }));
    }
  }
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exit(1);
});
