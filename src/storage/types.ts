// Async repository interface: Promisified view of the existing sync AgentRepository
import type { AgentRepository as SyncAgentRepository } from '../agent/repository';

type Promisified<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : T[K];
};

export type AgentRepositoryAsync = Promisified<SyncAgentRepository>;

