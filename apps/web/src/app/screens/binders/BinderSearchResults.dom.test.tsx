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
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string) => {
      if (path.includes('/search?q='))
        return Promise.resolve(json({ ok: true, matches, nextOffset: null }));
      if (path.startsWith('/api/catalogue/cards/resolve'))
        return Promise.resolve(json({ ok: true, cards: [placed, wanted] }));
      if (path.startsWith('/api/catalogue/search'))
        return Promise.resolve(
          json({ ok: true, total: 5, cards: [ownedPrinting, missingPrinting], cursor: null }),
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

describe('BinderSearchResults', () => {
  it('draws each match the way the catalogue does and jumps to its pocket', async () => {
    const onJump = vi.fn();
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

    const tiles = Array.from(
      container.querySelectorAll<HTMLButtonElement>('.binder-result-button'),
    );
    const labels = tiles.map((tile) => tile.getAttribute('aria-label') ?? '');
    // Placed copy, exact target, two printings of the open Pokémon pocket, the set pocket.
    expect(labels).toHaveLength(5);
    expect(labels[0]).toMatch(
      /^Go to Page 1 · row 1, pocket 2: Claydol · Battle Styles · 58\. Placed/,
    );
    expect(labels[1]).toMatch(/Great Encounters · 15\. Not owned · pocket open/);
    expect(labels[2]).toMatch(
      /^Go to Page 2 · row 2, pocket 1: Claydol · Ancient Origins · 33\. Owned · pocket open/,
    );
    expect(labels[3]).toMatch(/Hidden Legends · 2\. Not owned · pocket open/);
    expect(labels[4]).toMatch(/^Go to Page 3 · row 1, pocket 1: Any card · Hidden Legends/);

    // Owned cards are solid, the rest faded, as in the catalogue.
    const art = tiles.map(
      (tile) => tile.querySelector('[role="img"]')?.getAttribute('aria-label') ?? '',
    );
    expect(art[0]).toMatch(/, owned$/);
    expect(art[1]).toMatch(/not owned/);
    expect(art[2]).toMatch(/, owned$/);
    expect(art[3]).toMatch(/not owned/);
    expect(tiles[4]?.querySelector('.binder-result-empty')).not.toBeNull();
    expect(container.textContent).toContain('+3 more printings');

    act(() => tiles[3]?.click());
    expect(onJump).toHaveBeenCalledWith(expect.objectContaining({ page: 1, row: 1, column: 0 }));
  });
});
