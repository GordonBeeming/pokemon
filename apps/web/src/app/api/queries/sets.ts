import { useQuery } from '@tanstack/react-query';
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
        })
        .passthrough(),
    ),
  })
  .passthrough();

export type SetFacet = z.infer<typeof setsResponseSchema>['sets'][number];

export function useSets() {
  return useQuery({
    queryKey: queryKeys.sets.list(),
    queryFn: ({ signal }) =>
      apiFetch('/api/catalogue/facets/sets', setsResponseSchema, { signal }).then(
        (body) => body.sets,
      ),
    staleTime: 60_000,
  });
}
