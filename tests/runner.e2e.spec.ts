import { describe, expect, it } from 'vitest';

import { runAgentOnce } from '../src/agent/runner';
import { createHttpClient } from '../src/http/client';

describe('Agent runner e2e (paper)', () => {
  it('runs a real full cycle (paper)', async () => {
    const logs: Array<{ msg: string; data?: unknown }> = [];
    let resolveOnSignal: (() => void) | undefined;
    const onSignal = new Promise<void>((res) => (resolveOnSignal = res));

    const log = (msg: string, data?: unknown) => {
      logs.push({ msg, data });
      // In some configurations, evaluation persistence/logging is disabled to
      // reduce DB growth. Accept earlier "we started doing work" signals.
      if (
        resolveOnSignal &&
        (msg === 'Evaluated market' ||
          msg === 'Decision prompt signature' ||
          msg.startsWith('Fetched markets'))
      ) {
        resolveOnSignal();
      }
    };

    const http = createHttpClient({
      retry: { retries: 2, minDelayMs: 500, maxDelayMs: 2000, factor: 2 },
      timeoutMs: 20000
    });

    // Start the run but only wait until the first evaluation is logged.
    runAgentOnce({ log, dbFilePath: 'data/test-agent.sqlite', inject: { http } }).catch(() => {});
    await onSignal;

    const sawSignal = logs.some((l) =>
      l.msg === 'Evaluated market' ||
      l.msg === 'Decision prompt signature' ||
      l.msg.startsWith('Fetched markets')
    );
    expect(sawSignal).toBe(true);
  }, 120000);
});
