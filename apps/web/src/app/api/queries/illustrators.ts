import { illustratorsResponseSchema, type Illustrator } from '@pokedex/shared';
import { useQuery } from '@tanstack/react-query';
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
export function useIllustrators() {
  return useQuery({
    queryKey: queryKeys.illustrators.list(),
    queryFn: ({ signal }) =>
      apiFetch('/api/illustrators', illustratorsWireResponseSchema, { signal }).then(
        (body) => body.illustrators,
      ),
    staleTime: 60_000,
  });
}
