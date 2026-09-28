import type { CatalogueSearch } from '../routes/search-params';

// One factory, keyed by the same route params the URL carries, so a screen's query
// key and its search params never drift apart.
export const queryKeys = {
  session: () => ['session'] as const,
  catalogue: {
    search: (filters: CatalogueSearch, page: number) =>
      ['catalogue', 'search', filters, page] as const,
    card: (cardId: string) => ['catalogue', 'card', cardId] as const,
  },
  pokedex: {
    national: () => ['pokedex', 'national'] as const,
  },
  sets: {
    list: () => ['sets', 'list'] as const,
  },
  binders: {
    list: () => ['binders', 'list'] as const,
    page: (binderId: string, page: number) => ['binders', 'page', binderId, page] as const,
  },
  settings: {
    framePalette: () => ['settings', 'frame-palette'] as const,
  },
} as const;
