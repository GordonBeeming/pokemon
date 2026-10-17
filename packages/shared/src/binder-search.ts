import { z } from 'zod';

export const binderSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(120),
  offset: z.coerce.number().int().min(0).max(120000).default(0),
});
export const binderSearchMatchSchema = z.object({
  page: z.number().int().nonnegative(),
  row: z.number().int().nonnegative().nullable(),
  column: z.number().int().nonnegative().nullable(),
  label: z.string(),
  kind: z.enum([
    'empty',
    'reserved',
    'pokemon',
    'exact-card',
    'set',
    'illustrator',
    'trainer',
    'energy',
    'reserved-page',
  ]),
  placed: z.boolean(),
  // What the results grid draws: the copy placed here, the exact card asked for, or
  // the Pokémon whose printings an unfilled "any printing" pocket can take.
  assignedCardId: z.string().min(1).nullable().default(null),
  targetCardId: z.string().min(1).nullable().default(null),
  pokemonNumber: z.number().int().positive().nullable().default(null),
});
export const binderSearchResultSchema = z.object({
  matches: z.array(binderSearchMatchSchema).max(50),
  nextOffset: z.number().int().nonnegative().nullable(),
});
export type BinderSearchMatch = z.infer<typeof binderSearchMatchSchema>;
export type BinderSearchResult = z.infer<typeof binderSearchResultSchema>;
