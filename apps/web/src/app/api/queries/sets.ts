import {
  catalogueSetsResponseSchema,
  illustratorRepresentativeSchema,
  setCodePatchRequestSchema,
} from '@pokedex/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { apiFetch } from '../client';
import { queryKeys } from '../keys';

const setsResponseSchema = z
  .object({
    ok: z.literal(true),
    sets: z.array(
      z
        .object({
          setId: z.string(),
          setName: z.string(),
          language: z.string(),
          total: z.number(),
          owned: z.number(),
          // Optional so a worker from before favourites still parses.
          favorite: z.boolean().optional(),
          representative: illustratorRepresentativeSchema.optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export type SetFacet = z.infer<typeof setsResponseSchema>['sets'][number];

/** Catalogue's own set filter reads this — the pre-existing, working facets list
 * (setId/setName/language/total/owned), independent of the admin-facing contract
 * below so the filter panel doesn't depend on ws-data-2's new endpoint. */
export function useSets({ preview = false }: { preview?: boolean } = {}) {
  return useQuery({
    queryKey: preview ? queryKeys.sets.previews() : queryKeys.sets.list(),
    queryFn: ({ signal }) =>
      apiFetch(`/api/catalogue/facets/sets${preview ? '?preview=true' : ''}`, setsResponseSchema, {
        signal,
      }).then((body) => body.sets),
    staleTime: 60_000,
  });
}

const okEnvelope = z.object({ ok: z.literal(true) }).passthrough();

/** Stars or unstars a set; the Sets page list flips at once and rolls back on refusal. */
export function useSetSetFavorite() {
  const queryClient = useQueryClient();
  const keys = [queryKeys.sets.previews(), queryKeys.sets.list()];
  return useMutation({
    mutationFn: ({
      setId,
      language,
      favorite,
    }: {
      setId: string;
      language: string;
      favorite: boolean;
    }) =>
      apiFetch('/api/sets/favorites', okEnvelope, {
        method: 'PUT',
        body: { setId, language, favorite },
      }),
    onMutate: async ({ setId, language, favorite }) => {
      await Promise.all(keys.map((key) => queryClient.cancelQueries({ queryKey: key })));
      const previous = keys.map((key) => queryClient.getQueryData<SetFacet[]>(key));
      for (const key of keys)
        queryClient.setQueryData<SetFacet[]>(key, (list) =>
          list?.map((set) =>
            set.setId === setId && set.language === language ? { ...set, favorite } : set,
          ),
        );
      return { previous };
    },
    onError: (_error, _variables, context) => {
      keys.forEach((key, index) => {
        const previous = context?.previous[index];
        if (previous) queryClient.setQueryData(key, previous);
      });
    },
    onSettled: () => {
      for (const key of keys) void queryClient.invalidateQueries({ queryKey: key });
    },
  });
}

const setCodesResponseSchema = z
  .object({ ok: z.literal(true) })
  .merge(catalogueSetsResponseSchema)
  .passthrough();

/**
 * The Sets & codes screen's own list — code, codeSource, releaseDate, cardCount,
 * and the 30C-style clash list — from GET /api/sets (contract B, ws-data-2). This
 * response has no owned count, so Sets.tsx joins it against `useSets()` above by
 * setId+language for the progress bar.
 */
export function useSetCodes() {
  return useQuery({
    queryKey: queryKeys.sets.codes(),
    queryFn: ({ signal }) => apiFetch('/api/sets', setCodesResponseSchema, { signal }),
    staleTime: 60_000,
  });
}

/** PATCH /api/sets/:setId — the owner-editable code for a set without a
 * TCGdex-supplied one, and the 30C clash disambiguation. Returns the whole
 * refreshed list (same shape as GET), so the cache is written directly instead of
 * refetching. */
export function usePatchSetCode() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ setId, code }: { setId: string; code: string | null }) =>
      apiFetch(`/api/sets/${encodeURIComponent(setId)}`, setCodesResponseSchema, {
        method: 'PATCH',
        body: setCodePatchRequestSchema.parse({ code }),
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.sets.codes(), data);
      void queryClient.invalidateQueries({ queryKey: ['catalogue', 'search'] });
    },
  });
}
