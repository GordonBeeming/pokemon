import { z } from 'zod';

const setBrief = z.object({
  id: z.string().trim().min(1).max(256),
  logo: z.string().optional(),
  symbol: z.string().optional(),
});

export function catalogueSetIds(payload: unknown): string[] {
  return [
    ...new Set(
      z
        .array(setBrief)
        .min(1)
        .max(2000)
        .parse(payload)
        .filter(
          (set) =>
            !/^[AB]\d+[a-z]?$/u.test(set.id) &&
            ![set.logo, set.symbol].some((url) => url?.includes('/tcgp/')),
        )
        .map((set) => set.id),
    ),
  ].sort();
}

export function catalogueSetDetail(payload: unknown, expectedId: string) {
  const set = setBrief
    .extend({
      releaseDate: z.string().date().nullable().optional(),
      abbreviation: z.object({ official: z.string().trim().min(1).max(16).optional() }).optional(),
      cards: z.array(z.object({ id: z.string().trim().min(1).max(256) })).max(50_000),
    })
    .parse(payload);
  if (set.id !== expectedId || set.cards.some((card) => !card.id.startsWith(`${set.id}-`)))
    throw new Error('tcgdex_set_identity_mismatch');
  return {
    id: set.id,
    releaseDate: set.releaseDate ?? null,
    abbreviation: set.abbreviation?.official ?? null,
    cardIds: [...new Set(set.cards.map((card) => card.id))],
  };
}
