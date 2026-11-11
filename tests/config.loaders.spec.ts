import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ConfigError,
  loadAgentsConfig,
  loadRuntimeConfig,
  resolveAgentCredentials,
} from "../src/config";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "inga-config-"));
  await mkdir(path.join(tempDir, "config"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

const agentsFixture = {
  agents: [
    {
      id: "agent_alpha",
      label: "Agent Alpha",
      modelProvider: "openrouter",
      model: "openai/gpt-4.1",
      walletPrivateKeyEnv: "AGENT_ALPHA_WALLET_KEY",
      walletAddressEnv: "AGENT_ALPHA_WALLET_ADDRESS",
      paperTrading: true,
      enabled: true,
      research: {
        quickProfile: "quick",
        deepProfile: "deep",
      },
      execution: {
        maxOpenPositions: 4,
        allocation: {
          type: "percentage_of_available",
          value: 0.2,
        },
      },
    },
  ],
};

const runtimeFixture = {
  polling: {
    marketFetchLimit: 5,
    monitorMaxBuyPerTick: 2,
    marketFetchIntervalMinutes: 1,
    positionMonitorIntervalMinutes: 0.5,
  },
  cooldowns: {
    postDecisionMinutes: 240,
    discoveryMinutes: 60,
  },
  marketData: {
    sort: "trending",
    includeOrderBooks: true,
    includeOutcomePrices: true,
  },
  researchProfiles: {
    quick: {
      openrouter: {
        maxTokens: 400,
        temperature: 0.3,
        timeoutMs: 10000,
      },
    },
    deep: {
      openrouter: {
        maxTokens: 1200,
        temperature: 0.2,
        timeoutMs: 30000,
      },
    },
  },
  tradeEvaluation: {
    decisionSchema: {
      fields: ["marketId", "trade"],
    },
    targetSelection: {
      minConfidence: 0.5,
      maxTargets: 3,
    },
  },
  execution: {
    strategy: "immediate",
    reserveBalance: true,
    defaultSpend: {
      mode: "percentage_of_available",
      value: 0.1,
    },
    priceRefresh: {
      enabled: true,
      maxAgeMinutes: 20 / 60,
    },
  },
  portfolio: {
    initialBalance: 15000,
    baseCurrency: "USDC",
  },
  http: {
    retry: {
      retries: 2,
      minDelayMs: 100,
      maxDelayMs: 500,
      factor: 2,
    },
    timeoutMs: 7000,
  },
  logging: {
    level: "info",
  },
};

describe("config loaders", () => {
  it("parses agents config", async () => {
    await writeFile(
      path.join(tempDir, "config", "agents.json"),
      JSON.stringify(agentsFixture),
    );
    const config = await loadAgentsConfig(tempDir);
    expect(config.agents[0].id).toBe("agent_alpha");
  });

  it("parses runtime config", async () => {
    await writeFile(
      path.join(tempDir, "config", "runtime.json"),
      JSON.stringify(runtimeFixture),
    );
    const config = await loadRuntimeConfig(tempDir);
    expect(config.http.retry.retries).toBe(2);
  });

  it("applies agent defaults before validation", async () => {
    await writeFile(
      path.join(tempDir, "config", "agents.json"),
      JSON.stringify({
        defaults: {
          modelProvider: "openrouter",
          research: {
            quickProfile: "quick",
            deepProfile: "deep",
          },
          execution: {
            maxOpenPositions: 2,
            allocation: {
              type: "percentage_of_available",
              value: 0.1,
            },
          },
        },
        agents: [
          {
            id: "agent_defaulted",
            label: "Defaulted",
            model: "openai/gpt-4.1",
            walletPrivateKeyEnv: "AGENT_DEFAULTED_WALLET_KEY",
            walletAddressEnv: "AGENT_DEFAULTED_WALLET_ADDRESS",
          },
        ],
      }),
    );
    const config = await loadAgentsConfig(tempDir);
    expect(config.agents[0].modelProvider).toBe("openrouter");
    expect(config.agents[0].research.quickProfile).toBe("quick");
  });

  it("throws descriptive error when env vars missing", async () => {
    await writeFile(
      path.join(tempDir, "config", "agents.json"),
      JSON.stringify(agentsFixture),
    );
    const { agents } = await loadAgentsConfig(tempDir);
    expect(() => resolveAgentCredentials(agents[0], {})).toThrow(
      /Missing required environment variables/,
    );
  });

  it("resolves agent credentials when env vars present", async () => {
    await writeFile(
      path.join(tempDir, "config", "agents.json"),
      JSON.stringify(agentsFixture),
    );
    const { agents } = await loadAgentsConfig(tempDir);
    const credentials = resolveAgentCredentials(agents[0], {
      AGENT_ALPHA_WALLET_KEY: "wallet-key",
      AGENT_ALPHA_WALLET_ADDRESS: "wallet-address",
    });

    expect(credentials).toEqual({
      walletPrivateKey: "wallet-key",
      walletAddress: "wallet-address",
    });
  });

  it("wraps zod validation errors", async () => {
    await writeFile(
      path.join(tempDir, "config", "runtime.json"),
      JSON.stringify({}),
    );
    await expect(loadRuntimeConfig(tempDir)).rejects.toThrow(ConfigError);
  });
});
