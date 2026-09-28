import { NATIONAL_POKEDEX_SIZE, artUrlSchema } from '@pokedex/shared';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { apiFetch } from '../client';
import { queryKeys } from '../keys';

const nationalPokedexResponseSchema = z
  .object({
    ok: z.literal(true),
    entries: z.array(
      z
        .object({
          number: z.number().int().min(1).max(NATIONAL_POKEDEX_SIZE),
          totalCards: z.number().int().nonnegative(),
          ownedCards: z.number().int().nonnegative(),
          types: z.array(z.string()),
          representative: z
            .object({
              cardId: z.string(),
              cardName: z.string(),
              setName: z.string(),
              number: z.string(),
              imageLowUrl: artUrlSchema,
              imageHighUrl: artUrlSchema,
              explicit: z.boolean(),
            })
            .passthrough(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export type NationalPokedexCoverage = z.infer<
  typeof nationalPokedexResponseSchema
>['entries'][number];

export function useNationalPokedex() {
  return useQuery({
    queryKey: queryKeys.pokedex.national(),
    queryFn: ({ signal }) =>
      apiFetch('/api/catalogue/national', nationalPokedexResponseSchema, { signal }).then(
        (body) => body.entries,
      ),
    staleTime: 60_000,
  });
}
