// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, useState, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { catalogueCardViewSchema } from '@pokedex/shared';
import { catalogueSearch } from '../../routes/search-params';
import { useCatalogueSearch } from './catalogue';
import { useIncrementCollection } from './collection';
import { useInfiniteWindow } from '../../ui/useInfiniteWindow';
let root: Root, container: HTMLDivElement, client: QueryClient;
async function step(action: () => unknown) {
  await act(async () => {
    action();
    await Promise.resolve();
  });
}
async function flush() {
  for (let i = 0; i < 12; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
}
function card(id: string) {
  return catalogueCardViewSchema.parse({
    id,
    name: id,
    language: 'en',
    category: 'pokemon',
    setId: 'base',
    setName: 'Base',
    number: id,
    imageLowUrl: null,
    imageHighUrl: null,
    collection: null,
    price: {
      amountAud: null,
      nativeAmount: null,
      nativeCurrency: null,
      source: null,
      sourceCapturedAt: null,
      fxDate: null,
    },
  });
}
function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
function Probe(): ReactElement {
  const query = useCatalogueSearch(catalogueSearch.parse({}));
  const add = useIncrementCollection('a');
  return (
    <>
      <span data-cards>
        {query.data?.cards.map((c) => `${c.id}:${c.collection?.quantity ?? 0}`).join(',')}
      </span>
      <span data-error>{String(query.isFetchNextPageError)}</span>
      <button onClick={() => void query.fetchNextPage({ cancelRefetch: false })}>More</button>
      <button onClick={() => add.mutate({ delta: 1 })}>Own</button>
    </>
  );
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await step(() => root.unmount());
  client.clear();
  container.remove();
  vi.unstubAllGlobals();
});
async function render(view: ReactElement) {
  await step(() => root.render(<QueryClientProvider client={client}>{view}</QueryClientProvider>));
  await flush();
}
function button(text: string) {
  const button = [...container.querySelectorAll('button')].find((b) => b.textContent === text);
  if (!button) throw new Error(`Missing ${text}`);
  return button;
}
it('appends cursor pages without duplicates and patches ownership across loaded pages', async () => {
  const requests: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string) => {
      requests.push(path);
      if (path.includes('/increment'))
        return Promise.resolve(
          response({
            ok: true,
            replayed: false,
            state: {
              cardId: 'a',
              quantity: 1,
              notes: null,
              revision: 1,
              updatedAt: '2026-11-19T00:00:00.000Z',
            },
          }),
        );
      const next = new URL(path, 'http://test').searchParams.get('cursor');
      return Promise.resolve(
        response({
          ok: true,
          total: 3,
          cards: next ? [card('b'), card('c')] : [card('a'), card('b')],
          cursor: next ? null : 'next',
        }),
      );
    }),
  );
  const printings = ['catalogue', 'search', 'printings', 7, 40];
  const picker = ['catalogue', 'search', 'picker', 'test'];
  client.setQueryData(printings, { cards: [card('a')], total: 1 });
  client.setQueryData(picker, { pages: [{ cards: [card('a')], total: 1 }], pageParams: [0] });
  await render(<Probe />);
  expect(container.querySelector('[data-cards]')?.textContent).toBe('a:0,b:0');
  await step(() => button('More').click());
  await flush();
  expect(container.querySelector('[data-cards]')?.textContent).toBe('a:0,b:0,c:0');
  expect(requests[1]).toContain('cursor=next');
  expect(requests[1]).toContain('limit=48');
  await step(() => button('Own').click());
  await flush();
  expect(container.querySelector('[data-cards]')?.textContent).toBe('a:1,b:0,c:0');
  expect(
    client.getQueryData<{ cards: Array<{ collection: { quantity: number } | null }> }>(printings)
      ?.cards[0]?.collection?.quantity,
  ).toBe(1);
  expect(
    client.getQueryData<{
      pages: Array<{ cards: Array<{ collection: { quantity: number } | null }> }>;
    }>(picker)?.pages[0]?.cards[0]?.collection?.quantity,
  ).toBe(1);
});
it('retains previous cards after a next-page error and retries the same cursor', async () => {
  let fail = true;
  const requests: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string) => {
      requests.push(path);
      const next = new URL(path, 'http://test').searchParams.get('cursor');
      return Promise.resolve(
        next && fail
          ? response({ ok: false, error: 'internal_error' }, 500)
          : response({
              ok: true,
              total: 3,
              cards: next ? [card('c')] : [card('a'), card('b')],
              cursor: next ? null : 'next',
            }),
      );
    }),
  );
  await render(<Probe />);
  await step(() => button('More').click());
  await flush();
  expect(container.querySelector('[data-cards]')?.textContent).toBe('a:0,b:0');
  expect(container.querySelector('[data-error]')?.textContent).toBe('true');
  fail = false;
  await step(() => button('More').click());
  await flush();
  expect(container.querySelector('[data-cards]')?.textContent).toBe('a:0,b:0,c:0');
  expect(requests.filter((u) => u.includes('cursor=next'))).toHaveLength(2);
});
it('restores client-list items after opening a card and resets a new filter', async () => {
  const items = Array.from({ length: 120 }, (_, i) => i);
  function Window() {
    const [scope, setScope] = useState('a');
    const rows = useInfiniteWindow(items, scope);
    return (
      <>
        <span data-count>{rows.items.length}</span>
        <button onClick={rows.loadMore}>More</button>
        <button onClick={() => setScope('b')}>Filter B</button>
        <button onClick={() => setScope('a')}>Filter A</button>
      </>
    );
  }
  await render(<Window />);
  expect(container.querySelector('[data-count]')?.textContent).toBe('48');
  await step(() => button('More').click());
  await flush();
  expect(container.querySelector('[data-count]')?.textContent).toBe('96');
  await step(() => button('Filter B').click());
  expect(container.querySelector('[data-count]')?.textContent).toBe('48');
  await step(() => button('Filter A').click());
  expect(container.querySelector('[data-count]')?.textContent).toBe('96');
  await render(<span>Card view</span>);
  await render(<Window />);
  expect(container.querySelector('[data-count]')?.textContent).toBe('96');
});
it('rebuilds cursors from the first page after an invalidation', async () => {
  let changed = false;
  const requests: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string) => {
      requests.push(path);
      const cursor = new URL(path, 'http://test').searchParams.get('cursor');
      return Promise.resolve(
        response({
          ok: true,
          total: changed ? 4 : 3,
          cards: cursor
            ? [card('b'), card('c')]
            : changed
              ? [card('new'), card('a')]
              : [card('a'), card('b')],
          cursor: cursor ? null : changed ? 'fresh' : 'next',
        }),
      );
    }),
  );
  await render(<Probe />);
  await step(() => button('More').click());
  await flush();
  changed = true;
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['catalogue', 'search'] });
  });
  await flush();
  expect(requests.at(-1)).toContain('cursor=fresh');
  expect(container.querySelector('[data-cards]')?.textContent).toBe('new:0,a:0,b:0,c:0');
});
it('cancels an old filter request and never appends it to the new results', async () => {
  let complete: (value: Response) => void = () => {
    throw new Error('No request to complete');
  };
  const delayed = new Promise<Response>((resolve) => {
    complete = resolve;
  });
  let signal: AbortSignal | null | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string, init?: RequestInit) => {
      const p = new URL(path, 'http://test').searchParams;
      if (p.get('q') === 'other')
        return Promise.resolve(
          response({ ok: true, total: 1, cards: [card('other')], cursor: null }),
        );
      if (p.has('cursor')) {
        signal = init?.signal;
        return delayed;
      }
      return Promise.resolve(
        response({ ok: true, total: 3, cards: [card('a'), card('b')], cursor: 'next' }),
      );
    }),
  );
  function Filters() {
    const [q, setQ] = useState('');
    const result = useCatalogueSearch(catalogueSearch.parse({ q }));
    return (
      <>
        <span data-filtered>{result.data?.cards.map((c) => c.id).join(',')}</span>
        <button onClick={() => void result.fetchNextPage({ cancelRefetch: false })}>More</button>
        <button onClick={() => setQ('other')}>Other</button>
      </>
    );
  }
  await render(<Filters />);
  await step(() => button('More').click());
  await step(() => button('Other').click());
  await flush();
  expect(signal?.aborted).toBe(true);
  expect(container.querySelector('[data-filtered]')?.textContent).toBe('other');
  complete(response({ ok: true, total: 3, cards: [card('old')], cursor: null }));
  await flush();
  expect(container.querySelector('[data-filtered]')?.textContent).toBe('other');
});
