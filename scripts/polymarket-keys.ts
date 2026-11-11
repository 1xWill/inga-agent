#!/usr/bin/env tsx
/**
 * Derive Polymarket L2 API credentials (key/secret/passphrase) using your L1 private key
 * and print .env entries for production usage.
 *
 * Requirements:
 * - env POLY_L1_PRIVATE_KEY (or POLY_PRIVATE_KEY/PRIVATE_KEY) set to a Polygon EOA private key (0x...)
 * - optional POLY_CHAIN_ID (default 137) and POLY_CLOB_HOST (default https://clob.polymarket.com)
 * - optional POLY_SIGNATURE_TYPE: 0 = browser wallet (metamask/coinbase), 1 = Magic/Email login (default 0)
 *
 * Usage:
 *   npm run polymarket:keys                # reads env, derives L2 keys, prints .env block to stdout
 *   POLY_L1_PRIVATE_KEY=0xabc... npm run polymarket:keys
 *   POLY_CHAIN_ID=137 POLY_CLOB_HOST=https://clob.polymarket.com npm run polymarket:keys
 *
 * Never commit the printed secrets. Store them locally (e.g., .env.local) and rotate regularly.
 */
import 'dotenv/config';
import { ClobClient } from '@polymarket/clob-client';
import { Wallet, ethers } from 'ethers';

function getArgFlag(name: string): boolean {
  const k = `--${name}`;
  return process.argv.includes(k);
}

function getArgValue(name: string): string | undefined {
  const k = `--${name}`;
  const idx = process.argv.indexOf(k);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return undefined;
}

async function main() {
  const host = process.env.POLY_CLOB_HOST || getArgValue('host') || 'https://clob.polymarket.com';
  const chainId = Number(process.env.POLY_CHAIN_ID || getArgValue('chainId') || 137);
  const sigType = Number(process.env.POLY_SIGNATURE_TYPE || getArgValue('sigType') || 0);

  const priv =
    process.env.POLY_L1_PRIVATE_KEY ||
    process.env.POLY_PRIVATE_KEY ||
    process.env.PRIVATE_KEY ||
    getArgValue('privateKey');

  if (!priv) {
    console.error('ERROR: Missing L1 private key. Provide POLY_L1_PRIVATE_KEY (or --privateKey).');
    process.exit(1);
  }

  let signer: Wallet;
  try {
    signer = new Wallet(priv);
  } catch (err) {
    console.error('ERROR: Invalid private key provided. Expected 0x-prefixed hex.');
    process.exit(1);
  }

  const address = await signer.getAddress();

  // Create or derive L2 API key (key/secret/passphrase) using official client
  const clob = new ClobClient(host, chainId, signer);

  try {
    const creds = await clob.createOrDeriveApiKey();

    // Optional funder address is typically your profile wallet; expose for convenience
    const funder = process.env.POLY_FUNDER_ADDRESS || getArgValue('funder') || address;

    // Print safe-to-paste .env block
    const lines = [
      '# Polymarket — production credentials',
      `POLY_CHAIN_ID=${chainId}`,
      `POLY_CLOB_HOST=${host}`,
      `POLY_L1_PRIVATE_KEY=${signer.privateKey}`,
      `POLY_ADDRESS=${address}`,
      `POLY_SIGNATURE_TYPE=${sigType}`,
      `POLY_FUNDER_ADDRESS=${funder}`,
      `POLY_API_KEY=${creds.key}`,
      `POLY_API_SECRET=${creds.secret}`,
      `POLY_API_PASSPHRASE=${creds.passphrase}`,
    ];

    // Default: print to stdout. If --write=path provided, append to that file.
    const writePath = getArgValue('write');
    if (writePath) {
      const fs = await import('node:fs/promises');
      await fs.appendFile(writePath, `\n${lines.join('\n')}\n`);
      console.log(`Wrote Polymarket env entries to ${writePath}`);
    } else {
      console.log('\n' + lines.join('\n') + '\n');
    }
  } catch (err: any) {
    // Surface likely causes: network, rate limits, geo-blocking, or invalid signing headers
    const msg = err?.message || String(err);
    console.error('Failed to derive Polymarket API keys.');
    console.error('Cause:', msg);
    if (/429|rate/i.test(msg)) {
      console.error('Hint: You may be rate limited by Polymarket CLOB. Retry later.');
    }
    process.exit(1);
  }
}

main();

