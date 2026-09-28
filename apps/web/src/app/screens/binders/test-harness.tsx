import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { act, useState, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { vi } from 'vitest';
import { RouteLiveRegionProvider, ToastProvider } from '../../ui/Toast';

// A minimal fake of the worker for DOM tests: enough of /api to render a binder,
// with every request recorded and each route's answer overridable per test.

export interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
}

type Handler = (request: RecordedRequest) => { status: number; body: unknown } | undefined;

export interface FakeSlot {
  row: number;
  column: number;
  entryKind: 'empty' | 'pokemon';
  pokemonNumber: number | null;
}

export interface FakeBinder {
  id: string;
  name: string;
  versionId: string;
  rows: number;
  columns: number;
  pages: FakeSlot[][];
  revision: number;
  /** A draft copy of the active version, when one is in progress. */
  draft?: { versionId: string; revision: number };
}

export function makeBinder(id: string, name: string, pageCount = 2): FakeBinder {
  const pages = Array.from({ length: pageCount }, (_unused, pageIndex) =>
    Array.from({ length: 9 }, (_cell, index): FakeSlot => {
      const number = pageIndex * 9 + index + 1;
      // Leave the last pocket on each page empty so moves have somewhere to land.
      return index === 8
        ? { row: 2, column: 2, entryKind: 'empty', pokemonNumber: null }
        : {
            row: Math.floor(index / 3),
            column: index % 3,
            entryKind: 'pokemon',
            pokemonNumber: number,
          };
    }),
  );
  return { id, name, versionId: `${id}_v1`, rows: 3, columns: 3, pages, revision: 3 };
}

function version(binder: FakeBinder, draft = false) {
  return {
    id: draft && binder.draft ? binder.draft.versionId : binder.versionId,
    binderId: binder.id,
    versionNumber: 1,
    status: draft ? 'draft' : 'active',
    layout: { kind: '3x3', rows: 3, columns: 3 },
    revision: draft && binder.draft ? binder.draft.revision : binder.revision,
    pageCount: binder.pages.length,
    capacity: binder.pages.length * 9,
  };
}

function page(binder: FakeBinder, index: number) {
  return {
    id: `${binder.id}_page${index}`,
    position: index,
    kind: 'slots',
    label: null,
    slots: (binder.pages[index] ?? []).map((slot) => ({
      pageId: `${binder.id}_page${index}`,
      row: slot.row,
      column: slot.column,
      cardId: null,
      entryKind: slot.entryKind,
      label: null,
      pokemonNumber: slot.pokemonNumber,
      assignedCardId: null,
      startsNewPage: false,
    })),
  };
}

export class FakeServer {
  requests: RecordedRequest[] = [];
  overrides: Handler[] = [];
  constructor(public binders: FakeBinder[]) {}

  handle(request: RecordedRequest): { status: number; body: unknown } {
    for (const override of this.overrides) {
      const answer = override(request);
      if (answer) return answer;
    }
    const url = new URL(request.path, 'http://test');
    const path = url.pathname;
    if (path === '/api/binders')
      return {
        status: 200,
        body: {
          ok: true,
          binders: this.binders.map((binder) => ({
            id: binder.id,
            name: binder.name,
            activeVersionId: binder.versionId,
            latestVersionId: binder.draft?.versionId ?? binder.versionId,
            updatedAt: '2026-09-28T00:00:00.000Z',
            peekColumns: 0,
            showFrame: true,
          })),
        },
      };
    if (path === '/api/binders/inactive-targets')
      return { status: 200, body: { ok: true, targets: [] } };
    if (path === '/api/settings') return { status: 200, body: { ok: true, framePalette: {} } };
    const match = /^\/api\/binders\/versions\/([^/]+)(\/.*)?$/u.exec(path);
    const binder = match
      ? this.binders.find(
          (item) => item.versionId === match[1] || item.draft?.versionId === match[1],
        )
      : undefined;
    const isDraft = binder !== undefined && match !== null && binder.draft?.versionId === match[1];
    if (binder && match) {
      if ((match[2] ?? '') === '' && request.method === 'DELETE') {
        if (!isDraft)
          return { status: 409, body: { ok: false, error: 'binder_version_not_draft' } };
        binder.draft = undefined;
        return { status: 200, body: { ok: true } };
      }
      const rest = match[2] ?? '';
      if (rest === '' && request.method === 'GET') {
        const index = Number(url.searchParams.get('page') ?? '0');
        if (index >= binder.pages.length)
          return { status: 400, body: { ok: false, error: 'binder_page_window_invalid' } };
        return {
          status: 200,
          body: {
            ok: true,
            binder: {
              version: version(binder, isDraft),
              pages: [page(binder, index)],
              nextPage: index + 1 < binder.pages.length ? index + 1 : null,
            },
          },
        };
      }
      if (rest === '/planner-summary')
        return {
          status: 200,
          body: {
            ok: true,
            summary: {
              pageIds: binder.pages.map((_p, index) => `${binder.id}_page${index}`),
              revision: binder.revision,
              targets: 16,
              placed: 0,
              reservedSleeves: 0,
              reservedPages: 0,
              generatedPadding: 0,
              available: 2,
              capacity: binder.pages.length * 9,
              pageSize: 9,
            },
          },
        };
      if (rest === '/bookmarks') return { status: 200, body: { ok: true, bookmarks: [] } };
      if (rest === '/swap' && request.method === 'POST') {
        binder.revision += 1;
        return {
          status: 200,
          body: { ok: true, binder: { version: version(binder), pages: [page(binder, 0)] } },
        };
      }
    }
    return { status: 404, body: { ok: false, error: 'not_found' } };
  }

  install(): void {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string, init?: RequestInit) => {
        const request: RecordedRequest = {
          method: init?.method ?? 'GET',
          path: input,
          body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
        };
        this.requests.push(request);
        const answer = this.handle(request);
        return Promise.resolve(
          new Response(JSON.stringify(answer.body), {
            status: answer.status,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }),
    );
  }

  count(method: string, suffix: string): number {
    return this.requests.filter(
      (request) => request.method === method && request.path.endsWith(suffix),
    ).length;
  }
}

export async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

export async function waitFor(predicate: () => boolean, attempts = 60): Promise<void> {
  for (let i = 0; i < attempts && !predicate(); i++) await flush(1);
  if (!predicate()) throw new Error('waitFor: condition never became true');
}

/** Renders `children` inside the providers the binder screens need (query client,
 * toasts, the route live region, which reads router state). */
export async function renderWithProviders(
  container: HTMLElement,
  render: () => ReactNode,
): Promise<{ root: Root; queryClient: QueryClient }> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Shell(): ReactElement {
    return (
      <ToastProvider>
        <RouteLiveRegionProvider>
          <Outlet />
        </RouteLiveRegionProvider>
      </ToastProvider>
    );
  }
  const rootRoute = createRootRoute({ component: Shell });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <>{render()}</>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await router.load();
  });
  await flush();
  return { root, queryClient };
}

/** Holds a binder screen's search params in React state, the way the route would. */
export function useControlledState<T>(initial: T): [T, (next: T) => void] {
  const [value, setValue] = useState(initial);
  return [value, setValue];
}
