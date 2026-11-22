import { z } from 'zod';
import { catalogueCardViewSchema } from './index';

export const binderActivityQuerySchema = z.object({
  batch: z.string().max(128).optional(),
  q: z.string().trim().max(200).default(''),
  kind: z.enum(['all', 'added', 'removed', 'ordered', 'received', 'cancelled']).default('all'),
  sort: z.enum(['newest', 'oldest', 'binder', 'pokedex']).default('binder'),
  sections: z
    .string()
    .max(100000)
    .default('[]')
    .transform((value, context) => {
      try {
        const parsed: unknown = JSON.parse(value);
        return parsed;
      } catch {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid bookmark selection' });
        return z.NEVER;
      }
    })
    .pipe(z.array(z.string().min(1).max(140)).max(2000)),
});
export type BinderActivityQuery = z.infer<typeof binderActivityQuerySchema>;
export const binderActivityResultSchema = z.object({
  selectedBatch: z.string(),
  pendingChanges: z.number().int().nonnegative(),
  sections: z.array(z.object({ id: z.string(), name: z.string() })),
  batches: z.array(
    z.object({ id: z.string(), createdAt: z.number().int().nullable(), count: z.number().int() }),
  ),
  total: z.number().int(),
  events: z.array(
    z.object({
      id: z.number().int(),
      kind: z.enum(['added', 'removed', 'ordered', 'received', 'cancelled']),
      createdAt: z.number().int(),
      versionId: z.string(),
      versionNumber: z.number().int(),
      versionRevision: z.number().int().nullable().optional(),
      page: z.number().int(),
      row: z.number().int(),
      column: z.number().int(),
      cardId: z.string(),
      card: z
        .lazy(() => catalogueCardViewSchema)
        .nullable()
        .default(null),
      name: z.string(),
      setName: z.string(),
      number: z.string(),
      language: z.string(),
      pokedexNumber: z.number().int().nullable(),
      region: z.string().nullable(),
      sectionName: z.string().nullable(),
      imageLowUrl: z.string().nullable(),
    }),
  ),
});
export type BinderActivityResult = z.infer<typeof binderActivityResultSchema>;
