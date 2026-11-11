import type { AgentRepository } from '../agent/repository';
import type { AgentRepositoryAsync } from './types';

// Wraps the existing synchronous AgentRepository to present an async interface
export function asAsyncRepository(repo: AgentRepository): AgentRepositoryAsync {
  const target: any = repo;
  const proxy = new Proxy(target, {
    get(obj, prop, receiver) {
      const val = Reflect.get(obj, prop, receiver);
      if (typeof val === 'function') {
        return (...args: any[]) => Promise.resolve(val.apply(obj, args));
      }
      return val;
    },
  });
  return proxy as AgentRepositoryAsync;
}

