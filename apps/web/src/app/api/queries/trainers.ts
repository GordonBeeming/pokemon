import { trainersResponseSchema, type Trainer } from '@pokedex/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { apiFetch } from '../client';
import { queryKeys } from '../keys';

export type { Trainer };

const trainersWireResponseSchema = z
  .object({ ok: z.literal(true) })
  .merge(trainersResponseSchema)
  .passthrough();

/** Every trainer with Pokémon in the catalogue ("Lillie", "Team Rocket"), with this
 * owner's counts, favourites and a card to show. */
export function useTrainers({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    enabled,
    queryKey: queryKeys.trainers.list(),
    queryFn: ({ signal }) =>
      apiFetch('/api/trainers', trainersWireResponseSchema, { signal }).then(
        (body) => body.trainers,
      ),
    staleTime: 60_000,
  });
}

const okEnvelope = z.object({ ok: z.literal(true) }).passthrough();

/** Stars or unstars a trainer; the list flips at once and rolls back on refusal. */
export function useSetTrainerFavorite() {
  const queryClient = useQueryClient();
  const key = queryKeys.trainers.list();
  return useMutation({
    mutationFn: ({ key: trainer, favorite }: { key: string; favorite: boolean }) =>
      apiFetch('/api/trainers/favorites', okEnvelope, {
        method: 'PUT',
        body: { key: trainer, favorite },
      }),
    onMutate: async ({ key: trainer, favorite }) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<Trainer[]>(key);
      queryClient.setQueryData<Trainer[]>(key, (list) =>
        list?.map((entry) => (entry.key === trainer ? { ...entry, favorite } : entry)),
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
