import { config as loadEnv } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Load environment variables from .env.local first (if present) and then .env.
 * This mirrors Next.js convention and keeps CLI utilities aligned with the app.
 */
export function loadEnvFiles(baseDir: string = process.cwd()): void {
  const envLocal = resolve(baseDir, '.env.local');
  const envDefault = resolve(baseDir, '.env');
  if (existsSync(envLocal)) {
    loadEnv({ path: envLocal });
  }
  if (existsSync(envDefault)) {
    loadEnv({ path: envDefault, override: false });
  }
}
