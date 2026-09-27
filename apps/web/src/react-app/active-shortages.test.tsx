// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { cardIdSchema } from '@pokedex/shared';
import { DashboardView, activeShortageCount } from './ui';
import { catalogueHrefForEntry } from './active-shortages';
import type { Dashboard, ActiveShortageEntry } from './api';
const report = vi.hoisted(() => vi.fn());
vi.mock('./api', async (original) => ({
  ...(await original<typeof import('./api')>()),
  api: { activeShortages: report },
}));
const pokemon: ActiveShortageEntry = {
  kind: 'pokemon',
  label: '#0025 Pikachu',
  cardId: null,
  pokemonNumber: 25,
  required: 1,
  owned: 0,
  assigned: 0,
  available: 0,
  missing: 1,
};
const data: Dashboard = {
  ok: true,
  collection: { uniqueOwned: 0, totalQuantity: 0, noted: 0 },
  pricing: { priced: 0, missing: 0, estimateAud: 0 },
  binderCount: 1,
  activeShortages: [{ cardId: cardIdSchema.parse('card'), required: 2, owned: 0, missing: 2 }],
  activePokemonShortages: [{ pokemonNumber: 25, required: 1, owned: 0, missing: 1 }],
  cards: [],
};
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div');
  document.body.replaceChildren(container);
  root = createRoot(container);
  report.mockReset();
});
afterEach(() => act(() => root.unmount()));
async function render() {
  await act(async () => {
    root.render(
      <DashboardView
        data={data}
        browse={() => undefined}
        plan={() => undefined}
        chooseCard={() => undefined}
      />,
    );
    await new Promise((r) => setTimeout(r, 0));
  });
}
async function click(text: string) {
  await act(async () => {
    const button = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes(text),
    );
    if (!button) throw new Error('Missing button ' + text);
    button.click();
    await new Promise((r) => setTimeout(r, 0));
  });
}
it('counts both target types and opens paginated detail rows', async () => {
  report
    .mockResolvedValueOnce({ entries: [pokemon], totalMissing: 3, totalEntries: 2, nextOffset: 50 })
    .mockResolvedValueOnce({
      entries: [
        {
          ...pokemon,
          kind: 'exact-card',
          cardId: 'card',
          pokemonNumber: null,
          label: 'Squirtle · Base · 63',
          required: 2,
          missing: 2,
        },
      ],
      totalMissing: 3,
      totalEntries: 2,
      nextOffset: null,
    });
  expect(activeShortageCount(data)).toBe(3);
  await render();
  expect(report).not.toHaveBeenCalled();
  await click('Active shortages');
  expect(container.querySelector('button[aria-expanded="true"]')).not.toBeNull();
  expect(container.textContent).toContain('#0025 Pikachu');
  await click('Load more shortages');
  expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
  await click('Close');
  expect(container.querySelector('table')).toBeNull();
});
it('shows a retryable error and correctly describes zero shortages', async () => {
  report
    .mockRejectedValueOnce(new Error('Offline'))
    .mockResolvedValueOnce({ entries: [], totalMissing: 0, totalEntries: 0, nextOffset: null });
  await render();
  await click('Active shortages');
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  await click('Try again');
  expect(container.textContent).toContain('No active shortages');
  expect(container.textContent).toContain('Some copies may still need');
});
it('links species without restrictive name filters and exact cards by set and collector number', () => {
  expect(catalogueHrefForEntry(pokemon)).toBe('#catalogue?pokedexNumber=25');
  expect(
    catalogueHrefForEntry({
      ...pokemon,
      kind: 'exact-card',
      cardId: 'card',
      pokemonNumber: null,
      label: 'Squirtle · Base · 63',
      setId: 'base1',
      number: '63',
      language: 'en',
    }),
  ).toBe('#catalogue?q=63&setId=base1&language=en');
});
