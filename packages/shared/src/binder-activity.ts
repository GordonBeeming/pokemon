import { z } from 'zod';
import { POKEMON_DISCOVERY_CATEGORIES } from './national-pokedex';

export const binderActivityQuerySchema = z.object({
  batch: z.string().max(128).optional(),
  q: z.string().trim().max(200).default(''),
  kind: z.enum(['all', 'added', 'removed']).default('all'),
  sort: z.enum(['newest', 'oldest', 'binder', 'pokedex']).default('newest'),
  regions: z
    .string()
    .default('')
    .transform((value) => (value ? value.split(',') : []))
    .pipe(z.array(z.enum(POKEMON_DISCOVERY_CATEGORIES)).max(POKEMON_DISCOVERY_CATEGORIES.length)),
});
export type BinderActivityQuery = z.infer<typeof binderActivityQuerySchema>;
export const binderActivityResultSchema = z.object({
  selectedBatch: z.string(),
  batches: z.array(
    z.object({ id: z.string(), createdAt: z.number().int().nullable(), count: z.number().int() }),
  ),
  total: z.number().int(),
  events: z.array(
    z.object({
      id: z.number().int(),
      kind: z.enum(['added', 'removed']),
      createdAt: z.number().int(),
      versionId: z.string(),
      versionNumber: z.number().int(),
      page: z.number().int(),
      row: z.number().int(),
      column: z.number().int(),
      cardId: z.string(),
      name: z.string(),
      setName: z.string(),
      number: z.string(),
      language: z.string(),
      pokedexNumber: z.number().int().nullable(),
      region: z.string().nullable(),
      imageLowUrl: z.string().nullable(),
    }),
  ),
});
export type BinderActivityResult = z.infer<typeof binderActivityResultSchema>;
