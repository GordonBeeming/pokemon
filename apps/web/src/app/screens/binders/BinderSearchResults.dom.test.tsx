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

function tiles(): Array<{ label: string; tier: string; art: string }> {
  return Array.from(container.querySelectorAll('.binder-result')).map((item) => ({
    label: item.querySelector('.binder-result-button')?.getAttribute('aria-label') ?? '',
    tier: item.getAttribute('data-tier') ?? '',
    art: item.querySelector('[role="img"]')?.getAttribute('aria-label') ?? '',
  }));
}

describe('BinderSearchResults', () => {
  it('draws what the binder holds first, then what you own, then the rest faded', async () => {
    const onJump = vi.fn();
    await render(onJump);

    const drawn = tiles();
    // One tile per matching pocket.
    expect(drawn).toHaveLength(4);
    expect(drawn[0]?.label).toMatch(
      /^Go to Page 1 · row 1, pocket 2: Claydol · Battle Styles · 58\. In this binder$/,
    );
    expect(drawn[0]?.tier).toBe('binder');
    expect(drawn[1]?.label).toMatch(/Great Encounters · 15\. Not owned$/);
    expect(drawn[1]?.tier).toBe('missing');
    expect(drawn[1]?.art).toMatch(/not owned/);
    // The open Claydol pocket shows the printing you own, a step back from the binder's.
    expect(drawn[2]?.label).toMatch(
      /^Go to Page 2 · row 2, pocket 1: Claydol · Ancient Origins · 33\. Owned · not in this binder$/,
    );
    expect(drawn[2]?.tier).toBe('owned');
    expect(drawn[2]?.art).toMatch(/, owned$/);
    expect(drawn[3]?.label).toMatch(/^Go to Page 3 · row 1, pocket 1: Any card · Hidden Legends/);
    expect(drawn[3]?.tier).toBe('');

    act(() => container.querySelectorAll<HTMLButtonElement>('.binder-result-button')[2]?.click());
    expect(onJump).toHaveBeenCalledWith(expect.objectContaining({ page: 1, row: 1, column: 0 }));
  });

  it('shows real art, faded, for an open pocket when none of it is owned', async () => {
    printingCards = [missingPrinting];
    printingTotal = undefined;
    searchMatches = [matches[2]];
    await render();

    const drawn = tiles();
    expect(drawn).toHaveLength(1);
    expect(drawn[0]?.label).toMatch(/Claydol · Hidden Legends · 2\. Not owned$/);
    expect(drawn[0]?.tier).toBe('missing');
    expect(drawn[0]?.art).toMatch(/not owned/);
  });

  it('looks up printings for only the first few Pokémon on a page', async () => {
    searchMatches = Array.from({ length: 14 }, (_, index) => openPocket(index + 1));
    printingCards = [];
    printingTotal = undefined;
    await render();

    const printingRequests = requests.filter((path) => path.startsWith('/api/catalogue/search'));
    expect(printingRequests).toHaveLength(12);
    // Every lookup is the catalogue's owned-first order, not an owned-only filter.
    expect(printingRequests.every((path) => !path.includes('owned='))).toBe(true);
    // Six spare printings plus one for each of the 14 open pockets that could use one up.
    expect(printingRequests.every((path) => path.includes('limit=20'))).toBe(true);
    const drawn = tiles();
    expect(drawn).toHaveLength(14);
    // Looked up with no printings, against not looked up at all.
    expect(drawn[11]?.label).toMatch(/Not owned$/);
    expect(drawn.slice(12).every((tile) => tile.label.endsWith('Any printing'))).toBe(true);
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
    // any Claydol: the first takes the other owned copy, the second real unowned art.
    printingCards = [placed, ownedPrinting, missingPrinting];
    printingTotal = undefined;
    searchMatches = [matches[0], matches[2], { ...matches[2], page: 3 }];
    await render();

    const drawn = tiles();
    expect(drawn).toHaveLength(3);
    expect(drawn.filter((tile) => tile.label.includes('Battle Styles'))).toHaveLength(1);
    expect(drawn[1]?.label).toMatch(/Ancient Origins · 33\. Owned · not in this binder$/);
    expect(drawn[2]?.label).toMatch(
      /^Go to Page 4 · row 2, pocket 1: Claydol · Hidden Legends · 2\. Owned copies shown elsewhere$/,
    );
    expect(drawn[2]?.tier).toBe('missing');
  });
});
