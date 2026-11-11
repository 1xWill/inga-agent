import type { PolymarketClient, MarketSummary } from '../../clients/polymarket';
import type { RuntimeConfig } from '../../config/schema';
import type { AgentRepository } from '../repository';
import type { AgentRepositoryAsync } from '../../storage/types';
import { selectMarketsForEvaluation } from './market';
import { prepareEventContext, PreparedEvent } from './event_prep';

export interface SharedDiscoveryData {
  selectedMarkets: MarketSummary[];
  preferredMarketIds: string[];
  preparedByMarketId: Record<string, PreparedEvent>;
  ts: number;
}

let cache: SharedDiscoveryData | undefined;
let building: Promise<SharedDiscoveryData> | undefined;

export function getSharedDiscovery(runtime: RuntimeConfig): SharedDiscoveryData | undefined {
  const intervalMinutes = Math.max(1 / 60, runtime.polling.marketFetchIntervalMinutes);
  const intervalMs = intervalMinutes * 60 * 1000;
  if (!cache) return undefined;
  const age = Date.now() - cache.ts;
  if (age > intervalMs) {
    cache = undefined;
    return undefined;
  }
  return cache;
}

export function setSharedDiscovery(data: SharedDiscoveryData) {
  cache = data;
}

export async function ensureSharedDiscovery({
  client,
  runtime,
  repo,
  log,
}: {
  client: PolymarketClient;
  runtime: RuntimeConfig;
  repo: AgentRepository | AgentRepositoryAsync;
  log: (msg: string, data?: unknown) => void;
}): Promise<SharedDiscoveryData> {
  const existing = getSharedDiscovery(runtime);
  if (existing) return existing;
  if (building) return building;
  building = buildSharedDiscovery({ client, runtime, repo, log })
    .finally(() => {
      building = undefined;
    });
  return building;
}

export async function buildSharedDiscovery({
  client,
  runtime,
  repo,
  log,
}: {
  client: PolymarketClient;
  runtime: RuntimeConfig;
  repo: AgentRepository | AgentRepositoryAsync;
  log: (msg: string, data?: unknown) => void;
}): Promise<SharedDiscoveryData> {
  const agentId = '__shared__';
  const refillMaxTries = Math.max(
    0,
    Number((runtime.polling as any)?.marketRefillMaxTries ?? 0),
  );

  let markets: MarketSummary[] = [];
  const preferredIds = new Set<string>();
  const preparedByMarketId: Record<string, PreparedEvent> = {};

  const ensurePrepared = async (ms: MarketSummary[]) => {
    for (const m of ms) {
      if (!m?.id || preparedByMarketId[m.id]) continue;
      const prepared = await prepareEventContext({
        market: m,
        polymarket: client,
        runtime,
        repo,
        log,
      });
      if (prepared) preparedByMarketId[m.id] = prepared;
    }
  };

  const countSurvivors = () =>
    Object.values(preparedByMarketId).reduce(
      (acc, p) => acc + (p.includedQuick?.length ?? 0),
      0,
    );

  // Initial discovery
  {
    const r = await selectMarketsForEvaluation({ client, runtime, repo, agentId });
    markets = r.markets;
    for (const id of r.preferredMarketIds ?? []) preferredIds.add(id);
    await ensurePrepared(markets);
  }

  // Refill (fetch another batch) only if the entire batch dies at prefilter.
  let survivors = countSurvivors();
  for (let attempt = 0; attempt < refillMaxTries && survivors === 0; attempt++) {
    log('Shared discovery refill', { attempt: attempt + 1, maxTries: refillMaxTries });
    const r = await selectMarketsForEvaluation({ client, runtime, repo, agentId });
    const existing = new Set(markets.map((m) => m.id));
    const added: MarketSummary[] = [];
    for (const m of r.markets) {
      if (!m?.id || existing.has(m.id)) continue;
      existing.add(m.id);
      markets.push(m);
      added.push(m);
    }
    for (const id of r.preferredMarketIds ?? []) preferredIds.add(id);
    await ensurePrepared(added);
    survivors = countSurvivors();
    log('Shared discovery refill result', {
      attempt: attempt + 1,
      added: added.length,
      survivors,
    });
    if (added.length === 0) break;
  }

  const data: SharedDiscoveryData = {
    selectedMarkets: markets,
    preferredMarketIds: Array.from(preferredIds),
    preparedByMarketId,
    ts: Date.now(),
  };
  setSharedDiscovery(data);
  return data;
}
