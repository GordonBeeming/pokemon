import { trainerDexResponseSchema } from '@pokedex/shared';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { apiFetch } from '../client';
export function useTrainerDex() {
  return useQuery({
    queryKey: ['trainer-dex'],
    gcTime: 60 * 60_000,
    queryFn: ({ signal }) =>
      apiFetch('/api/trainer-dex', trainerDexResponseSchema.extend({ ok: z.literal(true) }), {
        signal,
      }).then((d) => d.trainers),
  });
}
