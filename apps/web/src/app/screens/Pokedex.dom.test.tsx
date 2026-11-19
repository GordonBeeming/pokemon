// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { pokedexSearch } from '../routes/search-params';
import { Pokedex } from './Pokedex';
vi.mock('../api/queries/pokedex', () => ({
  useNationalPokedex: () => ({
    isLoading: false,
    data: [151, 152, 252].map((number) => ({
      number,
      ownedCards: 1,
      types: ['Water'],
      representative: null,
    })),
  }),
  useDiscoverSpecies: () => ({ mutate: vi.fn() }),
  recentlyDiscoveredSpecies: () => true,
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));
let root: Root, container: HTMLDivElement, client: QueryClient;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('IntersectionObserver', undefined);
  client = new QueryClient();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
  vi.unstubAllGlobals();
});
async function settle() {
  for (let i = 0; i < 8; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
}
async function render(search: Record<string, unknown> = {}) {
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <Pokedex search={pokedexSearch.parse(search)} />
      </QueryClientProvider>,
    ),
  );
  await settle();
}
function headings() {
  return [...container.querySelectorAll('.pokedex-region-divider')].map((e) => e.textContent);
}
async function more() {
  const button = [...container.querySelectorAll('button')].find(
    (b) => b.textContent === 'Load more Pokémon',
  );
  if (!button) throw new Error('Missing more control');
  act(() => button.click());
  await settle();
}
it('starts a region row once and keeps its divider stable as infinite loading crosses boundaries', async () => {
  await render();
  expect(headings()).toEqual(['Kanto']);
  await more();
  await more();
  await more();
  expect(headings()).toEqual(['Kanto', 'Johto']);
  const johto = container.querySelectorAll('.pokedex-region-divider')[1];
  expect(johto?.previousElementSibling?.getAttribute('aria-label')).toContain('Pokédex #151');
  expect(johto?.nextElementSibling?.getAttribute('aria-label')).toContain('Pokédex #152');
  await more();
  expect(headings()).toEqual(['Kanto', 'Johto']);
  await more();
  expect(headings()).toEqual(['Kanto', 'Johto', 'Hoenn']);
});
it('groups sparse ownership matches and omits empty regions', async () => {
  await render({ filter: 'owned' });
  expect(headings()).toEqual(['Kanto', 'Johto', 'Hoenn']);
  expect(container.querySelectorAll('.pokedex-grid button')).toHaveLength(3);
});
it('keeps a selected region headed and shows no orphan headings for an empty search', async () => {
  await render({ region: 'Johto' });
  expect(headings()).toEqual(['Johto']);
  expect(
    container
      .querySelector('.pokedex-region-divider')
      ?.nextElementSibling?.getAttribute('aria-label'),
  ).toContain('Pokédex #152');
  await render({ q: 'zzzzzz' });
  expect(headings()).toEqual([]);
  expect(container.textContent).toContain('No Pokémon match these filters.');
});
