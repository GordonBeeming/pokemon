import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

interface WorkerEvent {
  data?: { type?: string };
  request?: { method: string; mode: string; url: string };
  waitUntil?: (promise: Promise<unknown>) => void;
  respondWith?: (promise: Promise<unknown>) => void;
}

describe('service worker cache policy', () => {
  function harness(cached: Response | undefined) {
    const handlers = new Map<string, (event: WorkerEvent) => void>();
    const fetch = vi.fn(() => Promise.resolve(new Response('network')));
    const deleteCache = vi.fn(() => Promise.resolve(true));
    const put = vi
      .fn<(path: string, response: Response) => Promise<void>>()
      .mockResolvedValue(undefined);
    const cache = { addAll: vi.fn(() => Promise.resolve()), put };
    const caches = {
      match: vi.fn(() => Promise.resolve(cached)),
      open: vi.fn(() => Promise.resolve(cache)),
      keys: vi.fn(() => Promise.resolve(['pokedex-shell-v1', 'unrelated'])),
      delete: deleteCache,
    };
    const self = {
      location: { origin: 'https://pokedex.test' },
      clients: { claim: vi.fn(() => Promise.resolve()) },
      skipWaiting: vi.fn(() => Promise.resolve()),
      addEventListener: (name: string, handler: (event: WorkerEvent) => void) =>
        handlers.set(name, handler),
    };
    runInNewContext(readFileSync('public/sw.js', 'utf8'), {
      self,
      caches,
      fetch,
      URL,
      Promise,
    });
    return { handlers, fetch, caches, deleteCache, put };
  }

  it('returns a cache hit without starting a network request', async () => {
    const cached = new Response('cached');
    const { handlers, fetch } = harness(cached);
    let response: Promise<unknown> | undefined;
    handlers.get('fetch')?.({
      request: {
        method: 'GET',
        mode: 'same-origin',
        url: 'https://pokedex.test/index.html',
      },
      respondWith: (promise) => {
        response = promise;
      },
    });
    await expect(response).resolves.toBe(cached);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refreshes navigations so a deployment cannot strand old asset hashes', async () => {
    const { handlers, fetch, put } = harness(new Response('old shell'));
    let response: Promise<unknown> | undefined;
    handlers.get('fetch')?.({
      request: { method: 'GET', mode: 'navigate', url: 'https://pokedex.test/' },
      respondWith: (promise) => {
        response = promise;
      },
    });
    await expect(response).resolves.toBeInstanceOf(Response);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledTimes(2);
    expect(put.mock.calls.map(([path]) => path)).toEqual(['/', '/index.html']);
  });

  it('never intercepts private API or art requests', () => {
    const { handlers, fetch } = harness(undefined);
    let intercepted = false;
    handlers.get('fetch')?.({
      request: {
        method: 'GET',
        mode: 'same-origin',
        url: 'https://pokedex.test/api/art/card/low',
      },
      respondWith: () => {
        intercepted = true;
      },
    });
    expect(intercepted).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('purges Pokédex caches after authentication loss', async () => {
    const { handlers, deleteCache } = harness(undefined);
    let completed: Promise<unknown> | undefined;
    handlers.get('message')?.({
      data: { type: 'PURGE_PRIVATE_CACHES' },
      waitUntil: (promise) => {
        completed = promise;
      },
    });
    await completed;
    expect(deleteCache).toHaveBeenCalledWith('pokedex-shell-v1');
    expect(deleteCache).not.toHaveBeenCalledWith('unrelated');
  });
});
