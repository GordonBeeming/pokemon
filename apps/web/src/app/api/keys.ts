import type { CatalogueSearch } from '../routes/search-params';

// One factory, keyed by the same route params the URL carries, so a screen's query
// key and its search params never drift apart.
export const queryKeys = {
  session: () => ['session'] as const,
  catalogue: {
    search: (filters: CatalogueSearch, page: number) =>
      ['catalogue', 'search', filters, page] as const,
    card: (cardId: string) => ['catalogue', 'card', cardId] as const,
    binderMatches: (cardId: string) => ['catalogue', 'card', cardId, 'binder-matches'] as const,
  },
  pokedex: {
    national: () => ['pokedex', 'national'] as const,
  },
  dashboard: {
    summary: () => ['dashboard', 'summary'] as const,
  },
  sets: {
    list: () => ['sets', 'list'] as const,
    // Contract B's admin-facing set list (code/codeSource/clashes), separate from the
    // facets list above that Catalogue's set filter reads.
    codes: () => ['sets', 'codes'] as const,
  },
  binders: {
    list: () => ['binders', 'list'] as const,
    // Every per-version key starts with ['binders', 'version', versionId] so one
    // invalidation after a write refreshes everything that version shows.
    version: (versionId: string) => ['binders', 'version', versionId] as const,
    page: (versionId: string, page: number) =>
      ['binders', 'version', versionId, 'page', page] as const,
    summary: (versionId: string) => ['binders', 'version', versionId, 'summary'] as const,
    bookmarks: (versionId: string) => ['binders', 'version', versionId, 'bookmarks'] as const,
    shortages: (versionId: string) => ['binders', 'version', versionId, 'shortages'] as const,
    spaceSearch: (versionId: string, query: string, offset: number) =>
      ['binders', 'version', versionId, 'search', query, offset] as const,
    candidates: (versionId: string, slotId: string) =>
      ['binders', 'version', versionId, 'candidates', slotId] as const,
    destinations: (versionId: string) => ['binders', 'version', versionId, 'destinations'] as const,
    ownedUnplaced: (versionId: string, revision: number) =>
      ['binders', 'version', versionId, 'owned-unplaced', revision] as const,
    inactiveTargets: () => ['binders', 'inactive-targets'] as const,
    resolvedCards: (cardIds: readonly string[]) => ['binders', 'cards', ...cardIds] as const,
  },
  settings: {
    framePalette: () => ['settings', 'frame-palette'] as const,
    passkeys: () => ['settings', 'passkeys'] as const,
    tokens: () => ['settings', 'tokens'] as const,
  },
  people: {
    me: () => ['people', 'me'] as const,
    list: () => ['people', 'list'] as const,
    invites: () => ['people', 'invites'] as const,
    invite: (token: string) => ['people', 'invite', token] as const,
  },
} as const;
