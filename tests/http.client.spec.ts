import { setTimeout as sleep } from 'node:timers/promises';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';

import { createHttpClient, HttpError } from '../src/http/client';

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});

const httpClient = createHttpClient({
  retry: {
    retries: 2,
    minDelayMs: 5,
    maxDelayMs: 20,
    factor: 2
  },
  timeoutMs: 50
});

describe('createHttpClient', () => {
  it('returns parsed JSON for successful requests', async () => {
    server.use(
      http.get('https://api.example.com/resource', () => HttpResponse.json({ ok: true }))
    );

    const response = await httpClient<{ ok: boolean }>('https://api.example.com/resource');
    expect(response.ok).toBe(true);
  });

  it('retries failed responses and eventually succeeds', async () => {
    let calls = 0;
    server.use(
      http.get('https://api.example.com/unstable', () => {
        calls += 1;
        if (calls < 2) {
          return new HttpResponse(JSON.stringify({ error: 'boom' }), {
            status: 500,
            headers: {
              'content-type': 'application/json'
            }
          });
        }

        return HttpResponse.json({ ok: true });
      })
    );

    const response = await httpClient<{ ok: boolean }>('https://api.example.com/unstable');
    expect(response.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it('throws HttpError for non-success responses after retries exhausted', async () => {
    server.use(
      http.get('https://api.example.com/fail', () =>
        new HttpResponse(JSON.stringify({ error: 'bad gateway' }), {
          status: 502,
          headers: {
            'content-type': 'application/json'
          }
        })
      )
    );

    await expect(httpClient('https://api.example.com/fail')).rejects.toBeInstanceOf(HttpError);
  });

  it('throws timeout error when request exceeds configured timeout', async () => {
    server.use(
      http.get('https://slow.example.com/wait', async () => {
        await sleep(100);
        return HttpResponse.json({ ok: true });
      })
    );

    await expect(httpClient('https://slow.example.com/wait')).rejects.toThrow(/timed out/);
  });

  it('returns text when parseJson=false', async () => {
    server.use(
      http.get('https://api.example.com/text', () => new HttpResponse('plain', { status: 200 }))
    );

    const response = await httpClient<string>('https://api.example.com/text', { parseJson: false });
    expect(response).toBe('plain');
  });
});
