import type {
  BinderBookmarkSetRequest,
  BinderLayout,
  BinderCopyChoice,
  BinderSlotLocation,
  CollectionIncrementRequest,
  CollectionNotesPatchRequest,
  CollectionSetRequest,
} from '@pokedex/shared';
import {
  cardCategorySchema,
  frameTypeSchema,
  languageSchema,
  rarityKeySchema,
  regionSchema,
} from '@pokedex/shared';
import { getArtResponse, listArtManifest } from '../../lib/art';
import {
  createBinder,
  deleteBinder,
  discardBinderDraftVersion,
  patchBinderDisplay,
  getCardBinderMatches,
  listInactiveBinderTargets,
  placeCard,
  addCardsToBinderVersion,
  cloneBinderVersion,
  activateBinderVersion,
  addBinderPage,
  arrangeBinderVersion,
  deleteBinderPage,
  getBinderBookmarks,
  getBinderVersion,
  getBinderInsertDestinations,
  getBinderVersionShortages,
  getBinderAssignmentCandidates,
  getBinderPlannerSummary,
  listBinders,
  reorderBinderPages,
  removeBinderBookmark,
  setBinderBookmark,
  setBinderSlot,
  setBinderSlots,
  swapBinderSlots,
  insertBinderEntries,
  compactRemoveBinderEntry,
  moveBinderEntryByOffset,
  setBinderEntryAssignment,
  setBinderEntryPageBreak,
  reserveBinderPage,
  resizeBinderCapacity,
  insertFullPokedex,
  previewFullPokedexInsert,
  type ArrangementMode,
} from '../../lib/binders';
import {
  getCardDetail,
  listCatalogueSets,
  searchCards,
  setCatalogueSetCode,
  type CatalogueFilters,
} from '../../lib/catalogue';
import {
  incrementCollectionQuantity,
  patchCollectionNotes,
  removeCollectionCopy,
  type CollectionRemoveInput,
  setCollectionState,
} from '../../lib/collection';
import { ApplicationError } from '../../lib/log';
import { asPositiveInt } from '../../lib/db';

export interface RepeatedCatalogueFilters {
  type?: string[];
  rarity?: string[];
  set?: string[];
}

export function catalogueFilters(
  query: Record<string, string>,
  includeOwned: boolean,
  repeated: RepeatedCatalogueFilters = {},
): CatalogueFilters {
  if (query.sort !== undefined && query.sort !== 'release')
    throw new ApplicationError('invalid_filter', 400);
  const language = query.language ? languageSchema.safeParse(query.language) : undefined;
  const category = query.category ? cardCategorySchema.safeParse(query.category) : undefined;
  const region = query.region ? regionSchema.safeParse(query.region) : undefined;
  if (
    (language && !language.success) ||
    (category && !category.success) ||
    (region && !region.success)
  )
    throw new ApplicationError('invalid_filter', 400);
  const frameTypes = repeated.type?.length
    ? repeated.type.map((value) => {
        const parsed = frameTypeSchema.safeParse(value);
        if (!parsed.success) throw new ApplicationError('invalid_filter', 400);
        return parsed.data;
      })
    : undefined;
  const rarityKeys = repeated.rarity?.length
    ? repeated.rarity.map((value) => {
        const parsed = rarityKeySchema.safeParse(value);
        if (!parsed.success) throw new ApplicationError('invalid_filter', 400);
        return parsed.data;
      })
    : undefined;
  const setIds = repeated.set?.length ? repeated.set : undefined;
  const owned =
    !includeOwned || query.owned === undefined
      ? undefined
      : query.owned === 'true'
        ? true
        : query.owned === 'false'
          ? false
          : null;
  if (owned === null) throw new ApplicationError('invalid_filter', 400);
  const pokedexNumber = query.pokedexNumber ? Number.parseInt(query.pokedexNumber, 10) : undefined;
  if (
    pokedexNumber !== undefined &&
    (!Number.isInteger(pokedexNumber) || pokedexNumber < 1 || pokedexNumber > 1025)
  )
    throw new ApplicationError('invalid_filter', 400);
  return {
    sort: query.sort === 'release' ? 'release' : undefined,
    query: query.q,
    includePokemonNumber: query.includePokemonNumber === 'true',
    language: language?.success ? language.data : undefined,
    category: category?.success ? category.data : undefined,
    setId: query.setId,
    setIds,
    species: pokedexNumber === undefined ? query.species : undefined,
    pokedexNumber,
    region: region?.success ? region.data : undefined,
    frameTypes,
    rarityKeys,
    owned,
    limit: asPositiveInt(query.limit, 50, 100),
    offset: Math.max(0, Number.parseInt(query.offset ?? '0', 10) || 0),
    cursor: query.cursor ?? null,
  };
}

export function ownerOperations(env: CloudflareEnv, ownerId: string) {
  return {
    searchCatalogue: (filters: CatalogueFilters) => searchCards(env.DB, ownerId, filters),
    async cardDetail(cardId: string, includePokemonNumber = false) {
      const card = await getCardDetail(env.DB, ownerId, cardId, includePokemonNumber);
      if (!card) throw new ApplicationError('card_not_found', 404);
      return card;
    },
    setCollection(
      cardId: string,
      input: Omit<CollectionSetRequest, 'expectedRevision'> & { expectedRevision?: number },
    ) {
      return setCollectionState(env.DB, ownerId, { ...input, cardId });
    },
    incrementCollection(cardId: string, input: CollectionIncrementRequest) {
      return incrementCollectionQuantity(env.DB, ownerId, { ...input, cardId });
    },
    patchCollectionNotes(cardId: string, input: CollectionNotesPatchRequest) {
      return patchCollectionNotes(env.DB, ownerId, { ...input, cardId });
    },
    listBinders: () => listBinders(env.DB, ownerId),
    binderInsertDestinations: (versionId: string, cardId?: string) =>
      getBinderInsertDestinations(env.DB, ownerId, versionId, cardId),
    deleteBinder: (binderId: string, confirmationName: string) =>
      deleteBinder(env.DB, ownerId, binderId, confirmationName),
    patchBinderDisplay: (
      binderId: string,
      patch: { peekColumns?: 0 | 1 | 2; showFrame?: boolean },
    ) => patchBinderDisplay(env.DB, ownerId, binderId, patch),
    cardBinderMatches: (cardId: string) => getCardBinderMatches(env.DB, ownerId, cardId),
    inactiveBinderTargets: () => listInactiveBinderTargets(env.DB, ownerId),
    placeCard: (
      cardId: string,
      binderId: string,
      slotId: string,
      addCopy: boolean,
      expectedRevision: number,
    ) => placeCard(env.DB, ownerId, cardId, binderId, slotId, addCopy, expectedRevision),
    removeCollectionCopy: (cardId: string, input: CollectionRemoveInput) =>
      removeCollectionCopy(env.DB, ownerId, cardId, input),
    binderVersion: (versionId: string, page = 0, limit = 1) =>
      getBinderVersion(env.DB, ownerId, versionId, page, limit),
    binderShortages: (versionId: string, offset = 0, limit = 100) =>
      getBinderVersionShortages(env.DB, ownerId, versionId, offset, limit),
    binderAssignmentCandidates: (versionId: string, location: BinderSlotLocation) =>
      getBinderAssignmentCandidates(env.DB, ownerId, versionId, location),
    binderPlannerSummary: (versionId: string) =>
      getBinderPlannerSummary(env.DB, ownerId, versionId),
    createBinder: (name: string, layout: BinderLayout, capacity?: number) =>
      createBinder(env.DB, ownerId, name, layout, capacity),
    addCardsToBinderVersion: (versionId: string, cardIds: string[], expectedRevision: number) =>
      addCardsToBinderVersion(env.DB, ownerId, versionId, cardIds, expectedRevision),
    cloneBinderVersion: (versionId: string, expectedRevision: number) =>
      cloneBinderVersion(env.DB, ownerId, versionId, expectedRevision),
    discardBinderDraftVersion: (versionId: string, expectedRevision: number) =>
      discardBinderDraftVersion(env.DB, ownerId, versionId, expectedRevision),
    activateBinderVersion: (versionId: string, expectedRevision: number) =>
      activateBinderVersion(env.DB, ownerId, versionId, expectedRevision),
    arrangeBinderVersion: (versionId: string, mode: ArrangementMode, expectedRevision: number) =>
      arrangeBinderVersion(env.DB, ownerId, versionId, mode, expectedRevision),
    addBinderPage: (versionId: string, expectedRevision: number) =>
      addBinderPage(env.DB, ownerId, versionId, expectedRevision),
    deleteBinderPage: (versionId: string, pageId: string, expectedRevision: number) =>
      deleteBinderPage(env.DB, ownerId, versionId, pageId, expectedRevision),
    reorderBinderPages: (versionId: string, pageIds: string[], expectedRevision: number) =>
      reorderBinderPages(env.DB, ownerId, versionId, pageIds, expectedRevision),
    setBinderSlot(
      versionId: string,
      location: BinderSlotLocation,
      cardId: string | null,
      expectedRevision: number,
      copyChoice?: BinderCopyChoice,
    ) {
      return setBinderSlot(
        env.DB,
        ownerId,
        versionId,
        location.page,
        location.row,
        location.column,
        cardId,
        expectedRevision,
        copyChoice,
      );
    },
    setBinderSlots: (
      versionId: string,
      assignments: Array<BinderSlotLocation & { cardId: string }>,
      expectedRevision: number,
    ) => setBinderSlots(env.DB, ownerId, versionId, assignments, expectedRevision),
    swapBinderSlots(
      versionId: string,
      source: BinderSlotLocation,
      target: BinderSlotLocation,
      expectedRevision: number,
    ) {
      return swapBinderSlots(env.DB, ownerId, versionId, source, target, expectedRevision);
    },
    insertBinderEntries: (
      versionId: string,
      at: BinderSlotLocation,
      entries: import('@pokedex/shared').BinderEntry[],
      expectedRevision: number,
    ) => insertBinderEntries(env.DB, ownerId, versionId, at, entries, expectedRevision),
    compactRemoveBinderEntry: (
      versionId: string,
      at: BinderSlotLocation,
      expectedRevision: number,
    ) => compactRemoveBinderEntry(env.DB, ownerId, versionId, at, expectedRevision),
    moveBinderEntryByOffset: (
      versionId: string,
      from: BinderSlotLocation,
      offset: number,
      expectedRevision: number,
    ) => moveBinderEntryByOffset(env.DB, ownerId, versionId, from, offset, expectedRevision),
    setBinderEntryAssignment: (
      versionId: string,
      at: BinderSlotLocation,
      cardId: string | null,
      expectedRevision: number,
    ) => setBinderEntryAssignment(env.DB, ownerId, versionId, at, cardId, expectedRevision),
    setBinderEntryPageBreak: (
      versionId: string,
      at: BinderSlotLocation,
      startsNewPage: boolean,
      expectedRevision: number,
    ) => setBinderEntryPageBreak(env.DB, ownerId, versionId, at, startsNewPage, expectedRevision),
    reserveBinderPage: (
      versionId: string,
      page: number,
      reserved: boolean,
      label: string | null,
      expectedRevision: number,
    ) => reserveBinderPage(env.DB, ownerId, versionId, page, reserved, label, expectedRevision),
    binderBookmarks: (versionId: string) => getBinderBookmarks(env.DB, ownerId, versionId),
    setBinderBookmark: (versionId: string, input: BinderBookmarkSetRequest) =>
      setBinderBookmark(env.DB, ownerId, versionId, input),
    removeBinderBookmark: (versionId: string, bookmarkId: string) =>
      removeBinderBookmark(env.DB, ownerId, versionId, bookmarkId),
    resizeBinderCapacity: (versionId: string, capacity: number, expectedRevision: number) =>
      resizeBinderCapacity(env.DB, ownerId, versionId, capacity, expectedRevision),
    insertFullPokedex: (
      versionId: string,
      at: BinderSlotLocation,
      regionPageBreaks: boolean,
      expectedRevision: number,
    ) => insertFullPokedex(env.DB, ownerId, versionId, at, regionPageBreaks, expectedRevision),
    previewFullPokedex: (
      versionId: string,
      at: BinderSlotLocation,
      regionPageBreaks: boolean,
      expectedRevision: number,
    ) =>
      previewFullPokedexInsert(env.DB, ownerId, versionId, at, regionPageBreaks, expectedRevision),
    listSets: () => listCatalogueSets(env.DB),
    setSetCode: (setId: string, code: string | null) => setCatalogueSetCode(env.DB, setId, code),
    artManifest: (cursor: string | null, limit: number) => listArtManifest(env.DB, cursor, limit),
    art: (cardId: string, variant: 'high' | 'low', request: Request) =>
      getArtResponse(env.DB, env.ART, cardId, variant, request),
  };
}
