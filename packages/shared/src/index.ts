import { z } from 'zod';

export const cardIdSchema = z.string().trim().min(1).max(128).brand<'CardId'>();
export type CardId = z.infer<typeof cardIdSchema>;

export const PHYSICAL_LANGUAGES = [
  'en',
  'fr',
  'es',
  'es-mx',
  'it',
  'pt',
  'pt-br',
  'pt-pt',
  'de',
  'nl',
  'pl',
  'ru',
  'ja',
  'ko',
  'zh-tw',
  'id',
  'th',
  'zh-cn',
] as const;
export const languageSchema = z.enum(PHYSICAL_LANGUAGES);
export type LanguageCode = z.infer<typeof languageSchema>;

export const cardCategorySchema = z.enum(['pokemon', 'trainer', 'energy', 'special']);
export type CardCategory = z.infer<typeof cardCategorySchema>;

const cardFields = {
  id: cardIdSchema,
  name: z.string().trim().min(1).max(200),
  language: languageSchema,
  category: cardCategorySchema,
  setId: z.string().trim().min(1).max(128),
  setName: z.string().trim().min(1).max(200),
  number: z.string().trim().min(1).max(32),
  imageLowUrl: z.string().url().nullable(),
};

export const catalogueBriefSchema = z.object(cardFields).strict();
export type CatalogueBrief = z.infer<typeof catalogueBriefSchema>;

export const catalogueDetailSchema = catalogueBriefSchema.extend({
  supertype: z.string().trim().max(80).nullable(),
  subtype: z.string().trim().max(120).nullable(),
  species: z.string().trim().max(120).nullable(),
  rarity: z.string().trim().max(120).nullable(),
  artist: z.string().trim().max(200).nullable(),
  imageHighUrl: z.string().url().nullable(),
  source: z
    .object({
      provider: z.string().min(1),
      sourceId: z.string().min(1),
      updatedAt: z.string().datetime(),
    })
    .strict(),
  notes: z.string().max(2000).nullable(),
});
export type CatalogueDetail = z.infer<typeof catalogueDetailSchema>;

export const collectionStateSchema = z
  .object({
    cardId: cardIdSchema,
    quantity: z.number().int().min(0).max(9999),
    notes: z.string().max(2000).nullable(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type CollectionState = z.infer<typeof collectionStateSchema>;

export const standardBinderLayoutSchema = z
  .object({
    kind: z.enum(['2x2', '3x3', '4x3', 'top-loader']),
    rows: z.number().int().positive(),
    columns: z.number().int().positive(),
  })
  .strict();
export const customBinderLayoutSchema = z
  .object({
    kind: z.literal('custom'),
    rows: z.number().int().min(1).max(20),
    columns: z.number().int().min(1).max(20),
  })
  .strict();
export const binderLayoutSchema = z.union([standardBinderLayoutSchema, customBinderLayoutSchema]);
export type BinderLayout = z.infer<typeof binderLayoutSchema>;

export const priceBaselineSchema = z
  .object({
    amountAud: z.number().finite().nonnegative().nullable(),
    nativeAmount: z.number().finite().nonnegative().nullable(),
    nativeCurrency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .nullable(),
    source: z.string().min(1).max(80).nullable(),
    sourceCapturedAt: z.string().datetime().nullable(),
    fxDate: z.string().date().nullable(),
  })
  .strict();
export type PriceBaseline = z.infer<typeof priceBaselineSchema>;

export const mutationIdSchema = z.string().uuid();
export type MutationId = z.infer<typeof mutationIdSchema>;

export const apiErrorSchema = z
  .object({
    ok: z.literal(false),
    error: z.string().min(1).max(80),
    message: z.string().max(500).optional(),
    requestId: z.string().max(128).optional(),
  })
  .strict();
export type ApiError = z.infer<typeof apiErrorSchema>;

export const apiSuccessSchema = z.object({ ok: z.literal(true) }).passthrough();
export type ApiSuccess = z.infer<typeof apiSuccessSchema>;

export const mutationRequestSchema = z.object({ mutationId: mutationIdSchema }).strict();
export type MutationRequest = z.infer<typeof mutationRequestSchema>;

export const binderSlotSchema = z
  .object({
    row: z.number().int().nonnegative(),
    column: z.number().int().nonnegative(),
    cardId: cardIdSchema.nullable(),
  })
  .strict();
export type BinderSlot = z.infer<typeof binderSlotSchema>;
