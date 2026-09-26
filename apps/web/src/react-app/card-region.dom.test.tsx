// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CatalogueView } from './catalogue-view';
const mocks = vi.hoisted(() => ({ search: vi.fn(), card: vi.fn(), binders: vi.fn() }));
vi.mock('./api', async (original) => ({
  ...(await original<typeof import('./api')>()),
  api: mocks,
}));
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.binders.mockResolvedValue([]);
});
afterEach(async () => {
  await step(() => root.unmount());
  container.remove();
});
async function step(action: () => void): Promise<void> {
  await act(async () => {
    action();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
describe('card region presentation', () => {
  it.each([
    { category: 'pokemon', pokedexNumber: 7, region: 'Kanto' },
    { category: 'pokemon', pokedexNumber: null, region: 'Not recorded' },
    { category: 'trainer', pokedexNumber: null, region: null },
  ] as const)(
    'shows accurate region metadata for $category/$pokedexNumber',
    async ({ category, pokedexNumber, region }) => {
      const card = {
        id: 'card-1',
        name: 'Squirtle',
        language: 'en',
        category,
        pokedexNumber,
        setId: 'base',
        setName: 'Base Set',
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
      };
      mocks.search.mockResolvedValue({ ok: true, cards: [card], total: 1, cursor: null });
      mocks.card.mockResolvedValue({
        ...card,
        supertype: null,
        subtype: null,
        species: null,
        rarity: null,
        artist: null,
        notes: null,
        source: { provider: 'tcgdex', sourceId: 'base-7', updatedAt: '2026-09-26T00:00:00Z' },
      });
      await step(() =>
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
      const tile = container.querySelector<HTMLButtonElement>('[data-card-id="card-1"]');
      if (!tile) throw new Error('Card tile did not render');
      expect(tile.querySelector('.card-region')?.textContent ?? null).toBe(
        region === 'Kanto' ? 'Region: Kanto' : null,
      );
      expect(tile.textContent).toContain('Base Set · 7');
      await step(() => tile.click());
      const label = Array.from(container.querySelectorAll('.detail-copy dt')).find(
        (item) => item.textContent === 'Region',
      );
      expect(label?.nextElementSibling?.textContent ?? null).toBe(region);
    },
  );
});
