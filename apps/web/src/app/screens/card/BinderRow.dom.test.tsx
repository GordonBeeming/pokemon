// @vitest-environment happy-dom
import type { SlotRef } from '@pokedex/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from '../../api/keys';
import { ToastProvider } from '../../ui/Toast';
import { BinderRow, type BinderRowMatch } from './BinderRow';

// BinderRow's "Binder is full" state links to the binder via <Link>, which needs a
// real router context to resolve `to`/`params` — a minimal one-route tree stood up
// just for this test (not the full app router), with the index route's component
// closurizing over whatever content this render call actually wants to mount.
function createTestRouter(content: () => ReactElement) {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const binderRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/binders/$binderId',
    component: () => null,
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: content,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([indexRoute, binderRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
}

let container: HTMLDivElement, root: Root, queryClient: QueryClient;
let placeCalls: unknown[];

function slot(page: number, row: number, column: number): SlotRef {
  return {
    slotId: `p${page}:${row}:${column}`,
    page,
    row,
    col: column,
    pocketIndex: row * 4 + column,
  };
}

const VERSION_SUMMARY = {
  id: 'v1',
  binderId: 'binder-1',
  versionNumber: 1,
  status: 'active' as const,
  layout: { kind: '3x3' as const, rows: 3 as const, columns: 3 as const },
  revision: 7,
  pageCount: 1,
};

function stubFetch(): void {
  placeCalls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init?: RequestInit) => {
      if (input === '/api/binders')
        return Promise.resolve(
          jsonResponse({
            ok: true,
            binders: [
              {
                id: 'binder-1',
                name: 'National Pokedex',
                activeVersionId: 'v1',
                latestVersionId: 'v1',
                updatedAt: '2026-01-01T00:00:00.000Z',
              },
            ],
          }),
        );
      if (input.startsWith('/api/binders/versions/v1'))
        return Promise.resolve(
          jsonResponse({
            ok: true,
            binder: { version: VERSION_SUMMARY, pages: [], nextPage: null },
          }),
        );
      if (input.startsWith('/api/cards/') && input.endsWith('/place')) {
        placeCalls.push(typeof init?.body === 'string' ? JSON.parse(init.body) : undefined);
        return Promise.resolve(
          jsonResponse({ ok: true, version: { ...VERSION_SUMMARY, revision: 8 }, pages: [] }),
        );
      }
      throw new Error(`unexpected fetch: ${input}`);
    }),
  );
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function renderRow(props: {
  looseCopies: number;
  match: BinderRowMatch;
  autoExpand?: boolean;
}): Promise<void> {
  const router = createTestRouter(() => (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <BinderRow
          cardId="card-1"
          looseCopies={props.looseCopies}
          match={props.match}
          autoExpand={props.autoExpand ?? false}
        />
      </ToastProvider>
    </QueryClientProvider>
  ));
  return step(() => root.render(<RouterProvider router={router} />));
}

const NO_TARGETS = {
  exactTargets: [],
  pokemonTargets: [],
  setTargets: [],
  groupTargets: [],
  placed: [],
};

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Pre-seeded so `confirmPlace`'s activeVersionId lookup never races the mocked
  // fetch's own microtask resolution — the "does place send the right body" tests
  // aren't testing useBinders' own loading behaviour.
  queryClient.setQueryData(queryKeys.binders.list(), [
    {
      id: 'binder-1',
      name: 'National Pokedex',
      activeVersionId: 'v1',
      latestVersionId: 'v1',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ]);
  stubFetch();
});
afterEach(async () => {
  await step(() => root.unmount());
  container.remove();
  queryClient.clear();
  vi.unstubAllGlobals();
});

describe('BinderRow', () => {
  it('shows "Not in binder" when there is no open target, but still offers "Add at the end" when there is room', async () => {
    await renderRow({
      looseCopies: 0,
      autoExpand: true,
      match: {
        binderId: 'binder-1',
        name: 'Collections',
        ...NO_TARGETS,
        nextTarget: null,
        endDestination: slot(3, 1, 1),
      },
    });
    expect(container.textContent).toContain('Not in binder');
    expect(container.textContent).toContain('Add at the end');
    const action = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Add a copy and place'),
    );
    expect(action).toBeDefined();

    await step(() => action?.click());
    await flushUntil(() => placeCalls.length > 0);
    expect(placeCalls).toEqual([
      { binderId: 'binder-1', slotId: 'p3:1:1', addCopy: true, expectedRevision: 7 },
    ]);
  });

  it('shows "Not in binder" and "Binder is full" with a link when there is no target and no room', async () => {
    await renderRow({
      looseCopies: 0,
      autoExpand: true,
      match: {
        binderId: 'binder-1',
        name: 'Collections',
        ...NO_TARGETS,
        nextTarget: null,
        endDestination: null,
      },
    });
    expect(container.textContent).toContain('Not in binder');
    expect(container.textContent).toContain('Binder is full');
    expect(container.querySelector('a[href*="binder-1"]')).not.toBeNull();
    expect(
      Array.from(container.querySelectorAll('button')).some((button) =>
        button.textContent?.includes('Place'),
      ),
    ).toBe(false);
  });

  it('shows "Target waiting" and places into the waiting target ahead of the end destination', async () => {
    await renderRow({
      looseCopies: 0,
      autoExpand: true,
      match: {
        binderId: 'binder-1',
        name: 'National Pokedex',
        exactTargets: [],
        pokemonTargets: [slot(2, 0, 0)],
        setTargets: [],
        groupTargets: [],
        placed: [],
        nextTarget: slot(2, 0, 0),
        endDestination: slot(5, 0, 0),
      },
    });
    expect(container.textContent).toContain('Target waiting');
    expect(container.textContent).toContain('Place in the waiting target');
    const action = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Add a copy and place'),
    );
    await step(() => action?.click());
    await flushUntil(() => placeCalls.length > 0);
    expect(placeCalls).toEqual([
      { binderId: 'binder-1', slotId: 'p2:0:0', addCopy: true, expectedRevision: 7 },
    ]);
  });

  it('offers "Add a copy and place" when every owned copy is already placed (no loose copy to place)', async () => {
    await renderRow({
      looseCopies: 0,
      autoExpand: true,
      match: {
        binderId: 'binder-1',
        name: 'National Pokedex',
        exactTargets: [],
        pokemonTargets: [slot(4, 0, 0)],
        setTargets: [],
        groupTargets: [],
        placed: [slot(1, 0, 0)],
        nextTarget: slot(4, 0, 0),
        endDestination: slot(6, 0, 0),
      },
    });
    const action = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Add a copy and place',
    );
    expect(action).toBeDefined();
    await step(() => action?.click());
    await flushUntil(() => placeCalls.length > 0);
    expect(placeCalls).toEqual([
      { binderId: 'binder-1', slotId: 'p4:0:0', addCopy: true, expectedRevision: 7 },
    ]);
  });

  it('shows "In binder" and offers "Place here" (no addCopy) when a loose copy exists and a second target is open', async () => {
    await renderRow({
      looseCopies: 1,
      autoExpand: true,
      match: {
        binderId: 'binder-1',
        name: 'National Pokedex',
        exactTargets: [],
        pokemonTargets: [slot(4, 0, 0)],
        setTargets: [],
        groupTargets: [],
        placed: [slot(1, 0, 0)],
        nextTarget: slot(4, 0, 0),
        endDestination: slot(6, 0, 0),
      },
    });
    expect(container.textContent).toContain('In binder');
    const action = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Place here',
    );
    expect(action).toBeDefined();
    await step(() => action?.click());
    await flushUntil(() => placeCalls.length > 0);
    expect(placeCalls).toEqual([
      { binderId: 'binder-1', slotId: 'p4:0:0', addCopy: false, expectedRevision: 7 },
    ]);
  });
});

async function step(action: () => unknown): Promise<void> {
  await act(async () => {
    await action();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function flushUntil(predicate: () => boolean, attempts = 50): Promise<void> {
  for (let i = 0; i < attempts && !predicate(); i++) {
    await step(() => new Promise((resolve) => setTimeout(resolve, 0)));
  }
  if (!predicate()) throw new Error('flushUntil: condition never became true');
}
