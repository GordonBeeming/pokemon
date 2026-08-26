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

export const DESKTOP_SCOPES = [
  'art:read',
  'art:write',
  'catalogue:read',
  'collection:write',
  'binders:write',
] as const;
export const desktopScopeSchema = z.enum(DESKTOP_SCOPES);
export type DesktopScope = z.infer<typeof desktopScopeSchema>;

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
  imageLowUrl: z.lazy(() => artUrlSchema),
};

export const sameOriginArtPathSchema = z.string().regex(/^\/api\/art\/[^/?#\s]+\/(?:high|low)$/u);
export const absoluteArtUrlSchema = z
  .string()
  .url()
  .regex(/^https?:\/\//u);
export const artUrlSchema = z.union([sameOriginArtPathSchema, absoluteArtUrlSchema]).nullable();
export type ArtUrl = z.infer<typeof artUrlSchema>;

export const catalogueBriefSchema = z.object(cardFields).strict();
export type CatalogueBrief = z.infer<typeof catalogueBriefSchema>;

export const catalogueDetailSchema = catalogueBriefSchema.extend({
  supertype: z.string().trim().max(80).nullable(),
  subtype: z.string().trim().max(120).nullable(),
  species: z.string().trim().max(120).nullable(),
  rarity: z.string().trim().max(120).nullable(),
  artist: z.string().trim().max(200).nullable(),
  imageHighUrl: artUrlSchema,
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
    revision: z.number().int().positive(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type CollectionState = z.infer<typeof collectionStateSchema>;

export const standardBinderLayoutSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('2x2'), rows: z.literal(2), columns: z.literal(2) }).strict(),
  z.object({ kind: z.literal('3x3'), rows: z.literal(3), columns: z.literal(3) }).strict(),
  z.object({ kind: z.literal('4x3'), rows: z.literal(3), columns: z.literal(4) }).strict(),
  z.object({ kind: z.literal('top-loader'), rows: z.literal(2), columns: z.literal(2) }).strict(),
]);
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

export const collectionSetRequestSchema = mutationRequestSchema
  .extend({
    expectedRevision: z.number().int().nonnegative(),
    quantity: z.number().int().min(0).max(9999),
    notes: z.string().max(2000).nullable(),
  })
  .strict();
export type CollectionSetRequest = z.infer<typeof collectionSetRequestSchema>;

export const collectionIncrementRequestSchema = mutationRequestSchema
  .extend({ delta: z.number().int().min(1).max(9999) })
  .strict();
export type CollectionIncrementRequest = z.infer<typeof collectionIncrementRequestSchema>;

export const collectionNotesPatchRequestSchema = mutationRequestSchema
  .extend({
    expectedRevision: z.number().int().nonnegative(),
    notes: z.string().max(2000).nullable(),
  })
  .strict();
export type CollectionNotesPatchRequest = z.infer<typeof collectionNotesPatchRequestSchema>;

export const collectionMutationResultSchema = z
  .object({ state: collectionStateSchema, replayed: z.boolean() })
  .strict();
export type CollectionMutationResult = z.infer<typeof collectionMutationResultSchema>;

export const binderSlotSchema = z
  .object({
    pageId: z.string().trim().min(1).max(128),
    row: z.number().int().nonnegative(),
    column: z.number().int().nonnegative(),
    cardId: cardIdSchema.nullable(),
  })
  .strict();
export type BinderSlot = z.infer<typeof binderSlotSchema>;

export const binderStatusSchema = z.enum(['draft', 'active', 'archived']);
export type BinderStatus = z.infer<typeof binderStatusSchema>;

export const binderViewSchema = z
  .object({
    id: z.string().trim().min(1).max(128),
    name: z.string().trim().min(1).max(120),
    activeVersionId: z.string().trim().min(1).max(128).nullable(),
    latestVersionId: z.string().trim().min(1).max(128).nullable(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type BinderView = z.infer<typeof binderViewSchema>;

export const binderShortageSchema = z
  .object({
    cardId: cardIdSchema,
    required: z.number().int().positive(),
    owned: z.number().int().nonnegative(),
    missing: z.number().int().positive(),
  })
  .strict();
export type BinderShortage = z.infer<typeof binderShortageSchema>;

export const binderVersionSummarySchema = z
  .object({
    id: z.string().trim().min(1).max(128),
    binderId: z.string().trim().min(1).max(128),
    versionNumber: z.number().int().positive(),
    status: binderStatusSchema,
    layout: binderLayoutSchema,
    revision: z.number().int().positive(),
    pageCount: z.number().int().positive(),
  })
  .strict();
export type BinderVersionSummary = z.infer<typeof binderVersionSummarySchema>;

export const binderPageSchema = z
  .object({
    id: z.string().trim().min(1).max(128),
    position: z.number().int().nonnegative(),
    slots: z.array(binderSlotSchema).max(400),
  })
  .strict();
export type BinderPage = z.infer<typeof binderPageSchema>;

export const binderVersionPagesSchema = z
  .object({
    version: binderVersionSummarySchema,
    pages: z.array(binderPageSchema).max(4),
    nextPage: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type BinderVersionPages = z.infer<typeof binderVersionPagesSchema>;

export const binderMutationResultSchema = z
  .object({
    version: binderVersionSummarySchema,
    pages: z.array(binderPageSchema).max(2),
  })
  .strict();
export type BinderMutationResult = z.infer<typeof binderMutationResultSchema>;

export const binderRevisionRequestSchema = z
  .object({ expectedRevision: z.number().int().positive() })
  .strict();
export type BinderRevisionRequest = z.infer<typeof binderRevisionRequestSchema>;

export const binderSlotLocationSchema = z
  .object({
    page: z.number().int().nonnegative(),
    row: z.number().int().nonnegative(),
    column: z.number().int().nonnegative(),
  })
  .strict();
export type BinderSlotLocation = z.infer<typeof binderSlotLocationSchema>;

export const binderSlotSetRequestSchema = binderSlotLocationSchema
  .extend({
    expectedRevision: z.number().int().positive(),
    cardId: cardIdSchema.nullable(),
  })
  .strict();
export type BinderSlotSetRequest = z.infer<typeof binderSlotSetRequestSchema>;

export const binderSlotSwapRequestSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    source: binderSlotLocationSchema,
    target: binderSlotLocationSchema,
  })
  .strict();
export type BinderSlotSwapRequest = z.infer<typeof binderSlotSwapRequestSchema>;

export const catalogueCardViewSchema = catalogueBriefSchema.extend({
  imageHighUrl: artUrlSchema,
  collection: collectionStateSchema.nullable(),
  price: priceBaselineSchema,
});
export type CatalogueCardView = z.infer<typeof catalogueCardViewSchema>;

export const catalogueDetailViewSchema = catalogueDetailSchema.extend({
  collection: collectionStateSchema.nullable(),
  price: priceBaselineSchema,
});
export type CatalogueDetailView = z.infer<typeof catalogueDetailViewSchema>;
