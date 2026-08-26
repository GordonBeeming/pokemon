// @vitest-environment happy-dom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './app';
import { BinderView } from './binder-view';
import { CatalogueView } from './catalogue-view';
import { AUTH_LOST_EVENT } from './api';
import { DevicesView } from './ui';

const apiMocks = vi.hoisted(() => ({
  me: vi.fn(),
  dashboard: vi.fn(),
  sets: vi.fn(),
  species: vi.fn(),
  tokens: vi.fn(),
  pair: vi.fn(),
  revokeToken: vi.fn(),
  search: vi.fn(),
  card: vi.fn(),
  binders: vi.fn(),
  binder: vi.fn(),
  binderShortages: vi.fn(),
  resolveCards: vi.fn(),
  nationalPokedex: vi.fn(),
  addCardsToBinder: vi.fn(),
  startCatalogueSync: vi.fn(),
  nationalPokedexPreviews: vi.fn(),
  catalogueSyncStatus: vi.fn(),
  resolveNationalRepresentatives: vi.fn(),
  setNationalRepresentative: vi.fn(),
}));

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  return { ...actual, api: apiMocks };
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  if (!resolve) throw new Error('Deferred promise did not initialise.');
  return { promise, resolve };
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function waitFor(check: () => boolean, detail = ''): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (check()) return;
    await settle();
  }
  throw new Error(`Timed out waiting for the frontend state. ${detail}`);
}

describe('async frontend announcements', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    location.hash = '#devices';
    container = document.createElement('div');
    document.body.replaceChildren(container);
    root = createRoot(container);
    Object.values(apiMocks).forEach((mock) => mock.mockReset());
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  it('announces route loading and completion with the loaded count', async () => {
    const tokens = deferred<Awaited<ReturnType<typeof apiMocks.tokens>>>();
    apiMocks.me.mockResolvedValue({ user: { id: 'owner' } });
    apiMocks.tokens.mockReturnValue(tokens.promise);

    act(() => root.render(<App />));
    await waitFor(
      () =>
        Array.from(container.querySelectorAll('[role="status"]')).some(
          (element) => element.textContent === 'Loading Devices.',
        ),
      `Rendered text: ${container.textContent ?? ''}`,
    );
    const liveStatus = Array.from(container.querySelectorAll('[role="status"]')).find(
      (element) => element.textContent === 'Loading Devices.',
    );
    expect(liveStatus?.textContent).toContain('Loading Devices.');
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();

    tokens.resolve([]);
    await settle();

    expect(liveStatus?.textContent).toContain('0 paired devices loaded.');
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it('replaces failed route loading with an announced retry state', async () => {
    apiMocks.me.mockResolvedValue({ user: { id: 'owner' } });
    apiMocks.tokens
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValueOnce([]);

    act(() => root.render(<App />));
    await waitFor(() => container.textContent?.includes('Devices could not load.') === true);

    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    const alerts = Array.from(container.querySelectorAll('[role="alert"]')).filter((element) =>
      element.textContent?.trim(),
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.textContent).toContain('Devices could not load.');
    expect(
      Array.from(container.querySelectorAll('[role="status"]')).some((element) =>
        element.textContent?.includes('Devices could not load.'),
      ),
    ).toBe(false);
    const retry = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Try again',
    );
    act(() => retry?.click());
    await waitFor(() => container.textContent?.includes('No scanner is paired.') === true);

    expect(apiMocks.tokens).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain('Devices could not load.');
    expect(container.textContent).not.toContain('The request could not be completed.');
  });

  it('returns to passkey login when an authenticated session is lost', async () => {
    apiMocks.me.mockResolvedValue({ user: { id: 'owner' } });
    apiMocks.tokens.mockResolvedValue([]);

    act(() => root.render(<App />));
    await waitFor(() => container.textContent?.includes('No scanner is paired.') === true);
    act(() => {
      dispatchEvent(new Event(AUTH_LOST_EVENT));
    });
    await waitFor(() => container.textContent?.includes('Open your collection.') === true);

    expect(container.textContent).toContain('Continue with passkey');
  });

  it('preserves the chosen set language when opening its catalogue', async () => {
    location.hash = '#sets';
    apiMocks.me.mockResolvedValue({ user: { id: 'owner' } });
    apiMocks.sets.mockResolvedValue([
      { setId: 'shared-set', setName: 'Shared set', language: 'fr', total: 10, owned: 0 },
    ]);
    apiMocks.search.mockResolvedValue({ ok: true, total: 0, cards: [], cursor: null });

    act(() => root.render(<App />));
    await waitFor(() => container.querySelector('.set-row') !== null);
    act(() => container.querySelector<HTMLButtonElement>('.set-row')?.click());
    await settle();

    const params = new URLSearchParams(location.hash.split('?', 2)[1] ?? '');
    expect(params.get('setId')).toBe('shared-set');
    expect(params.get('language')).toBe('fr');
  });

  it('searches with newly applied catalogue parameters after a mounted-route change', async () => {
    const firstSearch = deferred<{ ok: true; total: number; cards: []; cursor: null }>();
    const secondSearch = deferred<{ ok: true; total: number; cards: []; cursor: null }>();
    apiMocks.search
      .mockReturnValueOnce(firstSearch.promise)
      .mockReturnValueOnce(secondSearch.promise);
    const view = (params: URLSearchParams) => (
      <CatalogueView
        initialParams={params}
        refreshKey={0}
        indexing={false}
        indexingError={null}
        indexingResult={null}
        retryIndexing={() => undefined}
        onBackToNational={() => undefined}
        onBackToSets={() => undefined}
        onNotice={() => undefined}
      />
    );

    act(() => root.render(view(new URLSearchParams({ q: 'old', owned: 'true' }))));
    await waitFor(() => apiMocks.search.mock.calls.length === 1);
    await act(async () => {
      firstSearch.resolve({ ok: true, total: 0, cards: [], cursor: null });
      await firstSearch.promise;
    });
    act(() => root.render(view(new URLSearchParams({ q: 'new', owned: 'false' }))));
    await waitFor(() => apiMocks.search.mock.calls.length === 2);
    await act(async () => {
      secondSearch.resolve({ ok: true, total: 0, cards: [], cursor: null });
      await secondSearch.promise;
    });

    const params = apiMocks.search.mock.calls[1]?.[0] as URLSearchParams;
    expect(params.get('q')).toBe('new');
    expect(params.get('owned')).toBe('false');
  });

  it('reports clipboard rejection and leaves the visible code available', async () => {
    const copyFailed = vi.fn();
    const clipboard = { writeText: vi.fn().mockRejectedValue(new Error('clipboard denied')) };
    vi.stubGlobal('navigator', { ...navigator, clipboard });

    act(() => {
      root.render(
        <DevicesView
          tokens={[]}
          pairCode={{ ok: true, code: 'A1B2-C3D4', expiresAt: '2026-08-25T04:00:00Z' }}
          pending={false}
          pair={() => undefined}
          revoke={() => undefined}
          copied={() => undefined}
          copyFailed={copyFailed}
        />,
      );
    });
    const copy = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Copy code',
    );
    act(() => copy?.click());
    await settle();

    expect(clipboard.writeText).toHaveBeenCalledWith('A1B2-C3D4');
    expect(copyFailed).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('A1B2-C3D4');
  });

  it('uses numbered offsets for catalogue next and previous navigation', async () => {
    const firstPage = deferred<{ ok: true; total: number; cards: []; cursor: string }>();
    const secondPage = deferred<{ ok: true; total: number; cards: []; cursor: null }>();
    const previousPage = deferred<{ ok: true; total: number; cards: []; cursor: string }>();
    apiMocks.search
      .mockReturnValueOnce(firstPage.promise)
      .mockReturnValueOnce(secondPage.promise)
      .mockReturnValueOnce(previousPage.promise);

    act(() =>
      root.render(
        <CatalogueView
          initialParams={new URLSearchParams()}
          refreshKey={0}
          indexing={false}
          indexingError={null}
          indexingResult={null}
          retryIndexing={() => undefined}
          onBackToNational={() => undefined}
          onBackToSets={() => undefined}
          onNotice={() => undefined}
        />,
      ),
    );
    await waitFor(() => apiMocks.search.mock.calls.length === 1);
    const first = apiMocks.search.mock.calls[0]?.[0] as URLSearchParams;
    expect(first.has('offset')).toBe(false);
    expect(first.has('cursor')).toBe(false);
    await act(async () => {
      firstPage.resolve({ ok: true, total: 100, cards: [], cursor: 'cursor-2' });
      await firstPage.promise;
    });

    const next = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Next',
    );
    expect(next?.disabled).toBe(false);
    act(() => next?.click());
    await waitFor(() => apiMocks.search.mock.calls.length === 2);
    const second = apiMocks.search.mock.calls[1]?.[0] as URLSearchParams;
    expect(second.has('cursor')).toBe(false);
    expect(second.get('offset')).toBe('50');
    await act(async () => {
      secondPage.resolve({ ok: true, total: 100, cards: [], cursor: null });
      await secondPage.promise;
    });

    const previous = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Previous',
    );
    expect(previous?.disabled).toBe(false);
    act(() => previous?.click());
    await waitFor(() => apiMocks.search.mock.calls.length === 3);
    const third = apiMocks.search.mock.calls[2]?.[0] as URLSearchParams;
    expect(third.has('cursor')).toBe(false);
    expect(third.has('offset')).toBe(false);
    await act(async () => {
      previousPage.resolve({ ok: true, total: 100, cards: [], cursor: 'cursor-2' });
      await previousPage.promise;
    });
  });

  it('keeps editing arrows inside lightbox fields and restores card focus on Escape', async () => {
    const card = {
      id: 'card-1',
      name: 'Squirtle',
      language: 'en',
      category: 'pokemon',
      setId: 'sv03.5',
      setName: '151',
      number: '007',
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
    } as const;
    apiMocks.search.mockResolvedValue({ ok: true, total: 1, cards: [card], cursor: null });
    apiMocks.card.mockResolvedValue({
      ...card,
      supertype: 'Pokemon',
      subtype: 'Water',
      species: 'Squirtle',
      rarity: 'Common',
      artist: 'Artist',
      source: { provider: 'tcgdex', sourceId: 'sv03.5-007', updatedAt: '2026-08-25T00:00:00Z' },
      notes: null,
    });
    apiMocks.binders.mockResolvedValue([]);
    act(() =>
      root.render(
        <CatalogueView
          initialParams={new URLSearchParams()}
          refreshKey={0}
          indexing={false}
          indexingError={null}
          indexingResult={null}
          retryIndexing={() => undefined}
          onBackToNational={() => undefined}
          onBackToSets={() => undefined}
          onNotice={() => undefined}
        />,
      ),
    );
    await waitFor(() => container.querySelector('.card-row') !== null);
    const source = container.querySelector<HTMLButtonElement>('.card-row');
    act(() => source?.click());
    await waitFor(() => container.querySelector('[role="dialog"]') !== null);
    const notes = container.querySelector<HTMLTextAreaElement>('textarea');
    act(() => {
      notes?.focus();
      notes?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(apiMocks.card).toHaveBeenCalledTimes(1);
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    await settle();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(source);
  });

  it('adds an already-indexed full Pokédex without starting another catalogue workflow', async () => {
    const version = {
      id: 'version-1',
      binderId: 'binder-1',
      versionNumber: 1,
      status: 'active',
      layout: { kind: '3x3', rows: 3, columns: 3 },
      revision: 1,
      pageCount: 1,
    } as const;
    const pages = [
      {
        id: 'page-1',
        position: 0,
        slots: Array.from({ length: 9 }, (_value, index) => ({
          pageId: 'page-1',
          row: Math.floor(index / 3),
          column: index % 3,
          cardId: null,
        })),
      },
    ];
    const coverage = Array.from({ length: 1025 }, (_value, index) => ({
      number: index + 1,
      totalCards: 1,
      ownedCards: 0,
      types: [],
      representative: {
        cardId: `card-${index + 1}`,
        cardName: `Pokémon ${index + 1}`,
        setName: 'Set',
        number: String(index + 1),
        imageLowUrl: null,
        imageHighUrl: null,
        explicit: false,
      },
    }));
    apiMocks.binders.mockResolvedValue([
      {
        id: 'binder-1',
        name: 'National binder',
        activeVersionId: 'version-1',
        latestVersionId: 'version-1',
        updatedAt: '2026-08-25T00:00:00Z',
      },
    ]);
    apiMocks.binder.mockResolvedValue({ version, pages, nextPage: null });
    apiMocks.binderShortages.mockResolvedValue({ ok: true, shortages: [], nextOffset: null });
    apiMocks.resolveCards.mockResolvedValue([]);
    apiMocks.nationalPokedex.mockResolvedValue(coverage);
    apiMocks.addCardsToBinder.mockResolvedValue({
      added: 1025,
      binder: { version: { ...version, revision: 2, pageCount: 114 }, pages, nextPage: null },
    });

    act(() => root.render(<BinderView onNotice={() => undefined} />));
    await waitFor(() => container.querySelector('.binder-library-card') !== null);
    act(() => container.querySelector<HTMLButtonElement>('.binder-library-card')?.click());
    await waitFor(() => container.textContent?.includes('Add full Pokédex') === true);
    const add = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Add full Pokédex',
    );
    act(() => add?.click());
    await waitFor(() => apiMocks.addCardsToBinder.mock.calls.length === 1);

    expect(apiMocks.startCatalogueSync).not.toHaveBeenCalled();
    expect(apiMocks.addCardsToBinder.mock.calls[0]?.[1]).toEqual(
      Array.from({ length: 1025 }, (_value, index) => `card-${index + 1}`),
    );
  });
});
