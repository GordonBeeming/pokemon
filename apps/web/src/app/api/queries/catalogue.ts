import { catalogueCardViewSchema, catalogueDetailViewSchema } from '@pokedex/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import type { CatalogueSearch } from '../../routes/search-params';
import { apiFetch } from '../client';
import { queryKeys } from '../keys';

export const CATALOGUE_PAGE_SIZE = 50;
// The hard cap the worker and every copy/bulk-add tool agree on (see FEATURES.md's
// Clipboard & bulk actions section) — used to short-circuit a walk before it starts.
export const CATALOGUE_BULK_CAP = 2000;

const searchResponseSchema = z
  .object({
    ok: z.literal(true),
    total: z.number().int().nonnegative(),
    cards: z.array(catalogueCardViewSchema),
    cursor: z.string().nullable(),
  })
  .passthrough();
export type CatalogueSearchResponse = z.infer<typeof searchResponseSchema>;

const detailResponseSchema = z
  .object({ ok: z.literal(true), card: catalogueDetailViewSchema })
  .passthrough();

/**
 * Builds the query string for one page of `/api/catalogue/search`. `type`/`rarity`/
 * `set` are repeated params (frame types, rarity keys, set ids); `region` is a single
 * discovery-category value. All four now have server-side support (ws-data's
 * `catalogueFilters` in operations.ts) — no client-side filtering happens here.
 */
export function catalogueWireParams(
  filters: Pick<
    CatalogueSearch,
    'q' | 'type' | 'region' | 'rarity' | 'set' | 'language' | 'owned' | 'sort' | 'dex'
  >,
): URLSearchParams {
  const params = new URLSearchParams({ includePokemonNumber: 'true' });
  if (filters.q) params.set('q', filters.q);
  if (filters.owned !== 'all') params.set('owned', filters.owned === 'owned' ? 'true' : 'false');
  if (filters.sort === 'release-date') params.set('sort', 'release');
  for (const type of filters.type) params.append('type', type);
  for (const rarity of filters.rarity) params.append('rarity', rarity);
  for (const setId of filters.set) params.append('set', setId);
  if (filters.region) params.set('region', filters.region);
  if (filters.language) params.set('language', filters.language);
  if (filters.dex !== undefined) params.set('pokedexNumber', String(filters.dex));
  return params;
}

function toWireParams(filters: CatalogueSearch): URLSearchParams {
  const params = catalogueWireParams(filters);
  params.set('limit', String(CATALOGUE_PAGE_SIZE));
  params.set('offset', String((filters.page - 1) * CATALOGUE_PAGE_SIZE));
  return params;
}

export function useCatalogueSearch(filters: CatalogueSearch) {
  return useQuery({
    queryKey: queryKeys.catalogue.search(filters, filters.page),
    queryFn: ({ signal }) =>
      apiFetch(`/api/catalogue/search?${toWireParams(filters)}`, searchResponseSchema, { signal }),
    placeholderData: keepPreviousData,
  });
}

export function useCardDetail(cardId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.catalogue.card(cardId ?? ''),
    queryFn: ({ signal }) =>
      apiFetch(
        `/api/catalogue/${encodeURIComponent(cardId ?? '')}?includePokemonNumber=true`,
        detailResponseSchema,
        { signal },
      ).then((body) => body.card),
    enabled: cardId !== undefined && cardId.length > 0,
  });
}

/**
 * Walks every page of a filtered search in catalogue order (or release-date order,
 * for the clipboard's "Copy release-date order"), the same cursor-follow shape the
 * old app's `collectCardsForClipboard` used. Throws — rather than silently
 * truncating — the moment the result set changes shape mid-walk or exceeds the
 * 2,000-card bulk cap, since a stale copy or a half-added binder is worse than a
 * clear "try again".
 */
export async function collectAllMatchingCards(
  filters: CatalogueSearch,
  order: 'displayed' | 'release-date',
  signal: AbortSignal,
): Promise<z.infer<typeof catalogueCardViewSchema>[]> {
  const params = catalogueWireParams({
    ...filters,
    sort: order === 'release-date' ? 'release-date' : filters.sort,
  });
  params.set('limit', '100');
  const cards: z.infer<typeof catalogueCardViewSchema>[] = [];
  const seenIds = new Set<string>();
  const seenCursors = new Set<string>();
  let expectedTotal: number | undefined;
  let cursor: string | null = null;
  do {
    if (cursor) params.set('cursor', cursor);
    else params.delete('cursor');
    const result = await apiFetch(`/api/catalogue/search?${params}`, searchResponseSchema, {
      signal,
    });
    expectedTotal ??= result.total;
    if (expectedTotal > CATALOGUE_BULK_CAP)
      throw new Error(`Copy up to ${CATALOGUE_BULK_CAP.toLocaleString('en-AU')} cards at once.`);
    if (result.total !== expectedTotal)
      throw new Error('The results changed while copying. Try again.');
    for (const card of result.cards) {
      if (seenIds.has(card.id)) throw new Error('The results changed while copying. Try again.');
      seenIds.add(card.id);
      cards.push(card);
    }
    if (cards.length > CATALOGUE_BULK_CAP)
      throw new Error(`Copy up to ${CATALOGUE_BULK_CAP.toLocaleString('en-AU')} cards at once.`);
    cursor = result.cursor;
    if (cursor) {
      if (seenCursors.has(cursor)) throw new Error('The results changed while copying. Try again.');
      seenCursors.add(cursor);
    }
  } while (cursor !== null);
  if (cards.length !== expectedTotal)
    throw new Error('The results changed while copying. Try again.');
  return cards;
}

const customCardResponseSchema = z.object({ ok: z.literal(true), id: z.string() }).passthrough();

/** "Add a card that is not in TCGdex" — fixed language/category/set metadata per FEATURES.md. */
export function useCreateCustomCard() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      apiFetch('/api/catalogue/custom', customCardResponseSchema, {
        method: 'POST',
        body: {
          name,
          language: 'en',
          category: 'special',
          setId: 'custom',
          setName: 'Custom cards',
          number: 'custom',
        },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['catalogue', 'search'] });
    },
  });
}
