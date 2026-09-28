import { NATIONAL_POKEDEX_SIZE, artUrlSchema } from '@pokedex/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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

const DISCOVERY_CACHE_MS = 6 * 60 * 60 * 1000;

function discoveryCacheKey(number: number): string {
  return `pokedex:species-discovery:${number}`;
}

/** True within 6 hours of a successful discovery for this species — the same
 * time-limited re-check cache FEATURES.md's Catalogue section describes, ported
 * from the old app's localStorage-backed cache. */
export function recentlyDiscoveredSpecies(number: number): boolean {
  try {
    const checkedAt = Number(localStorage.getItem(discoveryCacheKey(number)) ?? 0);
    return checkedAt > Date.now() - DISCOVERY_CACHE_MS;
  } catch {
    return false;
  }
}

function rememberSpeciesDiscovery(number: number): void {
  try {
    localStorage.setItem(discoveryCacheKey(number), String(Date.now()));
  } catch {
    // Storage can be unavailable in private or locked-down browser contexts; a
    // missed cache write only costs one extra discovery call next visit.
  }
}

const discoverResponseSchema = z
  .object({ ok: z.literal(true), imported: z.number() })
  .passthrough();

/** POST /api/catalogue/national/discover — indexes English printings for a species
 * the moment its gallery opens (Catalogue's "species indexing status line"). */
export function useDiscoverSpecies() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ number, name }: { number: number; name: string }) =>
      apiFetch('/api/catalogue/national/discover', discoverResponseSchema, {
        method: 'POST',
        body: { number, name },
      }).then((body) => body.imported),
    onSuccess: (_, { number }) => {
      rememberSpeciesDiscovery(number);
      void queryClient.invalidateQueries({ queryKey: ['catalogue', 'search'] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.pokedex.national() });
    },
  });
}

const representativeResponseSchema = z.object({ ok: z.literal(true) }).passthrough();

/** PUT /api/catalogue/national/:number/representative — "Use as Pokédex image". */
export function useSetNationalRepresentative() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ number, cardId }: { number: number; cardId: string }) =>
      apiFetch(`/api/catalogue/national/${number}/representative`, representativeResponseSchema, {
        method: 'PUT',
        body: { cardId },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.pokedex.national() });
    },
  });
}
