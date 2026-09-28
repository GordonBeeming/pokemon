// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../../ui/Toast';
import { AssignOwnedSection } from './AssignOwnedSection';

let container: HTMLDivElement;
let root: Root;
let requests: Array<{ method: string; path: string; body: unknown }>;

async function step(action: () => unknown): Promise<void> {
  await act(async () => {
    action();
    await Promise.resolve();
  });
}

async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

function stubAssignOwned(count: number): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      requests.push({ method: init?.method ?? 'GET', path, body });
      const locations = Array.from({ length: count }, (_, index) => ({
        page: 0,
        row: 0,
        column: index,
      }));
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, count, locations }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
}

async function render(node: ReactNode): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await step(() =>
    root.render(
      <QueryClientProvider client={client}>
        <ToastProvider>{node}</ToastProvider>
      </QueryClientProvider>,
    ),
  );
  await flush();
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  requests = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await step(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('AssignOwnedSection', () => {
  it('previews the count, then marks them with apply:true at the current revision', async () => {
    stubAssignOwned(3);
    await render(<AssignOwnedSection versionId="bv_1" revision={7} editable />);

    expect(requests[0]).toEqual({
      method: 'POST',
      path: '/api/binders/versions/bv_1/assign-owned',
      body: { expectedRevision: 7, apply: false },
    });
    expect(container.textContent).toContain('3 pockets hold a card you own.');

    const button = [...container.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === 'Mark 3 as placed',
    );
    if (!button) throw new Error('no "Mark 3 as placed" button');
    await step(() => button.click());
    await flush();

    const applied = requests.find(
      (request) => (request.body as { apply?: boolean } | undefined)?.apply === true,
    );
    expect(applied?.body).toEqual({ expectedRevision: 7, apply: true });
    expect(document.body.textContent).toContain('Marked 3 cards as placed.');
  });

  it('hides itself when nothing needs marking', async () => {
    stubAssignOwned(0);
    await render(<AssignOwnedSection versionId="bv_1" revision={7} editable />);
    expect(requests).toHaveLength(1);
    expect(container.textContent).toBe('');
  });
});
