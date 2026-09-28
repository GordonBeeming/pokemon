import { illustratorsResponseSchema, type Illustrator } from '@pokedex/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { apiFetch } from '../client';
import { queryKeys } from '../keys';

export type { Illustrator };

// illustratorsResponseSchema (packages/shared) is `.strict()` and describes only the
// payload; every route wraps that in `{ ok: true, ... }`, so the wire schema merges
// the envelope and switches to `.passthrough()` — the same shape useSetCodes uses for
// catalogueSetsResponseSchema.
const illustratorsWireResponseSchema = z
  .object({ ok: z.literal(true) })
  .merge(illustratorsResponseSchema)
  .passthrough();

/** Every distinct illustrator across the catalogue, with this owner's counts and a
 * deterministic representative card — the Illustrators screen's own list, and the
 * source the Catalogue's artist chip resolves a display name against. */
export function useIllustrators({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    enabled,
    queryKey: queryKeys.illustrators.list(),
    queryFn: ({ signal }) =>
      apiFetch('/api/illustrators', illustratorsWireResponseSchema, { signal }).then(
        (body) => body.illustrators,
      ),
    staleTime: 60_000,
  });
}

const okEnvelope = z.object({ ok: z.literal(true) }).passthrough();

/** Stars or unstars an illustrator. The list flips at once and rolls back if the
 * server refuses, so the star answers the tap without waiting for the network. */
export function useSetIllustratorFavorite() {
  const queryClient = useQueryClient();
  const key = queryKeys.illustrators.list();
  return useMutation({
    mutationFn: ({ name, favorite }: { name: string; favorite: boolean }) =>
      apiFetch('/api/illustrators/favorites', okEnvelope, {
        method: 'PUT',
        body: { name, favorite },
      }),
    onMutate: async ({ name, favorite }) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<Illustrator[]>(key);
      queryClient.setQueryData<Illustrator[]>(key, (list) =>
        list?.map((entry) => (entry.name === name ? { ...entry, favorite } : entry)),
      );
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });
}
