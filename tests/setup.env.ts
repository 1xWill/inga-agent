import { config as loadEnv } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Load from .env.local then .env to support local overrides
const root = process.cwd();
const envLocal = resolve(root, '.env.local');
const envDefault = resolve(root, '.env');

if (existsSync(envLocal)) {
  loadEnv({ path: envLocal });
}
if (existsSync(envDefault)) {
  loadEnv({ path: envDefault, override: false });
}

// Fail fast if required credentials are missing for live tests
const missing: string[] = [];
if (!process.env.OPENROUTER_API_KEY) missing.push('OPENROUTER_API_KEY');

if (missing.length > 0) {
  throw new Error(`Missing required environment variables for live tests: ${missing.join(', ')}`);
}
