import {
  binderPageSchema,
  binderSlotSchema,
  binderVersionSummarySchema,
  cardBinderMatchesResponseSchema,
  cardPlaceRequestSchema,
  type CardPlaceRequest,
} from '@pokedex/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { apiFetch } from '../client';
import { queryKeys } from '../keys';

const binderMatchesResponseSchema = z
  .object({ ok: z.literal(true) })
  .merge(cardBinderMatchesResponseSchema)
  .passthrough();

/** Backs the card inspector's Binders section: one row per binder, per FEATURES.md's
 * "Binder placement is not a separate disclosure" line. */
export function useCardBinderMatches(cardId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.catalogue.binderMatches(cardId ?? ''),
    queryFn: ({ signal }) =>
      apiFetch(
        `/api/cards/${encodeURIComponent(cardId ?? '')}/binder-matches`,
        binderMatchesResponseSchema,
        { signal },
      ).then((body) => body.binders),
    enabled: cardId !== undefined && cardId.length > 0,
  });
}

// Same passthrough shape as api/queries/binders.ts's mutation responses: a browser
// tab can stay open across a worker deploy, so additive fields from a newer server
// must not fail parsing here.
const placeResponseSchema = z
  .object({
    ok: z.literal(true),
    version: binderVersionSummarySchema.passthrough(),
    pages: z.array(
      binderPageSchema
        .extend({ slots: z.array(binderSlotSchema.passthrough()).max(400) })
        .passthrough(),
    ),
  })
  .passthrough();

/** POST /api/cards/:id/place — fills a matching open target (exact or any-Pokémon)
 * without rewriting it into an exact-card target; see FEATURES.md's "Put in a
 * binder" line. */
export function usePlaceCard(cardId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CardPlaceRequest) =>
      apiFetch(`/api/cards/${encodeURIComponent(cardId)}/place`, placeResponseSchema, {
        method: 'POST',
        body: cardPlaceRequestSchema.parse(input),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.catalogue.binderMatches(cardId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.catalogue.card(cardId) });
      void queryClient.invalidateQueries({ queryKey: ['catalogue', 'search'] });
      // The binderId in the request, not a versionId, so the broad ['binders'] prefix
      // (every per-version key nests under it) is what actually invalidates the
      // binder this card was just placed into.
      void queryClient.invalidateQueries({ queryKey: ['binders'] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.summary() });
    },
  });
}
