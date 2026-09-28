// @vitest-environment happy-dom
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
import { ToastProvider } from '../ui/Toast';
import { Home } from './Home';

let container: HTMLDivElement, root: Root, queryClient: QueryClient;

const DASHBOARD_FIXTURE = {
  ok: true,
  collection: { uniqueOwned: 1, totalQuantity: 1, noted: 0 },
  pricing: { priced: 0, missing: 1, estimateAud: 0 },
  binderCount: 1,
  binders: [{ id: 'binder-1', name: 'Kanto', targets: 4, placed: 2, percent: 50 }],
  activeShortages: [],
  activePokemonShortages: [],
  activeShortageCount: 1,
  activeShortageEntries: 1,
  stillToFind: [
    {
      kind: 'pokemon',
      label: '#0025 Pikachu',
      cardId: null,
      pokemonNumber: 25,
      missing: 1,
      binderId: 'binder-1',
      binderName: 'Kanto',
    },
  ],
  cards: [
    {
      id: 'card-1',
      name: 'Bulbasaur',
      language: 'en',
      category: 'pokemon',
      setId: 'base',
      setName: 'Base Set',
      number: '44',
      imageLowUrl: null,
      imageHighUrl: null,
      pokedexNumber: 1,
      collection: null,
      price: {
        amountAud: null,
        nativeAmount: null,
        nativeCurrency: null,
        source: null,
        sourceCapturedAt: null,
        fxDate: null,
      },
      frameType: 'grass',
      setCode: 'BS',
      rarityKey: 'C',
    },
  ],
};

const CARD_DETAIL_FIXTURE = {
  ok: true,
  card: {
    id: 'card-1',
    name: 'Bulbasaur',
    language: 'en',
    category: 'pokemon',
    setId: 'base',
    setName: 'Base Set',
    number: '44',
    imageLowUrl: null,
    supertype: null,
    subtype: null,
    species: 'Bulbasaur',
    rarity: 'Common',
    artist: null,
    imageHighUrl: null,
    source: { provider: 'tcgdex', sourceId: 'base-44', updatedAt: '2026-01-01T00:00:00.000Z' },
    notes: null,
    pokedexNumber: 1,
    collection: {
      cardId: 'card-1',
      quantity: 1,
      notes: null,
      revision: 1,
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    price: {
      amountAud: null,
      nativeAmount: null,
      nativeCurrency: null,
      source: null,
      sourceCapturedAt: null,
      fxDate: null,
    },
    frameType: 'grass',
    setCode: 'BS',
    rarityKey: 'C',
  },
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      if (input === '/api/dashboard') return Promise.resolve(jsonResponse(DASHBOARD_FIXTURE));
      if (input.startsWith('/api/catalogue/card-1'))
        return Promise.resolve(jsonResponse(CARD_DETAIL_FIXTURE));
      if (input === '/api/cards/card-1/binder-matches')
        return Promise.resolve(jsonResponse({ ok: true, binders: [] }));
      throw new Error(`unexpected fetch: ${input}`);
    }),
  );
}

function stubDesktop(matches: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      media: query,
      matches,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  );
}

// Home reads/writes the open card through props (the real index route owns the
// `?card=` search param — see routes/index.tsx), so this harness mirrors that
// split: a tiny stateful wrapper stands in for the route, and a real router
// provides the `Link`/`useNavigate` targets Home renders (catalogue, a binder, the
// standalone card route).
function createTestRouter(content: () => ReactElement) {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: content,
  });
  const catalogueRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/catalogue',
    component: () => <div>catalogue-page</div>,
  });
  const cardRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/card/$cardId',
    component: () => <div>standalone-card-page</div>,
  });
  const binderRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/binders/$binderId',
    component: () => <div>binder-page</div>,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([indexRoute, catalogueRoute, cardRoute, binderRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
}

function renderHome(props: {
  card?: string;
  onOpenCard: (cardId: string) => void;
  onCloseCard: () => void;
}): Promise<void> {
  const router = createTestRouter(() => (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <Home
          search={{ card: props.card }}
          onOpenCard={props.onOpenCard}
          onCloseCard={props.onCloseCard}
        />
      </ToastProvider>
    </QueryClientProvider>
  ));
  return step(() => root.render(<RouterProvider router={router} />));
}

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

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  stubFetch();
});
afterEach(async () => {
  await step(() => root.unmount());
  container.remove();
  queryClient.clear();
  vi.unstubAllGlobals();
});

describe('Home', () => {
  it('renders the binder-progress and still-to-find column from the dashboard response', async () => {
    stubDesktop(true);
    await renderHome({ onOpenCard: vi.fn(), onCloseCard: vi.fn() });
    await flushUntil(() => container.textContent?.includes('Kanto') === true);

    expect(container.textContent).toContain('2 of 4 placed');
    expect(container.textContent).toContain('#0025 Pikachu');
    expect(container.querySelector('.progress-fill')?.getAttribute('style')).toContain('50%');
  });

  it("desktop: clicking a shelf card asks the route to open it (Home's own URL state), not the catalogue", async () => {
    stubDesktop(true);
    const onOpenCard = vi.fn();
    await renderHome({ onOpenCard, onCloseCard: vi.fn() });
    await flushUntil(() => container.textContent?.includes('Bulbasaur') === true);

    const shelfButton = container.querySelector('.shelf-cards button');
    expect(shelfButton).not.toBeNull();
    await step(() => (shelfButton as HTMLButtonElement).click());

    expect(onOpenCard).toHaveBeenCalledWith('card-1');
  });

  it('desktop: opens the card inspector in a side panel when the route reports ?card=', async () => {
    stubDesktop(true);
    await renderHome({ card: 'card-1', onOpenCard: vi.fn(), onCloseCard: vi.fn() });
    // The overlay (react-aria's ModalOverlay) renders through a portal to
    // document.body rather than inside `container`, so this looks at the whole
    // document instead of scoping to the render root the way the other assertions do.
    await flushUntil(
      () => document.querySelector('.side-panel')?.textContent?.includes('Bulbasaur') === true,
    );

    expect(document.querySelector('.side-panel')).not.toBeNull();
  });

  it('desktop: the open card inspector offers "View all {species}", which closes the panel', async () => {
    stubDesktop(true);
    const onCloseCard = vi.fn();
    await renderHome({ card: 'card-1', onOpenCard: vi.fn(), onCloseCard });
    await flushUntil(
      () => document.querySelector('.side-panel')?.textContent?.includes('Bulbasaur') === true,
    );

    const viewAll = Array.from(document.querySelectorAll('a')).find((link) =>
      link.textContent?.includes('View all'),
    );
    expect(viewAll).toBeDefined();
    expect(viewAll?.textContent).toContain('Bulbasaur');
    await step(() => viewAll?.click());

    expect(onCloseCard).toHaveBeenCalled();
  });

  it('phone: clicking a shelf card navigates to the standalone card route instead of opening a panel', async () => {
    stubDesktop(false);
    await renderHome({ onOpenCard: vi.fn(), onCloseCard: vi.fn() });
    await flushUntil(() => container.textContent?.includes('Bulbasaur') === true);

    const shelfButton = container.querySelector('.shelf-cards button');
    expect(shelfButton).not.toBeNull();
    await step(() => (shelfButton as HTMLButtonElement).click());
    await flushUntil(() => container.textContent?.includes('standalone-card-page'));

    expect(document.querySelector('.side-panel')).toBeNull();
  });
});
