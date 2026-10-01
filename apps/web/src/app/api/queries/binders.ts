import {
  type BinderDisplayPatchRequest,
  binderAssignmentCandidateSchema,
  binderBookmarkSchema,
  binderFullPokedexPreviewSchema,
  binderInsertDestinationsSchema,
  binderPageSchema,
  binderPastePreviewSchema,
  binderPlannerSummarySchema,
  binderPokemonShortageSchema,
  binderSearchResultSchema,
  binderShortageSchema,
  binderSlotSchema,
  binderVersionPagesSchema,
  binderVersionSummarySchema,
  binderViewSchema,
  catalogueCardViewSchema,
  inactiveBinderTargetSchema,
  type BinderBookmarkSetRequest,
  type BinderCopyChoice,
  type BinderEntry,
  type BinderLayout,
  type BinderPasteRequest,
  type BinderSlotLocation,
} from '@pokedex/shared';
import { useQueries, useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { apiFetch } from '../client';
import { queryKeys } from '../keys';

// Browser tabs can stay open across a worker deploy; passthrough so an additive field
// from a newer server doesn't break a client that hasn't reloaded yet. Exported types
// are the schemas' input side because that's what apiFetch's signature yields.
const binderSlotResponseSchema = binderSlotSchema.passthrough();
const binderPageResponseSchema = binderPageSchema
  .extend({ slots: z.array(binderSlotResponseSchema).max(400) })
  .passthrough();
const versionSummaryResponseSchema = binderVersionSummarySchema.passthrough();
const binderViewResponseSchema = binderViewSchema.passthrough();

export type BinderPageView = z.input<typeof binderPageResponseSchema>;
export type BinderSlotView = z.input<typeof binderSlotResponseSchema>;
export type BinderVersionView = z.input<typeof versionSummaryResponseSchema>;
export type BinderListItem = z.input<typeof binderViewResponseSchema>;

const bindersResponseSchema = z
  .object({ ok: z.literal(true), binders: z.array(binderViewResponseSchema) })
  .passthrough();

const binderPagesResponseSchema = z
  .object({
    ok: z.literal(true),
    binder: binderVersionPagesSchema
      .extend({
        version: versionSummaryResponseSchema,
        pages: z.array(binderPageResponseSchema).max(4),
      })
      .passthrough(),
  })
  .passthrough();

export type BinderPageWindow = z.input<typeof binderPagesResponseSchema>['binder'];

const mutationResultSchema = z
  .object({
    version: versionSummaryResponseSchema,
    pages: z.array(binderPageResponseSchema).max(2),
    anchor: binderSlotLocationLenient().optional(),
  })
  .passthrough();
export type BinderMutation = z.input<typeof mutationResultSchema>;
const mutationEnvelopeSchema = z
  .object({ ok: z.literal(true), binder: mutationResultSchema })
  .passthrough();

function binderSlotLocationLenient() {
  return z
    .object({
      page: z.number().int().nonnegative(),
      row: z.number().int().nonnegative(),
      column: z.number().int().nonnegative(),
    })
    .passthrough();
}

const okSchema = z.object({ ok: z.literal(true) }).passthrough();
const summaryEnvelopeSchema = z
  .object({ ok: z.literal(true), summary: binderPlannerSummarySchema.passthrough() })
  .passthrough();
export type BinderSummaryView = z.input<typeof summaryEnvelopeSchema>['summary'];
const bookmarksEnvelopeSchema = z
  .object({ ok: z.literal(true), bookmarks: z.array(binderBookmarkSchema.passthrough()) })
  .passthrough();
const bookmarkEnvelopeSchema = z
  .object({ ok: z.literal(true), bookmark: binderBookmarkSchema.passthrough() })
  .passthrough();
const candidatesEnvelopeSchema = z
  .object({
    ok: z.literal(true),
    candidates: z.array(binderAssignmentCandidateSchema.passthrough()).max(500),
  })
  .passthrough();
export type BinderCandidate = z.input<typeof candidatesEnvelopeSchema>['candidates'][number];
const destinationsEnvelopeSchema = z
  .object({ ok: z.literal(true), destinations: binderInsertDestinationsSchema.passthrough() })
  .passthrough();
const pastePreviewEnvelopeSchema = z
  .object({ ok: z.literal(true), preview: binderPastePreviewSchema.passthrough() })
  .passthrough();
const fullPokedexPreviewEnvelopeSchema = z
  .object({ ok: z.literal(true), preview: binderFullPokedexPreviewSchema.passthrough() })
  .passthrough();
const spaceSearchEnvelopeSchema = binderSearchResultSchema
  .extend({ ok: z.literal(true) })
  .passthrough();
const shortagesEnvelopeSchema = z
  .object({
    ok: z.literal(true),
    shortages: z.array(binderShortageSchema.passthrough()),
    pokemonShortages: z.array(binderPokemonShortageSchema.passthrough()),
    totalMissing: z.number().int().nonnegative(),
    totalEntries: z.number().int().nonnegative(),
    nextOffset: z.number().int().nonnegative().nullable(),
  })
  .passthrough();
const inactiveTargetsEnvelopeSchema = z
  .object({ ok: z.literal(true), targets: z.array(inactiveBinderTargetSchema.passthrough()) })
  .passthrough();
const patchBinderEnvelopeSchema = z
  .object({ ok: z.literal(true), binder: binderViewResponseSchema })
  .passthrough();
const resolveEnvelopeSchema = z
  .object({ ok: z.literal(true), cards: z.array(catalogueCardViewSchema) })
  .passthrough();
export type ResolvedCard = z.input<typeof resolveEnvelopeSchema>['cards'][number];
const cardSearchEnvelopeSchema = z
  .object({
    ok: z.literal(true),
    total: z.number().int().nonnegative(),
    cards: z.array(catalogueCardViewSchema),
    cursor: z.string().nullable(),
  })
  .passthrough();
export type CardSearchPage = z.input<typeof cardSearchEnvelopeSchema>;

const versionPath = (versionId: string, suffix = ''): string =>
  `/api/binders/versions/${encodeURIComponent(versionId)}${suffix}`;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function useBinders() {
  return useQuery({
    queryKey: queryKeys.binders.list(),
    queryFn: ({ signal }) =>
      apiFetch('/api/binders', bindersResponseSchema, { signal }).then((body) => body.binders),
  });
}

export function fetchBinderPage(
  versionId: string,
  pageIndex: number,
  signal?: AbortSignal,
): Promise<BinderPageWindow> {
  return apiFetch(versionPath(versionId, `?page=${pageIndex}&limit=1`), binderPagesResponseSchema, {
    signal,
  }).then((body) => body.binder);
}

/** One query per page index so a page already on screen is never refetched just
 * because a neighbour came into view, and a slide between pages reuses the cache. */
export function useBinderPages(versionId: string | undefined, pageIndexes: readonly number[]) {
  return useQueries({
    queries: pageIndexes.map((pageIndex) => ({
      queryKey: queryKeys.binders.page(versionId ?? '', pageIndex),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        fetchBinderPage(versionId ?? '', pageIndex, signal),
      enabled: versionId !== undefined && versionId.length > 0 && pageIndex >= 0,
      staleTime: 30_000,
    })),
  });
}

/** Kept for other screens: the first page of a binder version. */
export function useBinderPage(versionId: string | undefined, pageIndex: number) {
  return useQuery({
    queryKey: queryKeys.binders.page(versionId ?? '', pageIndex),
    queryFn: ({ signal }) => fetchBinderPage(versionId ?? '', pageIndex, signal),
    enabled: versionId !== undefined && versionId.length > 0,
  });
}

export function useBinderSummary(versionId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.binders.summary(versionId ?? ''),
    queryFn: ({ signal }) =>
      apiFetch(versionPath(versionId ?? '', '/planner-summary'), summaryEnvelopeSchema, {
        signal,
      }).then((body) => body.summary),
    enabled: versionId !== undefined && versionId.length > 0,
  });
}

export function useBinderSummaries(versionIds: readonly string[]) {
  return useQueries({
    queries: versionIds.map((versionId) => ({
      queryKey: queryKeys.binders.summary(versionId),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        apiFetch(versionPath(versionId, '/planner-summary'), summaryEnvelopeSchema, {
          signal,
        }).then((body) => body.summary),
    })),
  });
}

export function useBinderBookmarks(versionId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.binders.bookmarks(versionId ?? ''),
    queryFn: ({ signal }) =>
      apiFetch(versionPath(versionId ?? '', '/bookmarks'), bookmarksEnvelopeSchema, {
        signal,
      }).then((body) => body.bookmarks),
    enabled: versionId !== undefined && versionId.length > 0,
  });
}

export function useBinderShortages(versionId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.binders.shortages(versionId ?? ''),
    queryFn: ({ signal }) =>
      apiFetch(versionPath(versionId ?? '', '/shortages?limit=100'), shortagesEnvelopeSchema, {
        signal,
      }),
    enabled: versionId !== undefined && versionId.length > 0,
  });
}

const assignOwnedEnvelopeSchema = z
  .object({
    ok: z.literal(true),
    count: z.number().int().nonnegative(),
    locations: z.array(
      z.object({ page: z.number().int(), row: z.number().int(), column: z.number().int() }),
    ),
  })
  .passthrough();

function assignOwned(versionId: string, expectedRevision: number, apply: boolean) {
  return apiFetch(versionPath(versionId, '/assign-owned'), assignOwnedEnvelopeSchema, {
    method: 'POST',
    body: { expectedRevision, apply },
  });
}

/** Pockets holding a card the owner has but that aren't marked as placed (older
 * placements saved as exact-card targets). A preview only (`apply: false`), keyed by
 * revision so any write to the binder re-asks. */
export function useOwnedUnplacedPreview(versionId: string, revision: number | undefined) {
  return useQuery({
    queryKey: queryKeys.binders.ownedUnplaced(versionId, revision ?? -1),
    queryFn: () => assignOwned(versionId, revision ?? 0, false),
    enabled: versionId.length > 0 && revision !== undefined,
    retry: false,
  });
}

export function useBinderSpaceSearch(versionId: string, query: string, offset: number) {
  const trimmed = query.trim();
  return useQuery({
    queryKey: queryKeys.binders.spaceSearch(versionId, trimmed, offset),
    queryFn: ({ signal }) =>
      apiFetch(
        versionPath(
          versionId,
          `/search?${new URLSearchParams({ q: trimmed, offset: String(offset) })}`,
        ),
        spaceSearchEnvelopeSchema,
        { signal },
      ),
    enabled: trimmed.length > 0,
  });
}

export function useAssignmentCandidates(
  versionId: string,
  slotId: string,
  at: BinderSlotLocation | null,
) {
  return useQuery({
    queryKey: queryKeys.binders.candidates(versionId, slotId),
    queryFn: ({ signal }) => {
      const location = at ?? { page: 0, row: 0, column: 0 };
      const params = new URLSearchParams({
        page: String(location.page),
        row: String(location.row),
        column: String(location.column),
      });
      return apiFetch(
        versionPath(versionId, `/assignment-candidates?${params}`),
        candidatesEnvelopeSchema,
        { signal },
      ).then((body) => body.candidates);
    },
    enabled: at !== null,
  });
}

export function useInsertDestinations(versionId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.binders.destinations(versionId),
    queryFn: ({ signal }) =>
      apiFetch(versionPath(versionId, '/destinations'), destinationsEnvelopeSchema, {
        signal,
      }).then((body) => body.destinations),
    enabled: enabled && versionId.length > 0,
  });
}

export function useInactiveTargets() {
  return useQuery({
    queryKey: queryKeys.binders.inactiveTargets(),
    queryFn: ({ signal }) =>
      apiFetch('/api/binders/inactive-targets', inactiveTargetsEnvelopeSchema, { signal }).then(
        (body) => body.targets,
      ),
    staleTime: 60_000,
  });
}

export function resolveCards(cardIds: readonly string[], signal?: AbortSignal) {
  return apiFetch('/api/catalogue/cards/resolve?includePokemonNumber=true', resolveEnvelopeSchema, {
    method: 'POST',
    body: { cardIds },
    signal,
  }).then((body) => body.cards);
}

/** Resolves card ids to display data, one query per id group so each page's cards
 * are cached on their own and a page already on screen never re-resolves. */
export function useResolvedCardGroups(groups: ReadonlyArray<readonly string[]>) {
  // Two pages with the same cards (or none) would otherwise register the same query
  // twice in one observer.
  const unique = new Map<string, string[]>();
  for (const ids of groups) {
    const sorted = [...new Set(ids)].sort();
    if (sorted.length > 0) unique.set(sorted.join(','), sorted);
  }
  return useQueries({
    queries: [...unique.values()].map((sorted) => {
      return {
        queryKey: queryKeys.binders.resolvedCards(sorted),
        queryFn: ({ signal }: { signal: AbortSignal }) => resolveCards(sorted, signal),
        enabled: sorted.length > 0,
        staleTime: 60_000,
      };
    }),
  });
}

export function searchCards(params: URLSearchParams, signal?: AbortSignal) {
  const query = new URLSearchParams(params);
  query.set('includePokemonNumber', 'true');
  return apiFetch(`/api/catalogue/search?${query}`, cardSearchEnvelopeSchema, { signal });
}

const cardDetailEnvelopeSchema = z
  .object({
    ok: z.literal(true),
    card: z
      .object({
        id: z.string(),
        collection: z
          .object({ quantity: z.number().int(), revision: z.number().int() })
          .passthrough()
          .nullable(),
      })
      .passthrough(),
  })
  .passthrough();

export function fetchOwnedCount(cardId: string, signal?: AbortSignal) {
  return apiFetch(`/api/catalogue/${encodeURIComponent(cardId)}`, cardDetailEnvelopeSchema, {
    signal,
  }).then((body) => ({
    quantity: body.card.collection?.quantity ?? 0,
    revision: body.card.collection?.revision ?? 0,
  }));
}

// ---------------------------------------------------------------------------
// Writes. Every binder write carries the revision the caller last saw; the worker
// rejects a stale one with `binder_revision_conflict` and nothing here retries it.
// ---------------------------------------------------------------------------

function mutate(versionId: string, suffix: string, method: string, body: unknown) {
  return apiFetch(versionPath(versionId, suffix), mutationEnvelopeSchema, { method, body }).then(
    (envelope) => envelope.binder,
  );
}

export const binderApi = {
  /** Marks every owned-but-unplaced pocket as placed; returns how many it marked. */
  assignOwned: (versionId: string, expectedRevision: number) =>
    assignOwned(versionId, expectedRevision, true),
  create: (name: string, layout: BinderLayout, capacity: number) =>
    apiFetch('/api/binders', mutationEnvelopeSchema, {
      method: 'POST',
      body: { name, layout, capacity },
    }).then((body) => body.binder),
  remove: (binderId: string, confirmationName: string) =>
    apiFetch(`/api/binders/${encodeURIComponent(binderId)}`, okSchema, {
      method: 'DELETE',
      body: { confirmationName },
    }).then(() => undefined),
  patchDisplay: (binderId: string, patch: BinderDisplayPatchRequest) =>
    apiFetch(`/api/binders/${encodeURIComponent(binderId)}`, patchBinderEnvelopeSchema, {
      method: 'PATCH',
      body: patch,
    }).then((body) => body.binder),
  swap: (
    versionId: string,
    source: BinderSlotLocation,
    target: BinderSlotLocation,
    expectedRevision: number,
  ) => mutate(versionId, '/swap', 'POST', { source, target, expectedRevision }),
  setSlot: (
    versionId: string,
    at: BinderSlotLocation,
    cardId: string | null,
    expectedRevision: number,
    copyChoice?: BinderCopyChoice,
  ) =>
    mutate(versionId, '/slot', 'PUT', {
      ...at,
      cardId,
      expectedRevision,
      ...(copyChoice ? { copyChoice } : {}),
    }),
  assign: (
    versionId: string,
    at: BinderSlotLocation,
    cardId: string | null,
    expectedRevision: number,
  ) => mutate(versionId, '/assignment', 'PUT', { at, cardId, expectedRevision }),
  pageBreak: (
    versionId: string,
    at: BinderSlotLocation,
    startsNewPage: boolean,
    expectedRevision: number,
  ) => mutate(versionId, '/page-break', 'PUT', { at, startsNewPage, expectedRevision }),
  insert: (
    versionId: string,
    at: BinderSlotLocation,
    entries: BinderEntry[],
    expectedRevision: number,
  ) => mutate(versionId, '/entries/insert', 'POST', { at, entries, expectedRevision }),
  compactRemove: (versionId: string, at: BinderSlotLocation, expectedRevision: number) =>
    mutate(versionId, '/entries/remove', 'POST', { at, expectedRevision }),
  shift: (versionId: string, from: BinderSlotLocation, offset: number, expectedRevision: number) =>
    mutate(versionId, '/entries/move', 'POST', { from, offset, expectedRevision }),
  paste: (versionId: string, request: BinderPasteRequest) =>
    mutate(versionId, '/entries/paste', 'POST', request),
  previewPaste: (versionId: string, request: BinderPasteRequest, signal?: AbortSignal) =>
    apiFetch(versionPath(versionId, '/entries/paste/preview'), pastePreviewEnvelopeSchema, {
      method: 'POST',
      body: request,
      signal,
    }).then((body) => body.preview),
  reservePage: (
    versionId: string,
    page: number,
    reserved: boolean,
    label: string | null,
    expectedRevision: number,
  ) => mutate(versionId, '/reserved-page', 'PUT', { page, reserved, label, expectedRevision }),
  reorderPages: (versionId: string, pageIds: string[], expectedRevision: number) =>
    mutate(versionId, '/pages/order', 'PUT', { pageIds, expectedRevision }),
  /** Blank pages before `beforePosition` (0-based); later pages move back whole. */
  insertPages: (
    versionId: string,
    beforePosition: number,
    count: number,
    expectedRevision: number,
  ) => mutate(versionId, '/pages/insert', 'POST', { beforePosition, count, expectedRevision }),
  addPage: (versionId: string, expectedRevision: number) =>
    mutate(versionId, '/pages', 'POST', { expectedRevision }),
  deletePage: (versionId: string, pageId: string, expectedRevision: number) =>
    mutate(versionId, `/pages/${encodeURIComponent(pageId)}`, 'DELETE', { expectedRevision }),
  arrange: (versionId: string, mode: ArrangeMode, expectedRevision: number) =>
    mutate(versionId, '/arrange', 'POST', { mode, expectedRevision }),
  resize: (versionId: string, capacity: number, expectedRevision: number) =>
    mutate(versionId, '/capacity', 'PUT', { capacity, expectedRevision }),
  clone: (versionId: string, expectedRevision: number) =>
    mutate(versionId, '/clone', 'POST', { expectedRevision }),
  activate: (versionId: string, expectedRevision: number) =>
    mutate(versionId, '/activate', 'POST', { expectedRevision }),
  discardDraft: (versionId: string, expectedRevision: number) =>
    apiFetch(versionPath(versionId), okSchema, {
      method: 'DELETE',
      body: { expectedRevision },
    }).then(() => undefined),
  fullPokedex: (
    versionId: string,
    at: BinderSlotLocation,
    regionPageBreaks: boolean,
    expectedRevision: number,
  ) => mutate(versionId, '/full-pokedex', 'POST', { at, regionPageBreaks, expectedRevision }),
  previewFullPokedex: (
    versionId: string,
    at: BinderSlotLocation,
    regionPageBreaks: boolean,
    expectedRevision: number,
    signal?: AbortSignal,
  ) =>
    apiFetch(versionPath(versionId, '/full-pokedex/preview'), fullPokedexPreviewEnvelopeSchema, {
      method: 'POST',
      body: { at, regionPageBreaks, expectedRevision },
      signal,
    }).then((body) => body.preview),
  setBookmark: (versionId: string, request: BinderBookmarkSetRequest) =>
    apiFetch(versionPath(versionId, '/bookmarks'), bookmarkEnvelopeSchema, {
      method: 'PUT',
      body: request,
    }).then((body) => body.bookmark),
  removeBookmark: (versionId: string, bookmarkId: string) =>
    apiFetch(versionPath(versionId, `/bookmarks/${encodeURIComponent(bookmarkId)}`), okSchema, {
      method: 'DELETE',
    }).then(() => undefined),
};

export const ARRANGE_MODES = ['pokedex-number', 'set-number', 'release-date', 'language'] as const;
export type ArrangeMode = (typeof ARRANGE_MODES)[number];
