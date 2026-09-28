import {
  catalogueCardViewSchema,
  catalogueDetailViewSchema,
  cardCategorySchema,
} from '@pokedex/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import type { CatalogueSearch } from '../../routes/search-params';
import { apiFetch } from '../client';
import { queryKeys } from '../keys';

const PAGE_SIZE = 50;

const searchResponseSchema = z
  .object({
    ok: z.literal(true),
    total: z.number().int().nonnegative(),
    cards: z.array(catalogueCardViewSchema),
    cursor: z.string().nullable(),
  })
  .passthrough();

const detailResponseSchema = z
  .object({ ok: z.literal(true), card: catalogueDetailViewSchema })
  .passthrough();

/**
 * The worker's CatalogueFilters (apps/web/src/worker/routes/api/operations.ts) only
 * understands a single `setId`, a single `category`, `owned`, `query` and a `release`
 * sort. The route's `type[]`/`rarity[]`/`set[]`/`region` params go further than that:
 * multi-value type/set, rarity, and region filtering have no server-side equivalent
 * yet. Rather than fake a client-side filter that would silently under-fill a page,
 * this only forwards what the server can actually apply and leaves the rest for
 * whoever picks up that backend gap (see ws-foundation's report).
 */
function toWireParams(filters: CatalogueSearch): URLSearchParams {
  const params = new URLSearchParams({ includePokemonNumber: 'true' });
  if (filters.q) params.set('q', filters.q);
  if (filters.owned !== 'all') params.set('owned', filters.owned === 'owned' ? 'true' : 'false');
  if (filters.sort === 'release-date') params.set('sort', 'release');
  const [onlySet] = filters.set;
  if (filters.set.length === 1 && onlySet) params.set('setId', onlySet);
  const [onlyType] = filters.type;
  if (filters.type.length === 1 && onlyType) {
    const category = cardCategorySchema.safeParse(onlyType);
    if (category.success) params.set('category', category.data);
  }
  params.set('limit', String(PAGE_SIZE));
  params.set('offset', String((filters.page - 1) * PAGE_SIZE));
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
