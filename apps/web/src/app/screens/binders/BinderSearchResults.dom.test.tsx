// @vitest-environment happy-dom
import { DEFAULT_FRAME_PALETTE } from '@pokedex/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BinderSearchResults } from './BinderSearchResults';

const price = {
  amountAud: null,
  nativeAmount: null,
  nativeCurrency: null,
  source: null,
  sourceCapturedAt: null,
  fxDate: null,
};

function card(id: string, number: string, setName: string, quantity: number) {
  return {
    id,
    name: 'Claydol',
    language: 'en',
    category: 'pokemon',
    setId: id,
    setName,
    number,
    imageLowUrl: null,
    imageHighUrl: null,
    pokedexNumber: 344,
    collection:
      quantity > 0
        ? { cardId: id, quantity, notes: null, revision: 1, updatedAt: '2026-10-17T00:00:00.000Z' }
        : null,
    price,
    frameType: 'fighting',
    setCode: id.toUpperCase(),
    rarityKey: 'U',
  };
}

const placed = card('swsh5-58', '58', 'Battle Styles', 1);
const wanted = card('dp4-15', '15', 'Great Encounters', 0);
const ownedPrinting = card('xy7-33', '33', 'Ancient Origins', 1);
const missingPrinting = card('ex5-2', '2', 'Hidden Legends', 0);

const matches = [
  {
    page: 0,
    row: 0,
    column: 1,
    label: 'Claydol · Battle Styles · 58',
    kind: 'pokemon',
    placed: true,
    assignedCardId: placed.id,
    targetCardId: null,
    pokemonNumber: 344,
  },
  {
    page: 0,
    row: 0,
    column: 2,
    label: 'Claydol · Great Encounters · 15',
    kind: 'exact-card',
    placed: false,
    assignedCardId: null,
    targetCardId: wanted.id,
    pokemonNumber: null,
  },
  {
    page: 1,
    row: 1,
    column: 0,
    label: '#344 Claydol · Hoenn',
    kind: 'pokemon',
    placed: false,
    assignedCardId: null,
    targetCardId: null,
    pokemonNumber: 344,
  },
  {
    page: 2,
    row: 0,
    column: 0,
    label: 'Any card · Hidden Legends',
    kind: 'set',
    placed: false,
    assignedCardId: null,
    targetCardId: null,
    pokemonNumber: null,
  },
];

let container: HTMLDivElement;
let root: Root;
let searchMatches: unknown[];
let resolveFails: boolean;
let printingCards: unknown[];
let printingTotal: number | undefined;
let requests: string[];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  searchMatches = matches;
  resolveFails = false;
  printingCards = [ownedPrinting, missingPrinting];
  printingTotal = 5;
  requests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string) => {
      requests.push(path);
      if (path.includes('/search?q='))
        return Promise.resolve(json({ ok: true, matches: searchMatches, nextOffset: null }));
      if (path.startsWith('/api/catalogue/cards/resolve'))
        return Promise.resolve(
          resolveFails
            ? new Response(JSON.stringify({ ok: false, error: 'internal_error' }), {
                status: 500,
                headers: { 'content-type': 'application/json' },
              })
            : json({ ok: true, cards: [placed, wanted] }),
        );
      if (path.startsWith('/api/catalogue/search'))
        return Promise.resolve(
          json({
            ok: true,
            total: printingTotal ?? printingCards.length,
            cards: printingCards,
            cursor: null,
          }),
        );
      return Promise.reject(new Error(`Unexpected request ${path}`));
    }),
  );
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(onJump = vi.fn()): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <BinderSearchResults
          versionId="bv_1"
          query="claydol"
          palette={DEFAULT_FRAME_PALETTE}
          onJump={onJump}
        />
      </QueryClientProvider>,
    ),
  );
  await flush();
}

function openPocket(pokemonNumber: number) {
  return {
    page: 0,
    row: 0,
    column: pokemonNumber,
    label: `#${pokemonNumber}`,
    kind: 'pokemon',
    placed: false,
    assignedCardId: null,
    targetCardId: null,
    pokemonNumber,
  };
}

describe('BinderSearchResults', () => {
  it('draws each match the way the catalogue does and jumps to its pocket', async () => {
    const onJump = vi.fn();
    await render(onJump);

    const tiles = Array.from(
      container.querySelectorAll<HTMLButtonElement>('.binder-result-button'),
    );
    const labels = tiles.map((tile) => tile.getAttribute('aria-label') ?? '');
    // One tile per matching pocket: placed copy, exact target, the open Pokémon pocket
    // showing the printing you own, and the set pocket.
    expect(labels).toHaveLength(4);
    expect(labels[0]).toMatch(
      /^Go to Page 1 · row 1, pocket 2: Claydol · Battle Styles · 58\. Placed/,
    );
    expect(labels[1]).toMatch(/Great Encounters · 15\. Not owned · pocket open/);
    expect(labels[2]).toMatch(
      /^Go to Page 2 · row 2, pocket 1: Claydol · Ancient Origins · 33\. Owned · pocket open/,
    );
    expect(labels[3]).toMatch(/^Go to Page 3 · row 1, pocket 1: Any card · Hidden Legends/);

    // Owned cards are solid, the rest faded, as in the catalogue.
    const art = tiles.map(
      (tile) => tile.querySelector('[role="img"]')?.getAttribute('aria-label') ?? '',
    );
    expect(art[0]).toMatch(/, owned$/);
    expect(art[1]).toMatch(/not owned/);
    expect(art[2]).toMatch(/, owned$/);
    expect(tiles[3]?.querySelector('.binder-result-empty')).not.toBeNull();
    expect(container.textContent).toContain('5 owned printings');
    expect(labels[2]).toMatch(/Owned · pocket open\. 5 owned printings$/);
    // Only owned printings are asked for.
    expect(requests.find((path) => path.startsWith('/api/catalogue/search'))).toContain(
      'owned=true',
    );

    act(() => tiles[2]?.click());
    expect(onJump).toHaveBeenCalledWith(expect.objectContaining({ page: 1, row: 1, column: 0 }));
  });

  it('shows one faded card for an open pocket when nothing of it is owned', async () => {
    printingCards = [];
    printingTotal = undefined;
    searchMatches = [matches[2]];
    await render();

    const tiles = Array.from(container.querySelectorAll('.binder-result-button'));
    expect(tiles).toHaveLength(1);
    expect(tiles[0]?.getAttribute('aria-label')).toMatch(/Not owned · pocket open$/);
    expect(tiles[0]?.querySelector('[role="img"]')?.getAttribute('aria-label')).toMatch(
      /not owned/,
    );
  });

  it('looks up owned printings for only the first few Pokémon on a page', async () => {
    searchMatches = Array.from({ length: 14 }, (_, index) => openPocket(index + 1));
    printingCards = [];
    printingTotal = undefined;
    await render();

    const printingRequests = requests.filter((path) => path.startsWith('/api/catalogue/search'));
    expect(printingRequests).toHaveLength(12);
    const labels = Array.from(container.querySelectorAll('.binder-result-button')).map(
      (tile) => tile.getAttribute('aria-label') ?? '',
    );
    expect(labels).toHaveLength(14);
    // Looked up and none owned, against not looked up at all.
    expect(labels[11]).toMatch(/Not owned · pocket open$/);
    expect(labels.slice(12).every((label) => label.endsWith('Any printing · pocket open'))).toBe(
      true,
    );
  });

  it('says so when card lookups fail instead of showing empty pockets', async () => {
    resolveFails = true;
    await render();

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Some cards could not be drawn');
    expect(alert?.querySelector('button')?.textContent).toBe('Try again');
  });

  it('never shows the same card for two pockets', async () => {
    // The placed Battle Styles copy is also an owned printing, and two open pockets want
    // any Claydol.
    printingCards = [placed, ownedPrinting];
    printingTotal = undefined;
    searchMatches = [matches[0], matches[2], { ...matches[2], page: 3 }];
    await render();

    const labels = Array.from(container.querySelectorAll('.binder-result-button')).map(
      (tile) => tile.getAttribute('aria-label') ?? '',
    );
    expect(labels).toHaveLength(3);
    expect(labels.filter((label) => label.includes('Battle Styles'))).toHaveLength(1);
    expect(labels.filter((label) => label.includes('Ancient Origins'))).toHaveLength(1);
    expect(labels[2]).toMatch(
      /^Go to Page 4 · row 2, pocket 1: .*Owned copies shown elsewhere · pocket open$/,
    );
  });

  it('does not claim where owned copies are when the lookup was cut short', async () => {
    // Seven owned printings exist but only the one fetched is known, and it's shown elsewhere.
    printingCards = [placed];
    printingTotal = 7;
    searchMatches = [matches[0], matches[2]];
    await render();

    const labels = Array.from(container.querySelectorAll('.binder-result-button')).map(
      (tile) => tile.getAttribute('aria-label') ?? '',
    );
    expect(labels[1]).toMatch(/Any printing · pocket open$/);
  });
});
