// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFramePalette } from './settings';

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

let container: HTMLDivElement, root: Root;
let queryClient: QueryClient;
let calls: RecordedCall[];

/** Every call answers with the same palette, whatever the request — good enough to
 * assert on method/url/body without modelling the worker's actual state. */
function stubFetch(framePalette: Record<string, string>): void {
  vi.stubGlobal(
    'fetch',
    // apiFetch always calls fetch(path, init) with a plain string path, never a
    // Request or URL object, so `string` is the honest type here even though the
    // real fetch signature is broader.
    vi.fn((input: string, init?: RequestInit) => {
      calls.push({
        url: input,
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, framePalette }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
}

let latest: ReturnType<typeof useFramePalette> | undefined;
function Harness(): null {
  latest = useFramePalette();
  return null;
}

async function flushUntil(predicate: () => boolean, attempts = 50): Promise<void> {
  for (let i = 0; i < attempts && !predicate(); i++) {
    await step(() => new Promise((resolve) => setTimeout(resolve, 0)));
  }
  if (!predicate()) throw new Error('flushUntil: condition never became true');
}

async function renderHarness(): Promise<void> {
  await step(() =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <Harness />
      </QueryClientProvider>,
    ),
  );
  // Let the initial GET /api/settings query resolve and re-render.
  await flushUntil(() => latest !== undefined && !latest.isLoading);
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  calls = [];
  latest = undefined;
});
afterEach(async () => {
  await step(() => root.unmount());
  container.remove();
  queryClient.clear();
  vi.unstubAllGlobals();
});

describe('useFramePalette', () => {
  it('reads the overrides from GET /api/settings and merges them over the defaults', async () => {
    stubFetch({ grass: '#123456' });
    await renderHarness();
    expect(calls).toEqual([{ url: '/api/settings', method: 'GET', body: undefined }]);
    expect(latest?.overrides).toEqual({ grass: '#123456' });
    expect(latest?.palette.grass).toBe('#123456');
  });

  it('setOverride PUTs the full palette with the new key merged in', async () => {
    stubFetch({ grass: '#123456' });
    await renderHarness();
    await step(async () => {
      await latest?.setOverride('fire', '#abcdef');
    });
    const put = calls.find((call) => call.method === 'PUT');
    expect(put).toEqual({
      url: '/api/settings/frame-palette',
      method: 'PUT',
      body: { palette: { grass: '#123456', fire: '#abcdef' } },
    });
  });

  it('resetOverride PUTs the current overrides with that key removed, not a DELETE with a query param', async () => {
    stubFetch({ grass: '#123456', fire: '#abcdef' });
    await renderHarness();
    await step(async () => {
      await latest?.resetOverride('fire');
    });
    const put = calls.find((call) => call.method === 'PUT');
    expect(put).toEqual({
      url: '/api/settings/frame-palette',
      method: 'PUT',
      body: { palette: { grass: '#123456' } },
    });
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
  });

  it('resetAll DELETEs with no query string', async () => {
    stubFetch({ grass: '#123456' });
    await renderHarness();
    await step(async () => {
      await latest?.resetAll();
    });
    const del = calls.find((call) => call.method === 'DELETE');
    expect(del?.url).toBe('/api/settings/frame-palette');
  });
});

async function step(action: () => unknown): Promise<void> {
  await act(async () => {
    await action();
  });
}
