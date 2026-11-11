import { readFileSync } from 'node:fs';
import path from 'node:path';

import { RuntimeConfigSchema, type RuntimeConfig } from '../../src/config/schema';
import { flattenRuntimeConfig } from '../../src/config/normalize';

let cachedBase: RuntimeConfig | undefined;

function clone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

function loadBase(): RuntimeConfig {
  if (cachedBase) return clone(cachedBase);
  const file = path.join(process.cwd(), 'config', 'runtime.json');
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const normalized = flattenRuntimeConfig(raw);
  cachedBase = RuntimeConfigSchema.parse(normalized);
  return clone(cachedBase);
}

function isPlainObject(v: unknown): v is Record<string, any> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function mergeDeep(target: any, source: any): any {
  if (!isPlainObject(source)) return source;
  const out: any = isPlainObject(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(source)) {
    const existing = (out as any)[k];
    if (isPlainObject(v)) {
      (out as any)[k] = mergeDeep(existing ?? {}, v);
    } else {
      (out as any)[k] = v;
    }
  }
  return out;
}

/**
 * Build a RuntimeConfig for tests by starting from config/runtime.json
 * and deep-merging provided overrides.
 */
export function testRuntime(overrides: any = {}): RuntimeConfig {
  const base = loadBase();
  const merged = mergeDeep(base, overrides);
  // Validate the final structure to catch mistakes early in tests
  return RuntimeConfigSchema.parse(merged);
}
