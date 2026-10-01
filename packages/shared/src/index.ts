import { z } from 'zod';
export * from './binder-search';
import { NATIONAL_POKEDEX_SIZE } from './national-pokedex';
import { FRAME_TYPES, RARITY_KEYS } from './frame';

export * from './artists';
export * from './national-pokedex';
export * from './frame';
export * from './people';

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

export const frameTypeSchema = z.enum(FRAME_TYPES);
export const rarityKeySchema = z.enum(RARITY_KEYS);
const viewFrameFields = {
  frameType: frameTypeSchema.nullable().optional(),
  setCode: z.string().trim().min(1).max(32).nullable().optional(),
  rarityKey: rarityKeySchema.nullable().optional(),
};

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

export const pokemonDiscoveryCategorySchema = z.enum([
  'Kanto',
  'Johto',
  'Hoenn',
  'Sinnoh',
  'Unova',
  'Kalos',
  'Alola',
  'Galar',
  'Hisui',
  'Paldea',
]);

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
    details: z.lazy(() => apiErrorDetailsSchema).optional(),
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
    entryKind: z.enum(['empty', 'reserved', 'exact-card', 'pokemon', 'set']).optional(),
    label: z.string().trim().min(1).max(120).nullable().optional(),
    pokemonNumber: z.number().int().min(1).max(NATIONAL_POKEDEX_SIZE).nullable().optional(),
    // A set target: any card from this set fits. The name and code are for display.
    setId: z.string().trim().min(1).max(128).nullable().optional(),
    setLanguage: languageSchema.nullable().optional(),
    setName: z.string().trim().min(1).max(200).nullable().optional(),
    setCode: z.string().trim().min(1).max(32).nullable().optional(),
    assignedCardId: cardIdSchema.nullable().optional(),
    startsNewPage: z.boolean().optional(),
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
    peekColumns: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
    showFrame: z.boolean().optional(),
    pageSection: z.enum(['reserved', 'bookmark', 'none']).optional(),
  })
  .strict();
export type BinderView = z.infer<typeof binderViewSchema>;

export const binderShortageSchema = z
  .object({
    cardId: cardIdSchema,
    required: z.number().int().positive(),
    owned: z.number().int().nonnegative(),
    assigned: z.number().int().nonnegative().optional(),
    available: z.number().int().nonnegative().optional(),
    missing: z.number().int().positive(),
  })
  .strict();
export type BinderShortage = z.infer<typeof binderShortageSchema>;

export const binderPokemonShortageSchema = z
  .object({
    pokemonNumber: z.number().int().min(1).max(NATIONAL_POKEDEX_SIZE),
    required: z.number().int().positive(),
    owned: z.number().int().nonnegative(),
    assigned: z.number().int().nonnegative().optional(),
    available: z.number().int().nonnegative().optional(),
    missing: z.number().int().positive(),
  })
  .strict();
export type BinderPokemonShortage = z.infer<typeof binderPokemonShortageSchema>;

export const dashboardBinderProgressSchema = z
  .object({
    id: z.string().trim().min(1).max(128),
    name: z.string().trim().min(1).max(120),
    targets: z.number().int().nonnegative(),
    placed: z.number().int().nonnegative(),
    percent: z.number().int().min(0).max(100),
  })
  .strict();
export type DashboardBinderProgress = z.infer<typeof dashboardBinderProgressSchema>;

/** One row in Home's "Still to find" list: an active-binder shortage target,
 * carrying enough to both display it (label) and link back into the catalogue
 * (cardId or pokemonNumber) without the client re-deriving either from the label. */
export const dashboardStillToFindItemSchema = z
  .object({
    kind: z.enum(['exact-card', 'pokemon']),
    label: z.string().trim().min(1).max(200),
    cardId: cardIdSchema.nullable(),
    pokemonNumber: z.number().int().min(1).max(NATIONAL_POKEDEX_SIZE).nullable(),
    missing: z.number().int().positive(),
    binderId: z.string().trim().min(1).max(128).nullable(),
    binderName: z.string().trim().min(1).max(120).nullable(),
  })
  .strict();
export type DashboardStillToFindItem = z.infer<typeof dashboardStillToFindItemSchema>;

export const binderReadyToPlaceSchema = z
  .object({
    exactTargets: z.number().int().nonnegative(),
    pokemonTargets: z.number().int().nonnegative(),
  })
  .strict();
export type BinderReadyToPlace = z.infer<typeof binderReadyToPlaceSchema>;

export const binderAssignmentCandidateSchema = z
  .object({
    cardId: cardIdSchema,
    name: z.string().trim().min(1).max(200),
    setName: z.string().trim().min(1).max(200),
    number: z.string().trim().min(1).max(32),
    language: languageSchema,
    owned: z.number().int().nonnegative(),
    assigned: z.number().int().nonnegative(),
    available: z.number().int().nonnegative(),
    ...viewFrameFields,
  })
  .strict();
export const binderAssignmentCandidatesSchema = z
  .object({ candidates: z.array(binderAssignmentCandidateSchema).max(500) })
  .strict();
export type BinderAssignmentCandidate = z.infer<typeof binderAssignmentCandidateSchema>;

export const binderVersionSummarySchema = z
  .object({
    id: z.string().trim().min(1).max(128),
    binderId: z.string().trim().min(1).max(128),
    versionNumber: z.number().int().positive(),
    status: binderStatusSchema,
    layout: binderLayoutSchema,
    revision: z.number().int().positive(),
    pageCount: z.number().int().positive(),
    capacity: z.number().int().positive().optional(),
  })
  .strict();
export type BinderVersionSummary = z.infer<typeof binderVersionSummarySchema>;

export const binderPageSchema = z
  .object({
    id: z.string().trim().min(1).max(128),
    position: z.number().int().nonnegative(),
    kind: z.enum(['slots', 'reserved']).optional(),
    label: z.string().trim().min(1).max(120).nullable().optional(),
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
    anchor: z
      .object({
        page: z.number().int().nonnegative(),
        row: z.number().int().nonnegative(),
        column: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
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

export const binderInsertDestinationsSchema = z
  .object({
    versionId: z.string(),
    revision: z.number().int().positive(),
    capacity: z.number().int().positive(),
    requiredCapacity: z.number().int().positive(),
    maxCapacity: z.number().int().positive(),
    matches: z
      .array(
        binderSlotLocationSchema.extend({
          cardId: cardIdSchema.nullable(),
          pokemonNumber: z.number().int().nullable(),
          assignedCardId: cardIdSchema.nullable(),
        }),
      )
      .max(100),
    matchCount: z.number().int().nonnegative(),
    appendAt: binderSlotLocationSchema.nullable(),
  })
  .strict();
export type BinderInsertDestinations = z.infer<typeof binderInsertDestinationsSchema>;

export const binderCopyChoiceSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('none') }).strict(),
  z.object({ action: z.literal('existing') }).strict(),
  z
    .object({
      action: z.literal('add'),
      expectedCollectionRevision: z.number().int().nonnegative(),
    })
    .strict(),
]);
export type BinderCopyChoice = z.infer<typeof binderCopyChoiceSchema>;

export const binderSlotSetRequestSchema = binderSlotLocationSchema
  .extend({
    expectedRevision: z.number().int().positive(),
    cardId: cardIdSchema.nullable(),
    copyChoice: binderCopyChoiceSchema.optional(),
  })
  .strict()
  .refine((input) => input.cardId !== null || input.copyChoice === undefined);
export type BinderSlotSetRequest = z.infer<typeof binderSlotSetRequestSchema>;

export const binderSlotSwapRequestSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    source: binderSlotLocationSchema,
    target: binderSlotLocationSchema,
  })
  .strict();
export type BinderSlotSwapRequest = z.infer<typeof binderSlotSwapRequestSchema>;

export const binderEntrySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('empty') }).strict(),
  z
    .object({
      kind: z.literal('reserved'),
      label: z.string().trim().min(1).max(120).nullable().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('exact-card'),
      cardId: cardIdSchema,
      startsNewPage: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      kind: z.literal('pokemon'),
      pokemonNumber: z.number().int().min(1).max(NATIONAL_POKEDEX_SIZE),
      startsNewPage: z.boolean().default(false),
    })
    .strict(),
  // Any card from one set, the way a Pokémon target is any printing of one Pokémon.
  z
    .object({
      kind: z.literal('set'),
      setId: z.string().trim().min(1).max(128),
      setLanguage: languageSchema,
      startsNewPage: z.boolean().default(false),
    })
    .strict(),
]);
export type BinderEntry = z.infer<typeof binderEntrySchema>;

export const binderInsertRequestSchema = binderRevisionRequestSchema
  .extend({
    at: binderSlotLocationSchema,
    entries: z.array(binderEntrySchema).min(1).max(NATIONAL_POKEDEX_SIZE),
  })
  .strict();
export const binderFillPageRequestSchema = binderRevisionRequestSchema
  .extend({
    page: z.number().int().nonnegative(),
    target: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('pokemon'),
          pokemonNumber: z.number().int().min(1).max(NATIONAL_POKEDEX_SIZE),
        })
        .strict(),
      z
        .object({
          kind: z.literal('set'),
          setId: z.string().trim().min(1).max(128),
          setLanguage: languageSchema,
        })
        .strict(),
    ]),
  })
  .strict();
export const binderCompactRemoveRequestSchema = binderRevisionRequestSchema
  .extend({ at: binderSlotLocationSchema })
  .strict();
export const binderPasteRequestSchema = binderRevisionRequestSchema
  .extend({
    at: binderSlotLocationSchema,
    cardIds: z.array(cardIdSchema).min(1).max(2000),
    mode: z.enum(['insert', 'replace']),
    confirmReplace: z.boolean().default(false),
  })
  .strict();
export type BinderPasteRequest = z.infer<typeof binderPasteRequestSchema>;
export const binderPastePreviewSchema = z
  .object({
    revision: z.number().int().positive(),
    count: z.number().int().positive(),
    replacedTargets: z.number().int().nonnegative(),
    unassignedCopies: z.number().int().nonnegative(),
    shiftedTargets: z.number().int().nonnegative(),
    at: binderSlotLocationSchema,
    end: binderSlotLocationSchema,
    reservedPage: z.boolean(),
  })
  .strict();
export type BinderPastePreview = z.infer<typeof binderPastePreviewSchema>;
export const binderOffsetMoveRequestSchema = binderRevisionRequestSchema
  .extend({
    from: binderSlotLocationSchema,
    offset: z
      .number()
      .int()
      .min(-120_000)
      .max(120_000)
      .refine((value) => value !== 0),
  })
  .strict();
export const binderAssignRequestSchema = binderRevisionRequestSchema
  .extend({
    at: binderSlotLocationSchema,
    cardId: cardIdSchema.nullable(),
  })
  .strict();
export const binderPageBreakRequestSchema = binderRevisionRequestSchema
  .extend({
    at: binderSlotLocationSchema,
    startsNewPage: z.boolean(),
  })
  .strict();
export const binderReservePageRequestSchema = binderRevisionRequestSchema
  .extend({
    page: z.number().int().nonnegative(),
    reserved: z.boolean(),
    label: z.string().trim().min(1).max(120).nullable().optional(),
  })
  .strict();

// 'page' is a named ordinary page: it bookmarks the page like a reserved page does,
// without reserving its pockets.
export const binderBookmarkKindSchema = z.enum(['pocket', 'reserved-page', 'page']);
export type BinderBookmarkKind = z.infer<typeof binderBookmarkKindSchema>;

export const binderBookmarkSchema = z
  .object({
    id: z.string().trim().min(1).max(128),
    kind: binderBookmarkKindSchema,
    name: z.string().trim().min(1).max(120),
    pageId: z.string().trim().min(1).max(128),
    at: binderSlotLocationSchema,
  })
  .strict();
export type BinderBookmark = z.infer<typeof binderBookmarkSchema>;

export const binderBookmarkSetRequestSchema = z
  .object({
    pageId: z.string().trim().min(1).max(128),
    row: z.number().int().nonnegative(),
    column: z.number().int().nonnegative(),
    name: z.string().trim().min(1).max(120),
  })
  .strict();
export type BinderBookmarkSetRequest = z.infer<typeof binderBookmarkSetRequestSchema>;

export const binderCapacityRequestSchema = binderRevisionRequestSchema
  .extend({
    capacity: z.number().int().positive(),
  })
  .strict();
export const binderFullPokedexRequestSchema = binderRevisionRequestSchema
  .extend({
    at: binderSlotLocationSchema,
    regionPageBreaks: z.boolean().default(true),
  })
  .strict();

export const binderCapacityErrorSchema = z
  .object({
    currentCapacity: z.number().int().positive(),
    requiredCapacity: z.number().int().positive(),
    additionalPockets: z.number().int().positive(),
    pageIncrement: z.number().int().positive(),
  })
  .strict();
export type BinderCapacityError = z.infer<typeof binderCapacityErrorSchema>;

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
export type BinderPlannerSummary = z.infer<typeof binderPlannerSummarySchema>;

export const binderFullPokedexPreviewSchema = z
  .object({
    currentCapacity: z.number().int().positive(),
    requiredCapacity: z.number().int().positive(),
    additionalPockets: z.number().int().nonnegative(),
    pageIncrement: z.number().int().positive(),
    generatedPadding: z.number().int().nonnegative(),
  })
  .strict();
export type BinderFullPokedexPreview = z.infer<typeof binderFullPokedexPreviewSchema>;

export const activeBinderAssignmentLocationSchema = z
  .object({
    binderId: z.string().trim().min(1).max(128),
    versionId: z.string().trim().min(1).max(128),
    page: z.number().int().nonnegative(),
    row: z.number().int().nonnegative(),
    column: z.number().int().nonnegative(),
  })
  .strict();
export type ActiveBinderAssignmentLocation = z.infer<typeof activeBinderAssignmentLocationSchema>;

export const activeBinderAssignmentsErrorSchema = z
  .object({ activeAssignments: z.array(activeBinderAssignmentLocationSchema).min(1) })
  .strict();
export type ActiveBinderAssignmentsError = z.infer<typeof activeBinderAssignmentsErrorSchema>;

export const catalogueCardViewSchema = catalogueBriefSchema.extend({
  pokedexNumber: z.number().int().min(1).max(NATIONAL_POKEDEX_SIZE).nullable().optional(),
  imageHighUrl: artUrlSchema,
  collection: collectionStateSchema.nullable(),
  price: priceBaselineSchema,
  ...viewFrameFields,
});
export type CatalogueCardView = z.infer<typeof catalogueCardViewSchema>;

export const catalogueDetailViewSchema = catalogueDetailSchema.extend({
  pokedexNumber: z.number().int().min(1).max(NATIONAL_POKEDEX_SIZE).nullable().optional(),
  collection: collectionStateSchema.nullable(),
  price: priceBaselineSchema,
  ...viewFrameFields,
});
export type CatalogueDetailView = z.infer<typeof catalogueDetailViewSchema>;

// Region reuses the existing discovery-category vocabulary; it's just the
// catalogue/search-facing name for it.
export const regionSchema = pokemonDiscoveryCategorySchema;

export const framePaletteSchema = z
  .record(frameTypeSchema, z.string())
  .refine((value) => Object.values(value).every((colour) => /^#[0-9a-f]{6}$/iu.test(colour)), {
    message: 'invalid_frame_colour',
  });
export type FramePalette = z.infer<typeof framePaletteSchema>;

export const settingsResponseSchema = z.object({ framePalette: framePaletteSchema }).strict();
export type SettingsResponse = z.infer<typeof settingsResponseSchema>;

export const framePalettePutRequestSchema = z.object({ palette: framePaletteSchema }).strict();
export type FramePalettePutRequest = z.infer<typeof framePalettePutRequestSchema>;

export const peekColumnsSchema = z.union([z.literal(0), z.literal(1), z.literal(2)]);
export type PeekColumns = z.infer<typeof peekColumnsSchema>;

/** What a binder page's header names on its right: the nearest reserved page before
 * it, the nearest bookmark, or nothing. */
export const pageSectionSchema = z.enum(['reserved', 'bookmark', 'none']);
export type PageSection = z.infer<typeof pageSectionSchema>;

export const binderDisplayPatchRequestSchema = z
  .object({
    peekColumns: peekColumnsSchema.optional(),
    showFrame: z.boolean().optional(),
    pageSection: pageSectionSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.peekColumns !== undefined ||
      value.showFrame !== undefined ||
      value.pageSection !== undefined,
  );
export type BinderDisplayPatchRequest = z.infer<typeof binderDisplayPatchRequestSchema>;

export const collectionRemoveRequestSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('pocket'), slotId: z.string().trim().min(1).max(128) }).strict(),
  z.object({ source: z.literal('loose') }).strict(),
  z
    .object({ source: z.literal('miscount'), slotId: z.string().trim().min(1).max(128).optional() })
    .strict(),
]);
export type CollectionRemoveRequest = z.infer<typeof collectionRemoveRequestSchema>;

export const collectionRemoveCandidateSchema = z
  .object({
    slotId: z.string().trim().min(1).max(128),
    binderId: z.string().trim().min(1).max(128),
    binderName: z.string().trim().min(1).max(120),
    page: z.number().int().nonnegative(),
    row: z.number().int().nonnegative(),
    column: z.number().int().nonnegative(),
  })
  .strict();
export const collectionRemoveMiscountCandidatesErrorSchema = z
  .object({ candidates: z.array(collectionRemoveCandidateSchema).min(1) })
  .strict();
export type CollectionRemoveMiscountCandidatesError = z.infer<
  typeof collectionRemoveMiscountCandidatesErrorSchema
>;

export const slotRefSchema = z
  .object({
    slotId: z.string().trim().min(1).max(128),
    page: z.number().int().nonnegative(),
    row: z.number().int().nonnegative(),
    col: z.number().int().nonnegative(),
    pocketIndex: z.number().int().nonnegative(),
  })
  .strict();
export type SlotRef = z.infer<typeof slotRefSchema>;

export const binderCardMatchesSchema = z
  .object({
    binderId: z.string().trim().min(1).max(128),
    name: z.string().trim().min(1).max(120),
    exactTargets: z.array(slotRefSchema),
    pokemonTargets: z.array(slotRefSchema),
    setTargets: z.array(slotRefSchema).default([]),
    placed: z.array(slotRefSchema),
    nextTarget: slotRefSchema.nullable(),
    endDestination: slotRefSchema.nullable(),
  })
  .strict();
export type BinderCardMatches = z.infer<typeof binderCardMatchesSchema>;
export const cardBinderMatchesResponseSchema = z
  .object({ binders: z.array(binderCardMatchesSchema) })
  .strict();

export const cardPlaceRequestSchema = z
  .object({
    binderId: z.string().trim().min(1).max(128),
    slotId: z.string().trim().min(1).max(128),
    addCopy: z.boolean(),
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();
export type CardPlaceRequest = z.infer<typeof cardPlaceRequestSchema>;

export const inactiveBinderTargetSchema = z
  .object({
    binderId: z.string().trim().min(1).max(128),
    binderName: z.string().trim().min(1).max(120),
    page: z.number().int().nonnegative(),
    row: z.number().int().nonnegative(),
    column: z.number().int().nonnegative(),
    cardId: cardIdSchema,
    cardName: z.string().trim().min(1).max(200),
    setName: z.string().trim().min(1).max(200),
    number: z.string().trim().min(1).max(32),
  })
  .strict();
export type InactiveBinderTarget = z.infer<typeof inactiveBinderTargetSchema>;
export const inactiveBinderTargetsResponseSchema = z
  .object({ targets: z.array(inactiveBinderTargetSchema) })
  .strict();

export const setCodeSourceSchema = z.enum(['tcgdex', 'owner']);
export type SetCodeSource = z.infer<typeof setCodeSourceSchema>;

export const catalogueSetSchema = z
  .object({
    setId: z.string().trim().min(1).max(128),
    setName: z.string().trim().min(1).max(200),
    language: languageSchema,
    releaseDate: z.string().date().nullable(),
    cardCount: z.number().int().nonnegative(),
    code: z.string().trim().min(1).max(16).nullable(),
    codeSource: setCodeSourceSchema.nullable(),
  })
  .strict();
export type CatalogueSet = z.infer<typeof catalogueSetSchema>;

export const setCodeClashSchema = z
  .object({ code: z.string().trim().min(1).max(16), setIds: z.array(z.string().min(1)).min(2) })
  .strict();
export type SetCodeClash = z.infer<typeof setCodeClashSchema>;

export const catalogueSetsResponseSchema = z
  .object({ sets: z.array(catalogueSetSchema), codeClashes: z.array(setCodeClashSchema) })
  .strict();
export type CatalogueSetsResponse = z.infer<typeof catalogueSetsResponseSchema>;

// The same shape the National Pokédex coverage representative uses (see
// listNationalPokedexCoverage), so the Illustrators screen can hand it straight to
// CardFrame without a translation step.
export const illustratorRepresentativeSchema = z
  .object({
    id: cardIdSchema,
    name: z.string().trim().min(1).max(200),
    imageLowUrl: artUrlSchema,
    frameType: frameTypeSchema.nullable(),
    setCode: z.string().trim().min(1).max(32).nullable(),
    number: z.string().trim().min(1).max(32),
    rarityKey: rarityKeySchema.nullable(),
    pokedexNumber: z.number().int().min(1).max(NATIONAL_POKEDEX_SIZE).nullable(),
  })
  .strict();
export type IllustratorRepresentative = z.infer<typeof illustratorRepresentativeSchema>;

export const illustratorSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    cardCount: z.number().int().positive(),
    ownedCount: z.number().int().nonnegative(),
    favorite: z.boolean(),
    representative: illustratorRepresentativeSchema,
  })
  .strict();
export type Illustrator = z.infer<typeof illustratorSchema>;

export const illustratorFavoriteRequestSchema = z
  .object({ name: z.string().trim().min(1).max(200), favorite: z.boolean() })
  .strict();
export type IllustratorFavoriteRequest = z.infer<typeof illustratorFavoriteRequestSchema>;

export const illustratorsResponseSchema = z
  .object({ illustrators: z.array(illustratorSchema) })
  .strict();
export type IllustratorsResponse = z.infer<typeof illustratorsResponseSchema>;

export const setCodePatchRequestSchema = z
  .object({
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9-]{1,8}$/u)
      .nullable(),
  })
  .strict();
export type SetCodePatchRequest = z.infer<typeof setCodePatchRequestSchema>;

// Defined once every member schema exists; apiErrorSchema reaches this via
// z.lazy(), so its position here (after those schemas) is safe.
export const apiErrorDetailsSchema = z.union([
  binderCapacityErrorSchema,
  activeBinderAssignmentsErrorSchema,
  collectionRemoveMiscountCandidatesErrorSchema,
]);
export type ApiErrorDetails = z.infer<typeof apiErrorDetailsSchema>;
