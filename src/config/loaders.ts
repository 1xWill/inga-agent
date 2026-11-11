import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Wallet } from 'ethers';

import { ZodError } from 'zod';

import {
  AgentDefinition,
  AgentDefinitionInput,
  AgentsConfig,
  AgentsConfigInput,
  AgentsConfigInputSchema,
  AgentsConfigSchema,
  AgentDefaults,
  RuntimeConfig,
  RuntimeConfigSchema
} from './schema';
import { flattenRuntimeConfig } from './normalize';

const DEFAULT_BASE_DIR = process.cwd();
const AGENTS_FILENAME = 'config/agents.json';
const RUNTIME_FILENAME = 'config/runtime.json';

export class ConfigError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'ConfigError';
  }
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  try {
    const data = await readFile(filePath, 'utf8');
    return JSON.parse(data) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ConfigError(`Config file not found: ${filePath}`, error);
    }

    if (error instanceof SyntaxError) {
      throw new ConfigError(`Invalid JSON in config file: ${filePath}`, error);
    }

    throw new ConfigError(`Failed to read config file: ${filePath}`, error);
  }
}

function mergeAgentDefaults(agent: AgentDefinitionInput, defaults?: AgentDefaults): AgentDefinitionInput {
  if (!defaults) return agent;
  const mergedResearch = defaults.research
    ? { ...defaults.research, ...agent.research }
    : agent.research;
  const mergedExecution = defaults.execution
    ? { ...defaults.execution, ...agent.execution }
    : agent.execution;
  const mergedChartStyle =
    defaults.chartStyle || agent.chartStyle
      ? { ...(defaults.chartStyle ?? {}), ...(agent.chartStyle ?? {}) }
      : undefined;
  return {
    ...defaults,
    ...agent,
    research: mergedResearch,
    execution: mergedExecution,
    chartStyle: mergedChartStyle,
  };
}

export async function loadAgentsConfig(baseDir: string = DEFAULT_BASE_DIR): Promise<AgentsConfig> {
  const filePath = path.join(baseDir, AGENTS_FILENAME);
  const raw = await readJsonFile<unknown>(filePath);

  try {
    const parsedInput: AgentsConfigInput = AgentsConfigInputSchema.parse(raw);
    const mergedAgents = parsedInput.agents.map((agent) => mergeAgentDefaults(agent, parsedInput.defaults));
    const normalized = { ...parsedInput, agents: mergedAgents };
    return AgentsConfigSchema.parse(normalized);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new ConfigError(`agents.json validation failed: ${error.message}`, error);
    }

    throw new ConfigError('Unexpected error validating agents config', error);
  }
}

export async function loadRuntimeConfig(baseDir: string = DEFAULT_BASE_DIR): Promise<RuntimeConfig> {
  const filePath = path.join(baseDir, RUNTIME_FILENAME);
  const raw = await readJsonFile<unknown>(filePath);

  try {
    const normalized = flattenRuntimeConfig(raw);
    return RuntimeConfigSchema.parse(normalized);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new ConfigError(`runtime.json validation failed: ${error.message}`, error);
    }

    throw new ConfigError('Unexpected error validating runtime config', error);
  }
}

export function resolveAgentCredentials(
  agent: AgentDefinition,
  env: Record<string, string | undefined> = process.env
) {
  const walletKey = env[agent.walletPrivateKeyEnv];
  let walletAddress = env[agent.walletAddressEnv];

  const missing: string[] = [];
  if (!walletKey) missing.push(agent.walletPrivateKeyEnv);

  // Derive wallet address from private key when not provided explicitly
  if (walletKey && !walletAddress) {
    try {
      const pk = walletKey.startsWith('0x') ? walletKey : `0x${walletKey}`;
      const w = new Wallet(pk);
      walletAddress = w.address;
    } catch (e) {
      // If derivation fails, keep original requirement for explicit address
      if (!walletAddress) missing.push(agent.walletAddressEnv);
    }
  } else if (!walletAddress) {
    missing.push(agent.walletAddressEnv);
  }

  if (missing.length > 0) {
    throw new ConfigError(
      `Missing required environment variables for agent ${agent.id}: ${missing.join(', ')}`
    );
  }

  return {
    walletPrivateKey: walletKey,
    walletAddress
  };
}

export type AgentCredentials = ReturnType<typeof resolveAgentCredentials>;
