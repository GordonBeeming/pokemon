import {
  binderLayoutSchema,
  binderRevisionRequestSchema,
  binderSlotSetRequestSchema,
  binderSlotSwapRequestSchema,
  binderSlotLocationSchema,
  binderInsertRequestSchema,
  binderCompactRemoveRequestSchema,
  binderOffsetMoveRequestSchema,
  binderAssignRequestSchema,
  binderPageBreakRequestSchema,
  binderReservePageRequestSchema,
  binderCapacityRequestSchema,
  binderFullPokedexRequestSchema,
  cardCategorySchema,
  collectionIncrementRequestSchema,
  collectionNotesPatchRequestSchema,
  collectionSetRequestSchema,
  languageSchema,
  mutationRequestSchema,
  desktopScopeSchema,
  type DesktopScope,
} from '@pokedex/shared';
import { z } from 'zod';
import { requireDesktopToken } from '../../lib/desktop-auth';
import { ApplicationError } from '../../lib/log';
import type { AuthVars } from '../../lib/types';

export { binderRevisionRequestSchema, binderSlotSetRequestSchema, binderSlotSwapRequestSchema };
export const binderAssignmentCandidatesQuerySchema = binderSlotLocationSchema;
export const binderPlannerSummarySchema = z
  .object({
    pageIds: z.array(z.string().trim().min(1).max(128)),
    revision: z.number().int().positive(),
    targets: z.number().int().nonnegative(),
    placed: z.number().int().nonnegative(),
    reservedSleeves: z.number().int().nonnegative(),
    reservedPages: z.number().int().nonnegative(),
    generatedPadding: z.number().int().nonnegative(),
    available: z.number().int().nonnegative(),
    capacity: z.number().int().positive(),
    pageSize: z.number().int().positive(),
  })
  .strict();
export const binderFullPokedexPreviewSchema = z
  .object({
    currentCapacity: z.number().int().positive(),
    requiredCapacity: z.number().int().positive(),
    additionalPockets: z.number().int().nonnegative(),
    pageIncrement: z.number().int().positive(),
    generatedPadding: z.number().int().nonnegative(),
  })
  .strict();
export {
  binderInsertRequestSchema,
  binderCompactRemoveRequestSchema,
  binderOffsetMoveRequestSchema,
  binderAssignRequestSchema,
  binderPageBreakRequestSchema,
  binderReservePageRequestSchema,
  binderCapacityRequestSchema,
  binderFullPokedexRequestSchema,
};

export const collectionBody = mutationRequestSchema
  .extend({
    quantity: z.number().int().min(0).max(9999),
    notes: z.string().max(2000).nullable(),
  })
  .strict();
export const collectionSetBody = collectionSetRequestSchema;
export const compatibleCollectionSetBody = z.union([collectionSetBody, collectionBody]);
export const collectionIncrementBody = collectionIncrementRequestSchema;
export const collectionNotesBody = collectionNotesPatchRequestSchema;
export const createBinderBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    layout: binderLayoutSchema,
    capacity: z.number().int().positive().optional(),
  })
  .strict();
export const pageOrderBody = binderRevisionRequestSchema
  .extend({ pageIds: z.array(z.string().trim().min(1).max(128)).min(1) })
  .strict();
export const arrangementBody = binderRevisionRequestSchema
  .extend({
    mode: z.enum(['set-number', 'release-date', 'pokedex-number', 'language']),
  })
  .strict();
export const pairBody = z
  .object({
    scopes: z.array(desktopScopeSchema).min(1),
  })
  .strict();
export const redeemBody = z
  .object({ code: z.string().trim().min(8).max(64), label: z.string().trim().min(1).max(80) })
  .strict();
export const uploadRequestBody = z
  .object({
    cardId: z.string().trim().min(1).max(128),
    variant: z.enum(['high', 'low']),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    maxBytes: z
      .number()
      .int()
      .min(1)
      .max(15 * 1024 * 1024),
  })
  .strict();
export const bulkUploadRequestBody = z
  .object({ uploads: z.array(uploadRequestBody).min(1).max(100) })
  .strict();
export const syncBody = z
  .object({
    provider: z.literal('tcgdex'),
    language: languageSchema,
    allowDestructiveDrop: z.boolean().optional(),
    complete: z.boolean().optional(),
    cards: z
      .array(
        z
          .object({
            sourceId: z.string().trim().min(1).max(256),
            checksum: z.string().regex(/^[a-f0-9]{64}$/u),
            sourceUpdatedAt: z.number().int().nonnegative(),
            name: z.string().trim().min(1).max(200),
            language: languageSchema,
            category: cardCategorySchema,
            setId: z.string().trim().min(1).max(128),
            setName: z.string().trim().min(1).max(200),
            number: z.string().trim().min(1).max(32),
            numberSort: z.number().int().nonnegative().nullable().optional(),
            releaseDate: z.string().date().nullable().optional(),
            pokedexNumber: z.number().int().positive().nullable().optional(),
            supertype: z.string().trim().max(80).nullable().optional(),
            subtype: z.string().trim().max(120).nullable().optional(),
            species: z.string().trim().max(120).nullable().optional(),
            rarity: z.string().trim().max(120).nullable().optional(),
            artist: z.string().trim().max(200).nullable().optional(),
          })
          .strict(),
      )
      .max(1000),
  })
  .strict();
export const customCardBody = syncBody.shape.cards.element
  .omit({ sourceId: true, checksum: true, sourceUpdatedAt: true })
  .strict();
export const syncPageBody = z.object({ cards: syncBody.shape.cards }).strict();
export const syncRunBody = z.object({ language: languageSchema }).strict();
export const syncFinalizeBody = z.object({ allowDestructiveDrop: z.boolean().optional() }).strict();
export const BACKUP_CREATE_WINDOW_SECONDS = 15 * 60;

export function sessionOwner(c: { get: (key: 'session') => AuthVars['session'] }): string {
  const session = c.get('session');
  if (!session) throw new ApplicationError('unauthorized', 401);
  return session.sub;
}

export function parseDesktopBearer(header: string | undefined): string | null {
  const matched = header?.match(/^Bearer ([a-f0-9]{64})$/iu);
  return matched?.[1] ?? null;
}

export async function desktopOwner(
  c: { env: CloudflareEnv; get: (key: 'desktopBearer') => string | undefined },
  scope: DesktopScope,
): Promise<string> {
  const bearer = c.get('desktopBearer');
  if (!bearer) throw new ApplicationError('desktop_token_invalid', 401);
  return requireDesktopToken(c.env.DB, bearer, scope);
}
