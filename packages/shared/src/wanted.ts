import { z } from 'zod';
import { catalogueCardViewSchema } from './index';
export const wantedMutationSchema = z
  .object({
    cardId: z.string().trim().min(1).max(128),
    binderId: z.string().min(1).max(128).nullable().default(null),
    wanted: z.boolean(),
  })
  .strict();
export const wantedQuerySchema = z.object({
  scope: z.string().min(1).max(128).default('all'),
  placement: z.enum(['all', 'placed', 'not-placed']).default('all'),
  includeUnfilled: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  q: z.string().trim().max(200).default(''),
  sort: z.enum(['newest', 'name', 'pokedex', 'set']).default('name'),
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
});
export type WantedQuery = z.infer<typeof wantedQuerySchema>;
export const wantedScopesSchema = z.array(
  z.object({ scope: z.string(), binderName: z.string().nullable(), createdAt: z.number().int() }),
);
export const wantedEntrySchema = z.object({
  key: z.string(),
  scope: z.string(),
  binderId: z.string().nullable(),
  binderName: z.string().nullable(),
  cardId: z.string().nullable(),
  card: z
    .lazy(() => catalogueCardViewSchema)
    .nullable()
    .default(null),
  name: z.string(),
  setName: z.string().nullable(),
  number: z.string().nullable(),
  language: z.string().nullable(),
  pokedexNumber: z.number().int().nullable(),
  imageLowUrl: z.string().nullable(),
  manual: z.boolean(),
  unfilled: z.number().int(),
  ownedQuantity: z.number().int(),
  placedCount: z.number().int().nonnegative().default(0),
  createdAt: z.number().int(),
  targetKind: z.string(),
});
export const wantedListSchema = z.object({
  entries: z.array(wantedEntrySchema),
  total: z.number().int(),
  nextOffset: z.number().int().nullable(),
});
export type WantedEntry = z.infer<typeof wantedEntrySchema>;
