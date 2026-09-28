import {
  catalogueDetailViewSchema,
  collectionIncrementRequestSchema,
  collectionMutationResultSchema,
  collectionNotesPatchRequestSchema,
  collectionRemoveRequestSchema,
  collectionSetRequestSchema,
  collectionStateSchema,
  type CollectionIncrementRequest,
  type CollectionNotesPatchRequest,
  type CollectionRemoveRequest,
  type CollectionSetRequest,
  type CollectionState,
} from '@pokedex/shared';
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { apiFetch, ApiError } from '../client';
import { queryKeys } from '../keys';

const mutationResponseSchema = z
  .object({ ok: z.literal(true) })
  .merge(collectionMutationResultSchema)
  .passthrough();

const removeResponseSchema = z
  .object({ ok: z.literal(true), state: collectionStateSchema })
  .passthrough();

/**
 * Mirrors every visible copy of a card's collection state after a mutation: the
 * catalogue search cache (any page currently held), the card-detail cache, and the
 * dashboard summary (unique/total counters). Skips a stale write the same way the
 * old app's `applyState` did — never overwrite a state with a lower revision than
 * what's already cached, which can happen if a slower request resolves after a
 * faster, later one.
 */
function applyCollectionState(
  queryClient: QueryClient,
  cardId: string,
  state: CollectionState,
): void {
  queryClient.setQueriesData(
    { queryKey: ['catalogue', 'search'] },
    (data: { cards: Array<{ id: string; collection: CollectionState | null }> } | undefined) => {
      if (!data) return data;
      return {
        ...data,
        cards: data.cards.map((card) =>
          card.id === cardId && (card.collection?.revision ?? 0) <= state.revision
            ? { ...card, collection: state }
            : card,
        ),
      };
    },
  );
  queryClient.setQueryData(
    queryKeys.catalogue.card(cardId),
    (current: z.infer<typeof catalogueDetailViewSchema> | undefined) =>
      current && (current.collection?.revision ?? 0) <= state.revision
        ? { ...current, collection: state, notes: state.notes }
        : current,
  );
  void queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.summary() });
  void queryClient.invalidateQueries({ queryKey: queryKeys.pokedex.national() });
}

export function useSetCollection(cardId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<CollectionSetRequest, 'mutationId'>) =>
      apiFetch(`/api/collection/${encodeURIComponent(cardId)}`, mutationResponseSchema, {
        method: 'PUT',
        body: collectionSetRequestSchema.parse({ ...input, mutationId: crypto.randomUUID() }),
      }).then((body) => body.state),
    onSuccess: (state) => applyCollectionState(queryClient, cardId, state),
  });
}

export function useIncrementCollection(cardId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<CollectionIncrementRequest, 'mutationId'>) =>
      apiFetch(`/api/collection/${encodeURIComponent(cardId)}/increment`, mutationResponseSchema, {
        method: 'POST',
        body: collectionIncrementRequestSchema.parse({ ...input, mutationId: crypto.randomUUID() }),
      }).then((body) => body.state),
    onSuccess: (state) => applyCollectionState(queryClient, cardId, state),
  });
}

export function usePatchCollectionNotes(cardId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<CollectionNotesPatchRequest, 'mutationId'>) =>
      apiFetch(`/api/collection/${encodeURIComponent(cardId)}/notes`, mutationResponseSchema, {
        method: 'PATCH',
        body: collectionNotesPatchRequestSchema.parse({
          ...input,
          mutationId: crypto.randomUUID(),
        }),
      }).then((body) => body.state),
    onSuccess: (state) => applyCollectionState(queryClient, cardId, state),
  });
}

/** POST /api/collection/:cardId/remove — the where-from-dialog's three sources
 * (pocket/loose/miscount); see FEATURES.md's "Lowering a card's owned quantity"
 * line. The `collection_remove_slot_required` error carries `details.candidates`
 * for the miscount-with-everything-placed case; callers read that off the thrown
 * ApiError rather than this hook, since it's not a success path. */
export function useRemoveCollectionCopy(cardId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CollectionRemoveRequest) =>
      apiFetch(`/api/collection/${encodeURIComponent(cardId)}/remove`, removeResponseSchema, {
        method: 'POST',
        body: collectionRemoveRequestSchema.parse(input),
      }).then((body) => body.state),
    onSuccess: (state) => {
      applyCollectionState(queryClient, cardId, state);
      void queryClient.invalidateQueries({ queryKey: queryKeys.catalogue.binderMatches(cardId) });
      void queryClient.invalidateQueries({ queryKey: ['binders'] });
    },
    onError: (cause) => {
      // The server re-checks counts and pockets inside its transaction, so these two
      // mean another tab or device changed this card first: refetch so the dialog
      // offers the choices that are true now instead of retrying a stale one.
      if (
        cause instanceof ApiError &&
        (cause.code === 'collection_revision_conflict' ||
          cause.code === 'collection_remove_slot_not_found')
      ) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.catalogue.card(cardId) });
        void queryClient.invalidateQueries({ queryKey: ['binders'] });
      }
    },
  });
}
