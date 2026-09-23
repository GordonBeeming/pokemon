// @vitest-environment happy-dom

import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './app';
import { BinderView } from './binder-view';
import { CatalogueView } from './catalogue-view';
import { ApiError, AUTH_LOST_EVENT } from './api';
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
  plannerSummary: vi.fn(),
  binderDestinations: vi.fn(),
  previewFullPokedex: vi.fn(),
  assignmentCandidates: vi.fn(),
  resolveCards: vi.fn(),
  nationalPokedex: vi.fn(),
  addCardsToBinder: vi.fn(),
  setSlot: vi.fn(),
  insertEntries: vi.fn(),
  assignEntry: vi.fn(),
  removeEntry: vi.fn(),
  moveEntry: vi.fn(),
  setPageBreak: vi.fn(),
  swapSlots: vi.fn(),
  resizeBinder: vi.fn(),
  insertFullPokedex: vi.fn(),
  reservePage: vi.fn(),
  reorderPages: vi.fn(),
  deletePage: vi.fn(),
  arrangeBinder: vi.fn(),
  createBinder: vi.fn(),
  deleteBinder: vi.fn(),
  setCollection: vi.fn(),
  patchCollectionNotes: vi.fn(),
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

async function actAndSettle(action: () => void): Promise<void> {
  await act(async () => {
    action();
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

function binderFixture(
  slots: Array<{
    pageId: string;
    row: number;
    column: number;
    cardId: string | null;
    entryKind: 'empty' | 'reserved' | 'exact-card' | 'pokemon';
    label?: string | null;
    pokemonNumber?: number | null;
    assignedCardId?: string | null;
    startsNewPage?: boolean;
  }>,
  options: {
    status?: 'draft' | 'active' | 'archived';
    revision?: number;
    capacity?: number;
    columns?: number;
    rows?: number;
    pageCount?: number;
  } = {},
) {
  const columns = options.columns ?? 3;
  const rows = options.rows ?? 1;
  const version = {
    id: 'version-1',
    binderId: 'binder-1',
    versionNumber: 1,
    status: options.status ?? ('draft' as const),
    layout: { kind: 'custom' as const, rows, columns },
    revision: options.revision ?? 1,
    pageCount: options.pageCount ?? 1,
    capacity: options.capacity ?? slots.length,
  };
  const pages = [{ id: 'page-1', position: 0, kind: 'slots' as const, label: null, slots }];
  return {
    version,
    pages,
    result: { version, pages },
    response: { version, pages, nextPage: null },
  };
}

const testBinder = {
  id: 'binder-1',
  name: 'Test binder',
  activeVersionId: 'version-1',
  latestVersionId: 'version-1',
  updatedAt: '2026-08-26T00:00:00Z',
};

describe('async frontend announcements', () => {
  let container: HTMLDivElement;
  let root: Root;

  async function clickButton(name: string): Promise<void> {
    const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (item) => item.getAttribute('aria-label') === name || item.textContent?.trim() === name,
    );
    if (!button) throw new Error(`Button not found: ${name}`);
    await actAndSettle(() => {
      button.focus();
      button.click();
    });
  }
  async function manage(): Promise<void> {
    await clickButton('Manage binder');
  }
  async function closeEditor(): Promise<void> {
    await clickButton('Close pocket editor');
  }

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    location.hash = '#devices';
    container = document.createElement('div');
    document.body.replaceChildren(container);
    root = createRoot(container);
    Object.values(apiMocks).forEach((mock) => mock.mockReset());
    apiMocks.plannerSummary.mockResolvedValue({
      pageIds: ['page-1'],
      revision: 1,
      targets: 0,
      placed: 0,
      reservedSleeves: 0,
      reservedPages: 0,
      generatedPadding: 0,
      available: 9,
      capacity: 9,
      pageSize: 9,
    });
    apiMocks.previewFullPokedex.mockResolvedValue({
      currentCapacity: 9,
      requiredCapacity: 1035,
      additionalPockets: 1026,
      pageIncrement: 9,
      generatedPadding: 0,
    });
    apiMocks.assignmentCandidates.mockResolvedValue([]);
    apiMocks.binderDestinations.mockResolvedValue({
      versionId: 'version-1',
      revision: 1,
      capacity: 9,
      requiredCapacity: 9,
      matches: [],
      matchCount: 0,
      appendAt: { page: 0, row: 0, column: 0 },
    });
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
        onShowAll={() => undefined}
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
          onShowAll={() => undefined}
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

  it.each(['replace', 'append'] as const)(
    'asks for a binder destination before %s and links to the exact slot',
    async (mode) => {
      const card = {
        id: 'card-1',
        name: 'Squirtle',
        language: 'en',
        category: 'pokemon',
        setId: 'qa',
        setName: 'QA',
        number: '7',
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
        artist: null,
        source: { provider: 'manual', sourceId: 'card-1', updatedAt: '2026-08-25T00:00:00Z' },
        notes: null,
      });
      apiMocks.binders.mockResolvedValue([testBinder]);
      apiMocks.binderDestinations.mockResolvedValue({
        versionId: 'version-1',
        revision: 5,
        capacity: 1440,
        requiredCapacity: 1440,
        matchCount: 1,
        matches: [
          { page: 44, row: 0, column: 0, cardId: null, pokemonNumber: 7, assignedCardId: null },
        ],
        appendAt: { page: 44, row: 0, column: 1 },
      });
      apiMocks.setSlot.mockResolvedValue(binderFixture([]).result);
      await actAndSettle(() =>
        root.render(
          <CatalogueView
            refreshKey={0}
            initialParams={new URLSearchParams()}
            indexing={false}
            indexingError={null}
            indexingResult={null}
            retryIndexing={() => undefined}
            onBackToNational={() => undefined}
            onBackToSets={() => undefined}
            onShowAll={() => undefined}
            onNotice={() => undefined}
          />,
        ),
      );
      await waitFor(() => container.querySelector('[data-card-id="card-1"]') !== null);
      await actAndSettle(() =>
        container.querySelector<HTMLButtonElement>('[data-card-id="card-1"]')?.click(),
      );
      await waitFor(() => container.querySelector('.detail-binder') !== null);
      await clickButton('Add to selected binder');
      expect(apiMocks.setSlot).not.toHaveBeenCalled();
      expect(apiMocks.addCardsToBinder).not.toHaveBeenCalled();
      await clickButton(
        mode === 'replace'
          ? 'Replace target — page 45, pocket 1:1'
          : 'Add at end — page 45, pocket 1:2',
      );
      expect(apiMocks.setSlot).toHaveBeenCalledWith('version-1', {
        page: 44,
        row: 0,
        column: mode === 'replace' ? 0 : 1,
        cardId: 'card-1',
        expectedRevision: 5,
      });
      expect(
        container.querySelector<HTMLAnchorElement>('.detail-binder a')?.getAttribute('href'),
      ).toBe(`#binders?version=version-1&page=45&row=1&column=${mode === 'replace' ? 1 : 2}`);
      expect(apiMocks.setCollection).not.toHaveBeenCalled();
    },
  );

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
    apiMocks.setCollection.mockResolvedValue({
      cardId: 'card-1',
      quantity: 1,
      notes: null,
      revision: 1,
      updatedAt: '2026-08-26T00:00:00Z',
    });
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
          onShowAll={() => undefined}
          onNotice={() => undefined}
        />,
      ),
    );
    await waitFor(() => container.querySelector('.card-row') !== null);
    const source = container.querySelector<HTMLButtonElement>('.card-row');
    act(() => source?.click());
    await waitFor(() => container.querySelector('[role="dialog"]') !== null);
    expect(container.textContent).not.toContain('Save collection state');
    const quantity = container.querySelector<HTMLInputElement>('input[type="number"]');
    act(() => {
      if (!quantity) return;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        quantity,
        '1',
      );
      quantity.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 700));
    });
    expect(apiMocks.setCollection).toHaveBeenCalledOnce();
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

  it('keeps failed autosave drafts open and offers an inline retry', async () => {
    const card = {
      id: 'card-autosave',
      name: 'Ponyta',
      language: 'en',
      category: 'pokemon',
      setId: 'base',
      setName: 'Base Set',
      number: '60',
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
      subtype: 'Fire',
      species: 'Ponyta',
      rarity: 'Common',
      artist: 'Artist',
      source: { provider: 'tcgdex', sourceId: 'base-60', updatedAt: '2026-08-25T00:00:00Z' },
      notes: null,
    });
    apiMocks.binders.mockResolvedValue([]);
    apiMocks.setCollection
      .mockRejectedValueOnce(
        new ApiError('collection_revision_conflict', 'conflict', 409, null, null),
      )
      .mockRejectedValueOnce(new Error('still offline'))
      .mockResolvedValueOnce({
        cardId: 'card-autosave',
        quantity: 1,
        notes: null,
        revision: 1,
        updatedAt: '2026-08-26T00:00:00Z',
      });
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
          onShowAll={() => undefined}
          onNotice={() => undefined}
        />,
      ),
    );
    await waitFor(() => container.querySelector('.card-row') !== null);
    act(() => container.querySelector<HTMLButtonElement>('.card-row')?.click());
    await waitFor(() => container.querySelector('[role="dialog"]') !== null);

    vi.useFakeTimers();
    try {
      const quantity = container.querySelector<HTMLInputElement>('input[type="number"]');
      if (!quantity) throw new Error('Quantity input did not render.');
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
          quantity,
          '1',
        );
        quantity.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(700);
      });
      expect(container.textContent).toContain('Changes could not be saved.');
      expect(apiMocks.card).toHaveBeenCalledTimes(2);
      expect(container.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe('1');

      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(apiMocks.setCollection).toHaveBeenCalledTimes(2);
      expect(container.querySelector('[role="dialog"]')).not.toBeNull();

      const retry = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'Try again',
      );
      await act(async () => {
        retry?.click();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(apiMocks.setCollection).toHaveBeenCalledTimes(3);
      expect(container.textContent).toContain('Saved.');
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      });
      await act(async () => Promise.resolve());
      expect(container.querySelector('[role="dialog"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('restores page 45 and the selected pocket from a direct URL under StrictMode', async () => {
    location.hash = '#binders?version=version-1&page=45&row=1&column=1';
    const fixture = binderFixture(
      [
        {
          pageId: 'page-45',
          row: 0,
          column: 0,
          cardId: null,
          entryKind: 'pokemon',
          pokemonNumber: 7,
        },
      ],
      { capacity: 1440, pageCount: 120 },
    );
    const page = { ...fixture.pages[0], id: 'page-45', position: 44 };
    apiMocks.binders.mockResolvedValue([testBinder]);
    apiMocks.binder.mockResolvedValue({ ...fixture.response, pages: [page] });
    await actAndSettle(() =>
      root.render(
        <StrictMode>
          <BinderView onNotice={() => undefined} />
        </StrictMode>,
      ),
    );
    await waitFor(() => container.querySelector('[data-binder-slot="44-0-0"]') !== null);
    expect(container.querySelector<HTMLInputElement>('[aria-label="Go to page"]')?.value).toBe(
      '45',
    );
    expect(
      container.querySelector('[data-binder-slot="44-0-0"]')?.getAttribute('aria-pressed'),
    ).toBe('true');
    expect(container.querySelector('[role=dialog]')).toBeNull();
    expect(container.querySelector('[aria-label="Selected pocket tools"]')).not.toBeNull();
  });

  it('inserts selected Pokémon search results without a special full-Pokédex workflow or automatic growth', async () => {
    const initial = binderFixture(
      [{ pageId: 'page-1', row: 0, column: 0, cardId: null, entryKind: 'empty' }],
      { capacity: 1440 },
    );
    apiMocks.binders.mockResolvedValue([testBinder]);
    apiMocks.binder.mockResolvedValue(initial.response);
    apiMocks.insertEntries
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(initial.result);
    await actAndSettle(() => root.render(<BinderView onNotice={() => undefined} />));
    await waitFor(() => container.querySelector('.binder-library-card') !== null);
    await actAndSettle(() =>
      container.querySelector<HTMLButtonElement>('.binder-library-card')?.click(),
    );
    await waitFor(() => container.querySelector('.binder-slot') !== null);
    expect(container.textContent).not.toContain('Insert full National Pokédex');
    await clickButton('Insert targets');
    await clickButton('Select all 1025 matches');
    await clickButton('Insert 1025 selected targets');
    expect(apiMocks.insertEntries.mock.calls[0]?.[2]).toHaveLength(1025);
    expect(container.textContent).toContain('1025 targets selected.');
    await clickButton('Insert 1025 selected targets');
    await waitFor(() => container.textContent?.includes('1025 targets inserted.') === true);
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(apiMocks.startCatalogueSync).not.toHaveBeenCalled();
    expect(apiMocks.resizeBinder).not.toHaveBeenCalled();
    expect(apiMocks.insertFullPokedex).not.toHaveBeenCalled();
  });

  it('opens a slot-first card picker and dismisses page actions outside the menu', async () => {
    const version = {
      id: 'version-1',
      binderId: 'binder-1',
      versionNumber: 1,
      status: 'draft' as const,
      layout: { kind: '3x3' as const, rows: 3 as const, columns: 3 as const },
      revision: 1,
      pageCount: 1,
    };
    const emptyPage = {
      id: 'page-1',
      position: 0,
      slots: [{ pageId: 'page-1', row: 0, column: 0, cardId: null }],
    };
    const card = {
      id: 'card-1',
      name: 'Ponyta',
      language: 'en',
      category: 'pokemon' as const,
      setId: 'set-1',
      setName: 'Base Set',
      number: '60',
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
    };
    apiMocks.binders.mockResolvedValue([
      {
        id: 'binder-1',
        name: 'Test',
        activeVersionId: 'version-1',
        latestVersionId: 'version-1',
        updatedAt: '2026-08-26T00:00:00Z',
      },
    ]);
    apiMocks.binder.mockResolvedValue({ version, pages: [emptyPage], nextPage: null });
    apiMocks.binderShortages.mockResolvedValue({ ok: true, shortages: [], nextOffset: null });
    apiMocks.resolveCards.mockResolvedValue([]);
    apiMocks.search.mockResolvedValue({ ok: true, total: 1, cards: [card], cursor: null });
    apiMocks.insertEntries.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({
      version: { ...version, revision: 2 },
      pages: [
        {
          ...emptyPage,
          slots: [{ pageId: 'page-1', row: 0, column: 0, cardId: 'card-1' }],
        },
      ],
    });

    await actAndSettle(() => root.render(<BinderView onNotice={() => undefined} />));
    await waitFor(() => container.querySelector('.binder-library-card') !== null);
    await actAndSettle(() =>
      container.querySelector<HTMLButtonElement>('.binder-library-card')?.click(),
    );
    await waitFor(() => container.querySelector('.binder-slot') !== null);

    const pageActions = container.querySelector<HTMLButtonElement>('[aria-label="Page actions"]');
    await actAndSettle(() => pageActions?.click());
    expect(container.querySelector('.page-menu-popover')).not.toBeNull();
    await actAndSettle(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(container.querySelector('.page-menu-popover')).toBeNull();
    expect(document.activeElement).toBe(pageActions);
    await actAndSettle(() => pageActions?.click());
    await actAndSettle(() => {
      container
        .querySelector<HTMLButtonElement>('.binder-slot')
        ?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    expect(container.querySelector('.page-menu-popover')).toBeNull();

    await actAndSettle(() => container.querySelector<HTMLButtonElement>('.binder-slot')?.click());
    expect(container.querySelector('[role=dialog]')).toBeNull();
    await clickButton('Insert targets here');
    await clickButton('Exact cards');
    const input = container.querySelector<HTMLInputElement>('.pocket-editor-popup input');
    if (!input) throw new Error('Slot search input did not render.');
    await actAndSettle(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        'Ponyta',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
    await actAndSettle(() => {
      input.form?.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    });
    await waitFor(() => container.querySelector('.binder-insert-results button') !== null);
    await settle();
    await actAndSettle(() =>
      container.querySelector<HTMLButtonElement>('.binder-insert-results button')?.click(),
    );
    await clickButton('Insert 1 selected target');
    await waitFor(() => apiMocks.insertEntries.mock.calls.length === 1);
    await settle();
    expect(container.querySelector('.pocket-editor-popup')).not.toBeNull();
    expect(container.querySelector<HTMLInputElement>('.pocket-editor-popup input')?.value).toBe(
      'Ponyta',
    );
    await clickButton('Insert 1 selected target');
    await waitFor(() => apiMocks.insertEntries.mock.calls.length === 2);
    await waitFor(
      () => container.querySelector<HTMLInputElement>('.pocket-editor-popup input')?.value === '',
    );
    await settle();

    const searched = apiMocks.search.mock.calls.at(-1)?.[0] as URLSearchParams;
    expect(searched.get('q')).toBe('Ponyta');
    expect(apiMocks.insertEntries.mock.calls[0]?.[1]).toMatchObject({ page: 0, row: 0, column: 0 });
    expect(apiMocks.insertEntries.mock.calls[0]?.[2]).toEqual([
      { kind: 'exact-card', cardId: 'card-1', startsNewPage: false },
    ]);
  });

  it('keeps target readiness neutral while candidates load and restores pocket focus after assignment', async () => {
    const initial = binderFixture(
      [
        {
          pageId: 'page-1',
          row: 0,
          column: 0,
          cardId: 'card-1',
          entryKind: 'exact-card',
          assignedCardId: null,
        },
      ],
      { columns: 1, capacity: 1 },
    );
    const assigned = binderFixture(
      [
        {
          pageId: 'page-1',
          row: 0,
          column: 0,
          cardId: 'card-1',
          entryKind: 'exact-card',
          assignedCardId: 'card-1',
        },
      ],
      { columns: 1, capacity: 1, revision: 2 },
    );
    const candidates = deferred<
      Array<{
        cardId: string;
        name: string;
        setName: string;
        number: string;
        owned: number;
        assigned: number;
        available: number;
      }>
    >();
    apiMocks.binders.mockResolvedValue([testBinder]);
    apiMocks.binder.mockResolvedValueOnce(initial.response).mockResolvedValue(assigned.response);
    apiMocks.resolveCards.mockResolvedValue([]);
    apiMocks.assignmentCandidates.mockReturnValue(candidates.promise);
    apiMocks.assignEntry.mockResolvedValue(assigned.result);

    await actAndSettle(() => root.render(<BinderView onNotice={() => undefined} />));
    await waitFor(() => container.querySelector('.binder-library-card') !== null);
    await actAndSettle(() =>
      container.querySelector<HTMLButtonElement>('.binder-library-card')?.click(),
    );
    await waitFor(() => container.querySelector('.binder-slot') !== null);
    const slot = container.querySelector<HTMLButtonElement>('.binder-slot');
    expect(slot?.classList).toContain('target');
    expect(slot?.textContent).toContain('Target planned');

    await actAndSettle(() => slot?.click());
    await clickButton('Owned copies and page break');
    expect(slot?.classList).toContain('target');
    expect(slot?.textContent).toContain('Target planned');
    expect(container.textContent).not.toContain('No compatible unassigned copies are available.');
    await act(async () => {
      candidates.resolve([
        {
          cardId: 'card-1',
          name: 'Bulbasaur',
          setName: '151',
          number: '001',
          owned: 1,
          assigned: 0,
          available: 1,
        },
      ]);
      await candidates.promise;
    });
    await waitFor(() => container.textContent?.includes('compatible copy remaining') === true);
    expect(slot?.textContent).toContain('Target planned');
    const assign = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('compatible copy remaining'),
    );
    await actAndSettle(() => assign?.click());
    await waitFor(() => apiMocks.assignEntry.mock.calls.length === 1);
    expect(container.querySelector('[role=dialog]')).not.toBeNull();
    expect(container.querySelector('.selected-slot')).not.toBeNull();
  });

  it.each(['same', 'any'] as const)(
    'replaces a selected target with %s type without inserting or shifting',
    async (mode) => {
      const initial = binderFixture([
        { pageId: 'page-1', row: 0, column: 0, cardId: 'card-1', entryKind: 'exact-card' },
      ]);
      const card = {
        id: 'card-1',
        name: 'Ponyta',
        language: 'en',
        category: 'pokemon' as const,
        setId: 'set-1',
        setName: 'Base Set',
        number: '60',
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
      };
      const replacement = { ...card, id: 'replacement', name: 'Replacement', pokedexNumber: 1 };
      apiMocks.binders.mockResolvedValue([testBinder]);
      apiMocks.binder.mockResolvedValue(initial.response);
      apiMocks.resolveCards.mockResolvedValue([{ ...card, id: 'card-1', pokedexNumber: 1 }]);
      apiMocks.assignmentCandidates.mockResolvedValue([]);
      apiMocks.search.mockResolvedValue({ ok: true, cards: [replacement], total: 1, cursor: null });
      apiMocks.setSlot.mockResolvedValue(initial.result);
      await actAndSettle(() => root.render(<BinderView onNotice={() => undefined} />));
      await waitFor(() => container.querySelector('.binder-library-card') !== null);
      await actAndSettle(() =>
        container.querySelector<HTMLButtonElement>('.binder-library-card')?.click(),
      );
      await waitFor(() => container.querySelector('.binder-slot') !== null);
      await actAndSettle(() => container.querySelector<HTMLButtonElement>('.binder-slot')?.click());
      await actAndSettle(() =>
        Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
          .find(
            (button) =>
              button.getAttribute('aria-label') ===
              (mode === 'same' ? 'Replace with same type' : 'Replace with any card'),
          )
          ?.click(),
      );
      await waitFor(() => container.querySelector('.binder-tray-card') !== null);
      const params = apiMocks.search.mock.calls[0]?.[0] as URLSearchParams;
      expect(params.get('pokedexNumber')).toBe(mode === 'same' ? '1' : null);
      await actAndSettle(() =>
        container.querySelector<HTMLButtonElement>('.binder-tray-card')?.click(),
      );
      expect(apiMocks.setSlot).toHaveBeenCalledWith('version-1', {
        page: 0,
        row: 0,
        column: 0,
        cardId: 'replacement',
        expectedRevision: 1,
      });
      expect(apiMocks.insertEntries).not.toHaveBeenCalled();
      expect(apiMocks.moveEntry).not.toHaveBeenCalled();
    },
  );

  it('guards binder deletion, preserves a failed confirmation, and refreshes the library after success', async () => {
    const initial = binderFixture([
      { pageId: 'page-1', row: 0, column: 0, cardId: null, entryKind: 'empty' },
    ]);
    apiMocks.binders.mockResolvedValueOnce([testBinder]).mockResolvedValue([]);
    apiMocks.binder.mockResolvedValue(initial.response);
    apiMocks.deleteBinder
      .mockRejectedValueOnce(new ApiError('internal_error', 'Failed', 500, null, null))
      .mockResolvedValueOnce(undefined);
    await actAndSettle(() => root.render(<BinderView onNotice={() => undefined} />));
    await waitFor(() => container.querySelector('.binder-library-card') !== null);
    await actAndSettle(() =>
      container.querySelector<HTMLButtonElement>('.binder-library-card')?.click(),
    );
    await waitFor(() => container.querySelector('.binder-slot') !== null);
    const button = (text: string) =>
      Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
        (item) => item.textContent === text,
      );
    await actAndSettle(() => button('Delete binder')?.click());
    expect(button('Permanently delete binder')?.disabled).toBe(true);
    await actAndSettle(() => button('Cancel deletion')?.click());
    expect(apiMocks.deleteBinder).not.toHaveBeenCalled();
    await actAndSettle(() => button('Delete binder')?.click());
    const confirmation = container.querySelector<HTMLInputElement>(
      '.binder-delete-confirmation input',
    );
    if (!confirmation) throw new Error('Missing delete confirmation');
    const fill = async (value: string) =>
      actAndSettle(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
          confirmation,
          value,
        );
        confirmation.dispatchEvent(new Event('input', { bubbles: true }));
      });
    await fill('Wrong name');
    expect(button('Permanently delete binder')?.disabled).toBe(true);
    await fill(testBinder.name);
    await actAndSettle(() => button('Permanently delete binder')?.click());
    expect(confirmation.value).toBe(testBinder.name);
    expect(container.querySelector('.binder-delete-confirmation')).not.toBeNull();
    await actAndSettle(() => button('Permanently delete binder')?.click());
    await waitFor(() => container.textContent?.includes('Your binders.') === true);
    expect(apiMocks.deleteBinder).toHaveBeenLastCalledWith(testBinder.id, testBinder.name);
    expect(apiMocks.binders).toHaveBeenCalledTimes(2);
    expect(container.querySelector('.binder-library-card')).toBeNull();
  });

  it('preserves a failed reservation label then clears it after a successful retry', async () => {
    const initial = binderFixture([
      { pageId: 'page-1', row: 0, column: 0, cardId: null, entryKind: 'empty' },
    ]);
    apiMocks.binders.mockResolvedValue([testBinder]);
    apiMocks.binder.mockResolvedValue(initial.response);
    apiMocks.reservePage
      .mockRejectedValueOnce(new ApiError('internal_error', 'Failed', 500, null, null))
      .mockResolvedValue(initial.result);
    await actAndSettle(() => root.render(<BinderView onNotice={() => undefined} />));
    await waitFor(() => container.querySelector('.binder-library-card') !== null);
    await actAndSettle(() =>
      container.querySelector<HTMLButtonElement>('.binder-library-card')?.click(),
    );
    await waitFor(() => container.querySelector('.binder-slot') !== null);
    await manage();
    const label = Array.from(container.querySelectorAll<HTMLInputElement>('input')).find((input) =>
      input.parentElement?.textContent?.includes('Page reservation label'),
    );
    if (!label) throw new Error('Missing reservation label');
    await actAndSettle(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        label,
        'Energy',
      );
      label.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const reserve = () =>
      Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'Reserve this page')
        ?.click();
    await actAndSettle(reserve);
    expect(label.value).toBe('Energy');
    await actAndSettle(reserve);
    await waitFor(() => label.value === '');
    expect(apiMocks.reservePage).toHaveBeenLastCalledWith('version-1', 0, true, 'Energy', 1);
  });

  it('uses Delete only to remove a physical assignment and restores the pocket anchor', async () => {
    const placed = binderFixture(
      [
        {
          pageId: 'page-1',
          row: 0,
          column: 0,
          cardId: 'card-1',
          entryKind: 'exact-card',
          assignedCardId: 'card-1',
        },
      ],
      { columns: 1, capacity: 1 },
    );
    const unassigned = binderFixture(
      [
        {
          pageId: 'page-1',
          row: 0,
          column: 0,
          cardId: 'card-1',
          entryKind: 'exact-card',
          assignedCardId: null,
        },
      ],
      { columns: 1, capacity: 1, revision: 2 },
    );
    apiMocks.binders.mockResolvedValue([testBinder]);
    apiMocks.binder.mockResolvedValueOnce(placed.response).mockResolvedValue(unassigned.response);
    apiMocks.resolveCards.mockResolvedValue([]);
    apiMocks.assignEntry.mockResolvedValue(unassigned.result);

    await actAndSettle(() => root.render(<BinderView onNotice={() => undefined} />));
    await waitFor(() => container.querySelector('.binder-library-card') !== null);
    await actAndSettle(() =>
      container.querySelector<HTMLButtonElement>('.binder-library-card')?.click(),
    );
    await waitFor(() => container.querySelector('.binder-slot') !== null);
    const slot = container.querySelector<HTMLButtonElement>('.binder-slot');
    slot?.focus();
    await actAndSettle(() => {
      slot?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    });
    await waitFor(() => apiMocks.assignEntry.mock.calls.length === 1);

    expect(apiMocks.assignEntry).toHaveBeenCalledWith(
      'version-1',
      { page: 0, row: 0, column: 0 },
      null,
      1,
    );
    expect(apiMocks.setSlot).not.toHaveBeenCalled();
    await waitFor(() => document.activeElement?.getAttribute('data-binder-slot') === '0-0-0');
  });

  it('returns focus to the pocket when its exact-card picker is dismissed', async () => {
    const empty = binderFixture(
      [{ pageId: 'page-1', row: 0, column: 0, cardId: null, entryKind: 'empty' }],
      { columns: 1, capacity: 1 },
    );
    apiMocks.binders.mockResolvedValue([testBinder]);
    apiMocks.binder.mockResolvedValue(empty.response);
    apiMocks.resolveCards.mockResolvedValue([]);

    await actAndSettle(() => root.render(<BinderView onNotice={() => undefined} />));
    await waitFor(() => container.querySelector('.binder-library-card') !== null);
    await actAndSettle(() =>
      container.querySelector<HTMLButtonElement>('.binder-library-card')?.click(),
    );
    await waitFor(() => container.querySelector('.binder-slot') !== null);
    await actAndSettle(() => container.querySelector<HTMLButtonElement>('.binder-slot')?.click());
    await clickButton('Insert targets here');
    const close = container.querySelector<HTMLButtonElement>('[aria-label="Close pocket editor"]');
    expect(close).not.toBeNull();
    await actAndSettle(() => close?.click());
    await waitFor(
      () => document.activeElement?.getAttribute('aria-label') === 'Insert targets here',
    );
  });

  it('removes a reserved sleeve, rejects undersized capacity, and keeps wide faces scrollable', async () => {
    const reserved = binderFixture(
      [
        {
          pageId: 'page-1',
          row: 0,
          column: 0,
          cardId: null,
          entryKind: 'reserved',
          label: 'Promo',
        },
      ],
      { columns: 1, capacity: 1 },
    );
    const empty = binderFixture(
      [{ pageId: 'page-1', row: 0, column: 0, cardId: null, entryKind: 'empty' }],
      { columns: 1, capacity: 1, revision: 2 },
    );
    apiMocks.binders.mockResolvedValue([testBinder]);
    apiMocks.binder.mockResolvedValueOnce(reserved.response).mockResolvedValue(empty.response);
    apiMocks.resolveCards.mockResolvedValue([]);
    apiMocks.removeEntry.mockResolvedValue(empty.result);

    await actAndSettle(() => root.render(<BinderView onNotice={() => undefined} />));
    await waitFor(() => container.querySelector('.binder-library-card') !== null);
    await actAndSettle(() =>
      container.querySelector<HTMLButtonElement>('.binder-library-card')?.click(),
    );
    await waitFor(() => container.querySelector('.binder-slot') !== null);
    await actAndSettle(() => container.querySelector<HTMLButtonElement>('.binder-slot')?.click());
    await clickButton('Remove card');
    const remove = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Remove and close gap',
    );
    await actAndSettle(() => remove?.click());
    await waitFor(() => apiMocks.removeEntry.mock.calls.length === 1);
    expect(container.querySelector('[role=dialog]')).not.toBeNull();

    await manage();
    const capacity = container.querySelector<HTMLInputElement>('#binder-capacity-input');
    await actAndSettle(() => {
      if (!capacity) throw new Error('Capacity input missing.');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        capacity,
        '0',
      );
      capacity.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(capacity?.getAttribute('aria-invalid')).toBe('true');
    const resize = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === 'Safely shrink binder',
    );
    expect(resize?.disabled).toBe(true);

    const wide = binderFixture(
      Array.from({ length: 20 }, (_value, column) => ({
        pageId: 'page-1',
        row: 0,
        column,
        cardId: null,
        entryKind: 'empty' as const,
      })),
      { columns: 20, capacity: 20 },
    );
    apiMocks.binder.mockResolvedValue(wide.response);
    await actAndSettle(() => container.querySelector<HTMLButtonElement>('.back-link')?.click());
    await actAndSettle(() =>
      container.querySelector<HTMLButtonElement>('.binder-library-card')?.click(),
    );
    await waitFor(() => container.querySelectorAll('.binder-slot').length === 20);
    expect(container.querySelector<HTMLElement>('.binder-grid')?.style.gridTemplateColumns).toBe(
      'repeat(20, minmax(var(--binder-slot-min, 4rem), 1fr))',
    );
  });

  it('requires explicit growth when there is no space after the final target', async () => {
    const initial = binderFixture([
      { pageId: 'page-1', row: 0, column: 0, cardId: null, entryKind: 'empty' },
    ]);
    apiMocks.binders.mockResolvedValue([testBinder]);
    apiMocks.binder.mockResolvedValue(initial.response);
    apiMocks.binderDestinations.mockResolvedValue({
      versionId: 'version-1',
      revision: 1,
      capacity: 9,
      requiredCapacity: 10,
      matches: [],
      matchCount: 0,
      appendAt: null,
    });
    await actAndSettle(() => root.render(<BinderView onNotice={() => undefined} />));
    await waitFor(() => container.querySelector('.binder-library-card') !== null);
    await actAndSettle(() =>
      container.querySelector<HTMLButtonElement>('.binder-library-card')?.click(),
    );
    await waitFor(() => container.querySelector('.binder-slot') !== null);
    await clickButton('Insert targets');
    await clickButton('Select all 1025 matches');
    expect(container.textContent).toContain('Grow the binder to at least 10 pockets');
    expect(
      Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent === 'Insert 1025 selected targets',
      )?.disabled,
    ).toBe(true);
    expect(apiMocks.resizeBinder).not.toHaveBeenCalled();
    expect(apiMocks.insertEntries).not.toHaveBeenCalled();
    await closeEditor();
    await manage();
    expect(container.querySelector('#binder-capacity-input')).not.toBeNull();
  });

  it('keeps archived binders inspectable without exposing keyboard mutations', async () => {
    const archived = binderFixture(
      [
        {
          pageId: 'page-1',
          row: 0,
          column: 0,
          cardId: 'card-1',
          entryKind: 'exact-card',
          assignedCardId: 'card-1',
        },
        {
          pageId: 'page-1',
          row: 0,
          column: 1,
          cardId: null,
          entryKind: 'empty',
          assignedCardId: null,
        },
      ],
      { status: 'archived', columns: 2, capacity: 2 },
    );
    apiMocks.binders.mockResolvedValue([testBinder]);
    apiMocks.binder.mockResolvedValue(archived.response);
    apiMocks.resolveCards.mockResolvedValue([]);

    await actAndSettle(() => root.render(<BinderView onNotice={() => undefined} />));
    await waitFor(() => container.querySelector('.binder-library-card') !== null);
    await actAndSettle(() =>
      container.querySelector<HTMLButtonElement>('.binder-library-card')?.click(),
    );
    await waitFor(() => container.querySelector('.binder-slot') !== null);
    const slot = container.querySelector<HTMLButtonElement>('.binder-slot');
    await actAndSettle(() => {
      slot?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
      slot?.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true }));
      slot?.click();
    });
    await settle();

    expect(apiMocks.assignEntry).not.toHaveBeenCalled();
    expect(apiMocks.swapSlots).not.toHaveBeenCalled();
    expect(container.textContent).toContain('This archived binder is read-only.');
    expect(container.textContent).not.toContain('Remove physical placement');

    await actAndSettle(() =>
      container.querySelectorAll<HTMLButtonElement>('.binder-slot')[1]?.click(),
    );
    expect(container.querySelector('.slot-picker-panel')).toBeNull();
    expect(container.textContent).not.toContain('Choose a card for pocket');
    expect(apiMocks.search).not.toHaveBeenCalled();
    expect(apiMocks.insertEntries).not.toHaveBeenCalled();
  });

  it('creates a fixed-capacity binder with the selected page face', async () => {
    const created = binderFixture(
      Array.from({ length: 9 }, (_value, index) => ({
        pageId: 'page-1',
        row: Math.floor(index / 3),
        column: index % 3,
        cardId: null,
        entryKind: 'empty' as const,
      })),
      { columns: 3, capacity: 480, pageCount: 54 },
    );
    apiMocks.binders.mockResolvedValue([]);
    apiMocks.createBinder.mockResolvedValue(created.result);

    await actAndSettle(() => root.render(<BinderView onNotice={() => undefined} />));
    const name = container.querySelector<HTMLInputElement>('input[required]');
    if (!name) throw new Error('Binder name input missing.');
    await actAndSettle(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        name,
        'Regional collection',
      );
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const capacity = container.querySelector<HTMLInputElement>('input[type="number"]');
    if (!capacity) throw new Error('Binder capacity input missing.');
    await actAndSettle(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        capacity,
        '1',
      );
      capacity.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.textContent).toContain('1 pocket in this binder across 1 page face.');
    await actAndSettle(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        capacity,
        '1.5',
      );
      capacity.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.textContent).toContain('Enter a whole number of pockets.');
    await actAndSettle(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        capacity,
        '478',
      );
      capacity.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.textContent).toContain('The final page has 1 pocket.');
    await actAndSettle(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        capacity,
        '480',
      );
      capacity.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.textContent).toContain('54 page faces. The final page has 3 pockets.');
    const submit = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === 'Create binder',
    );
    await actAndSettle(() => submit?.click());

    expect(apiMocks.createBinder).toHaveBeenCalledWith(
      'Regional collection',
      { kind: '3x3', rows: 3, columns: 3 },
      480,
    );
  });

  it('preserves the binder name when creation fails', async () => {
    const onNotice = vi.fn();
    apiMocks.binders.mockResolvedValue([]);
    apiMocks.createBinder.mockRejectedValue(new Error('offline'));

    await actAndSettle(() => root.render(<BinderView onNotice={onNotice} />));
    const name = container.querySelector<HTMLInputElement>('input[required]');
    if (!name) throw new Error('Binder name input missing.');
    await actAndSettle(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        name,
        'Kanto master set',
      );
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await actAndSettle(() =>
      Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'Create binder')
        ?.click(),
    );

    expect(apiMocks.createBinder).toHaveBeenCalledOnce();
    expect(container.querySelector<HTMLInputElement>('input[required]')?.value).toBe(
      'Kanto master set',
    );
    expect(onNotice).toHaveBeenCalledWith({
      kind: 'error',
      message: 'The request could not be completed. Try again.',
    });
  });

  it('grows and shrinks capacity deliberately and prepares recovery after overflow', async () => {
    const target = {
      pageId: 'page-1',
      row: 0,
      column: 0,
      cardId: 'card-1',
      entryKind: 'exact-card' as const,
      assignedCardId: null,
    };
    const initial = binderFixture([target], { columns: 1, capacity: 1 });
    const grown = binderFixture([target], { columns: 1, capacity: 2, revision: 2 });
    const shrunk = binderFixture([target], { columns: 1, capacity: 1, revision: 3 });
    apiMocks.binders.mockResolvedValue([testBinder]);
    apiMocks.binder
      .mockResolvedValueOnce(initial.response)
      .mockResolvedValueOnce(grown.response)
      .mockResolvedValueOnce(shrunk.response);
    apiMocks.resolveCards.mockResolvedValue([]);
    apiMocks.resizeBinder.mockResolvedValueOnce(grown.result).mockResolvedValueOnce(shrunk.result);

    await actAndSettle(() => root.render(<BinderView onNotice={() => undefined} />));
    await waitFor(() => container.querySelector('.binder-library-card') !== null);
    await actAndSettle(() =>
      container.querySelector<HTMLButtonElement>('.binder-library-card')?.click(),
    );
    await waitFor(() => container.querySelector('.binder-slot') !== null);
    await manage();
    const capacity = container.querySelector<HTMLInputElement>('#binder-capacity-input');
    if (!capacity) throw new Error('Capacity input missing.');
    await actAndSettle(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        capacity,
        '2',
      );
      capacity.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await actAndSettle(() =>
      Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'Grow binder')
        ?.click(),
    );
    await waitFor(() => apiMocks.resizeBinder.mock.calls.length === 1);
    await actAndSettle(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        capacity,
        '1',
      );
      capacity.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await actAndSettle(() =>
      Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'Safely shrink binder')
        ?.click(),
    );
    await waitFor(() => apiMocks.resizeBinder.mock.calls.length === 2);
    expect(apiMocks.resizeBinder.mock.calls[0]?.[1]).toBe(2);
    expect(apiMocks.resizeBinder.mock.calls[1]?.[1]).toBe(1);

    apiMocks.moveEntry.mockRejectedValue(
      new ApiError('binder_capacity_exceeded', 'More space required.', 409, 'request-1', null, {
        currentCapacity: 1,
        requiredCapacity: 4,
        additionalPockets: 3,
        pageIncrement: 1,
      }),
    );
    await closeEditor();
    await actAndSettle(() => container.querySelector<HTMLButtonElement>('.binder-slot')?.click());
    await clickButton('Insert a gap or shift sleeves');
    const offset = Array.from(
      container.querySelectorAll<HTMLInputElement>(
        '.pocket-action-group:not([hidden]) input[type="number"]',
      ),
    ).find((input) => input !== capacity && input.value === '1');
    if (!offset) throw new Error('Offset input missing.');
    await actAndSettle(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(offset, '4');
      offset.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await actAndSettle(() =>
      Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'Shift targets')
        ?.click(),
    );
    await waitFor(() => apiMocks.moveEntry.mock.calls.length === 1);
    expect(container.textContent).toContain('This action needs more capacity');
    await closeEditor();
    await manage();
    expect(container.querySelector<HTMLInputElement>('#binder-capacity-input')?.value).toBe('4');
  });

  it('grows an existing 3x3 binder to an exact 480-pocket maximum', async () => {
    const slots = Array.from({ length: 9 }, (_value, index) => ({
      pageId: 'page-1',
      row: Math.floor(index / 3),
      column: index % 3,
      cardId: null,
      entryKind: 'empty' as const,
    }));
    const initial = binderFixture(slots, { rows: 3, columns: 3, capacity: 9 });
    const grown = binderFixture(slots, {
      rows: 3,
      columns: 3,
      capacity: 480,
      pageCount: 54,
      revision: 2,
    });
    apiMocks.binders.mockResolvedValue([testBinder]);
    apiMocks.binder.mockResolvedValueOnce(initial.response).mockResolvedValue(grown.response);
    apiMocks.resolveCards.mockResolvedValue([]);
    apiMocks.resizeBinder.mockResolvedValue(grown.result);

    await actAndSettle(() => root.render(<BinderView onNotice={() => undefined} />));
    await waitFor(() => container.querySelector('.binder-library-card') !== null);
    await actAndSettle(() =>
      container.querySelector<HTMLButtonElement>('.binder-library-card')?.click(),
    );
    await waitFor(() => container.querySelector('.binder-slot') !== null);
    await manage();
    await waitFor(() => container.querySelector('#binder-capacity-input') !== null);
    const capacity = container.querySelector<HTMLInputElement>('#binder-capacity-input');
    if (!capacity) throw new Error('Binder capacity input missing.');
    await actAndSettle(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        capacity,
        '480',
      );
      capacity.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.textContent).toContain('54 page faces. The final page has 3 pockets.');
    await actAndSettle(() =>
      Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'Grow binder')
        ?.click(),
    );

    expect(apiMocks.resizeBinder).toHaveBeenCalledWith('version-1', 480, 1);
  });

  it('prepares the exact required capacity after 3x3 overflow', async () => {
    const slots = Array.from({ length: 9 }, (_value, index) => ({
      pageId: 'page-1',
      row: Math.floor(index / 3),
      column: index % 3,
      cardId: index === 0 ? 'card-1' : null,
      entryKind: index === 0 ? ('exact-card' as const) : ('empty' as const),
      assignedCardId: null,
    }));
    const initial = binderFixture(slots, { rows: 3, columns: 3, capacity: 9 });
    apiMocks.binders.mockResolvedValue([testBinder]);
    apiMocks.binder.mockResolvedValue(initial.response);
    apiMocks.resolveCards.mockResolvedValue([]);
    apiMocks.moveEntry.mockRejectedValue(
      new ApiError('binder_capacity_exceeded', 'More space required.', 409, 'request-1', null, {
        currentCapacity: 9,
        requiredCapacity: 10,
        additionalPockets: 1,
        pageIncrement: 9,
      }),
    );

    await actAndSettle(() => root.render(<BinderView onNotice={() => undefined} />));
    await waitFor(() => container.querySelector('.binder-library-card') !== null);
    await actAndSettle(() =>
      container.querySelector<HTMLButtonElement>('.binder-library-card')?.click(),
    );
    await waitFor(() => container.querySelector('.binder-slot') !== null);
    await actAndSettle(() => container.querySelector<HTMLButtonElement>('.binder-slot')?.click());
    await clickButton('Insert a gap or shift sleeves');
    const offset = Array.from(
      container.querySelectorAll<HTMLInputElement>(
        '.pocket-action-group:not([hidden]) input[type="number"]',
      ),
    ).find((input) => input.id !== 'binder-capacity-input');
    if (!offset) throw new Error('Offset input missing.');
    await actAndSettle(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(offset, '2');
      offset.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await actAndSettle(() =>
      Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'Shift targets')
        ?.click(),
    );
    await waitFor(() => apiMocks.moveEntry.mock.calls.length === 1);

    await closeEditor();
    await manage();
    expect(container.querySelector<HTMLInputElement>('#binder-capacity-input')?.value).toBe('10');
    expect(container.textContent).toContain('The final page has 1 pocket.');
  });

  it('wires target page breaks and signed shifts with current revision and focus recovery', async () => {
    const target = {
      pageId: 'page-1',
      row: 0,
      column: 0,
      cardId: 'card-1',
      entryKind: 'exact-card' as const,
      assignedCardId: null,
      startsNewPage: false,
    };
    const initial = binderFixture([target], { columns: 1, capacity: 1 });
    const broken = binderFixture([{ ...target, startsNewPage: true }], {
      columns: 1,
      capacity: 1,
      revision: 2,
    });
    const moved = binderFixture([{ ...target, startsNewPage: true }], {
      columns: 1,
      capacity: 1,
      revision: 3,
    });
    apiMocks.binders.mockResolvedValue([testBinder]);
    apiMocks.binder
      .mockResolvedValueOnce(initial.response)
      .mockResolvedValueOnce(broken.response)
      .mockResolvedValueOnce(moved.response);
    apiMocks.resolveCards.mockResolvedValue([]);
    apiMocks.setPageBreak.mockResolvedValue(broken.result);
    apiMocks.moveEntry.mockResolvedValue(moved.result);

    await actAndSettle(() => root.render(<BinderView onNotice={() => undefined} />));
    await waitFor(() => container.querySelector('.binder-library-card') !== null);
    await actAndSettle(() =>
      container.querySelector<HTMLButtonElement>('.binder-library-card')?.click(),
    );
    await waitFor(() => container.querySelector('.binder-slot') !== null);
    await actAndSettle(() => container.querySelector<HTMLButtonElement>('.binder-slot')?.click());
    await clickButton('Owned copies and page break');
    const pageBreak = container.querySelector<HTMLInputElement>(
      '.checkbox-row input[type="checkbox"]',
    );
    await actAndSettle(() => pageBreak?.click());
    await waitFor(() => apiMocks.setPageBreak.mock.calls.length === 1);
    expect(apiMocks.setPageBreak).toHaveBeenCalledWith(
      'version-1',
      { page: 0, row: 0, column: 0 },
      true,
      1,
    );
    expect(container.querySelector('[role=dialog]')).not.toBeNull();
    await closeEditor();
    await actAndSettle(() => container.querySelector<HTMLButtonElement>('.binder-slot')?.click());
    await clickButton('Insert a gap or shift sleeves');
    const offset = Array.from(
      container.querySelectorAll<HTMLInputElement>(
        '.pocket-action-group:not([hidden]) input[type="number"]',
      ),
    ).find((input) => input.value === '1');
    if (!offset) throw new Error('Offset input missing.');
    await actAndSettle(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(offset, '-1');
      offset.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await actAndSettle(() =>
      Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'Shift targets')
        ?.click(),
    );
    await waitFor(() => apiMocks.moveEntry.mock.calls.length === 1);
    expect(apiMocks.moveEntry).toHaveBeenCalledWith(
      'version-1',
      { page: 0, row: 0, column: 0 },
      -1,
      2,
    );
  });

  it('loads and focuses the shifted target on its destination page', async () => {
    const target = {
      pageId: 'page-1',
      row: 0,
      column: 0,
      cardId: null,
      entryKind: 'pokemon' as const,
      pokemonNumber: 1,
    };
    const initial = binderFixture([target], { columns: 1, capacity: 2, pageCount: 2 });
    const version = { ...initial.version, revision: 2 };
    const destination = {
      ...initial.pages[0],
      id: 'page-2',
      position: 1,
      slots: [{ ...target, pageId: 'page-2' }],
    };
    apiMocks.binders.mockResolvedValue([testBinder]);
    apiMocks.binder
      .mockResolvedValueOnce(initial.response)
      .mockResolvedValue({ version, pages: [destination], nextPage: null });
    apiMocks.assignmentCandidates.mockResolvedValue([]);
    apiMocks.moveEntry.mockResolvedValue({
      version,
      pages: [destination],
      anchor: { page: 1, row: 0, column: 0 },
    });
    await actAndSettle(() => root.render(<BinderView onNotice={() => undefined} />));
    await waitFor(() => container.querySelector('.binder-library-card') !== null);
    await actAndSettle(() =>
      container.querySelector<HTMLButtonElement>('.binder-library-card')?.click(),
    );
    await waitFor(() => container.querySelector('.binder-slot') !== null);
    await actAndSettle(() => container.querySelector<HTMLButtonElement>('.binder-slot')?.click());
    await clickButton('Insert a gap or shift sleeves');
    await actAndSettle(() =>
      Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'Shift targets')
        ?.click(),
    );
    await waitFor(
      () =>
        container.querySelector('[data-binder-slot="1-0-0"]')?.getAttribute('aria-pressed') ===
        'true',
    );
    expect(container.querySelector('[role=dialog]')).not.toBeNull();
    expect(apiMocks.binder).toHaveBeenLastCalledWith('version-1', 1, 1, expect.anything());
  });

  it('wires page reorder, arrangement, reservation, unreservation, and deletion', async () => {
    let revision = 1;
    let pageCount = 2;
    let reserved = false;
    const version = () => ({
      id: 'version-1',
      binderId: 'binder-1',
      versionNumber: 1,
      status: 'draft' as const,
      layout: { kind: 'custom' as const, rows: 1, columns: 1 },
      revision,
      pageCount,
      capacity: pageCount,
    });
    const pageFor = (position: number) => ({
      id: `page-${position + 1}`,
      position,
      kind: reserved && position === 1 ? ('reserved' as const) : ('slots' as const),
      label: reserved && position === 1 ? 'Promos' : null,
      slots:
        reserved && position === 1
          ? []
          : [
              {
                pageId: `page-${position + 1}`,
                row: 0,
                column: 0,
                cardId: null,
                entryKind: 'empty' as const,
              },
            ],
    });
    const result = (position: number) => ({ version: version(), pages: [pageFor(position)] });
    apiMocks.binders.mockResolvedValue([testBinder]);
    apiMocks.binder.mockImplementation((_id: string, position: number) =>
      Promise.resolve({ version: version(), pages: [pageFor(position)], nextPage: null }),
    );
    apiMocks.plannerSummary.mockImplementation(() =>
      Promise.resolve({
        pageIds: ['page-1', 'page-2'].slice(0, pageCount),
        revision,
        targets: 0,
        placed: 0,
        reservedSleeves: 0,
        reservedPages: reserved ? 1 : 0,
        generatedPadding: 0,
        available: pageCount,
        capacity: pageCount,
        pageSize: 1,
      }),
    );
    apiMocks.resolveCards.mockResolvedValue([]);
    apiMocks.reorderPages.mockImplementation(() => {
      revision += 1;
      return Promise.resolve(result(1));
    });
    apiMocks.arrangeBinder.mockImplementation(() => {
      revision += 1;
      return Promise.resolve(result(1));
    });
    apiMocks.reservePage.mockImplementation((_id: string, _page: number, nextReserved: boolean) => {
      reserved = nextReserved;
      revision += 1;
      return Promise.resolve(result(1));
    });
    apiMocks.deletePage.mockImplementation(() => {
      revision += 1;
      pageCount = 1;
      reserved = false;
      return Promise.resolve(result(0));
    });

    await actAndSettle(() => root.render(<BinderView onNotice={() => undefined} />));
    await waitFor(() => container.querySelector('.binder-library-card') !== null);
    await actAndSettle(() =>
      container.querySelector<HTMLButtonElement>('.binder-library-card')?.click(),
    );
    await waitFor(() => container.querySelector('.binder-slot') !== null);
    await actAndSettle(() =>
      Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'Next')
        ?.click(),
    );
    await waitFor(
      () => container.querySelector<HTMLInputElement>('[aria-label="Go to page"]')?.value === '2',
    );
    const action = (label: string): HTMLButtonElement | undefined =>
      Array.from(container.querySelectorAll<HTMLButtonElement>('.page-menu-popover button')).find(
        (button) => button.textContent === label,
      );
    const openActions = async (): Promise<void> => {
      await actAndSettle(() =>
        container.querySelector<HTMLButtonElement>('[aria-label="Page actions"]')?.click(),
      );
    };
    await openActions();
    await actAndSettle(() => action('Move page earlier')?.click());
    await waitFor(() => apiMocks.reorderPages.mock.calls.length === 1);
    expect(apiMocks.reorderPages).toHaveBeenCalledWith('version-1', ['page-2', 'page-1'], 1);

    await openActions();
    await actAndSettle(() => action('Arrange targets')?.click());
    await waitFor(() => apiMocks.arrangeBinder.mock.calls.length === 1);
    expect(apiMocks.arrangeBinder).toHaveBeenCalledWith('version-1', 'pokedex-number', 2);

    await manage();
    const label = Array.from(container.querySelectorAll<HTMLInputElement>('input')).find((input) =>
      input.parentElement?.textContent?.includes('Page reservation label'),
    );
    if (!label) throw new Error('Page reservation label missing.');
    await actAndSettle(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        label,
        'Promos',
      );
      label.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await actAndSettle(() =>
      Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'Reserve this page')
        ?.click(),
    );
    await waitFor(() => apiMocks.reservePage.mock.calls.length === 1);
    expect(apiMocks.reservePage).toHaveBeenLastCalledWith('version-1', 1, true, 'Promos', 3);
    await actAndSettle(() =>
      Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent === 'Unreserve this page')
        ?.click(),
    );
    await waitFor(() => apiMocks.reservePage.mock.calls.length === 2);
    expect(apiMocks.reservePage).toHaveBeenLastCalledWith('version-1', 1, false, null, 4);

    await openActions();
    await actAndSettle(() => action('Remove this page')?.click());
    await waitFor(() => apiMocks.deletePage.mock.calls.length === 1);
    expect(apiMocks.deletePage).toHaveBeenCalledWith('version-1', 'page-2', 5);
  });
});
