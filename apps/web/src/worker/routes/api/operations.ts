import type {
  BinderLayout,
  BinderSlotLocation,
  CollectionIncrementRequest,
  CollectionNotesPatchRequest,
  CollectionSetRequest,
} from '@pokedex/shared';
import { cardCategorySchema, languageSchema } from '@pokedex/shared';
import { getArtResponse, listArtManifest } from '../../lib/art';
import {
  createBinder,
  addCardsToBinderVersion,
  cloneBinderVersion,
  activateBinderVersion,
  addBinderPage,
  arrangeBinderVersion,
  deleteBinderPage,
  getBinderVersion,
  getBinderVersionShortages,
  getBinderAssignmentCandidates,
  listBinders,
  reorderBinderPages,
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
  type ArrangementMode,
} from '../../lib/binders';
import { getCardDetail, searchCards, type CatalogueFilters } from '../../lib/catalogue';
import {
  incrementCollectionQuantity,
  patchCollectionNotes,
  setCollectionState,
} from '../../lib/collection';
import { ApplicationError } from '../../lib/log';
import { asPositiveInt } from '../../lib/db';

export function catalogueFilters(
  query: Record<string, string>,
  includeOwned: boolean,
): CatalogueFilters {
  const language = query.language ? languageSchema.safeParse(query.language) : undefined;
  const category = query.category ? cardCategorySchema.safeParse(query.category) : undefined;
  if ((language && !language.success) || (category && !category.success))
    throw new ApplicationError('invalid_filter', 400);
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
    query: query.q,
    language: language?.success ? language.data : undefined,
    category: category?.success ? category.data : undefined,
    setId: query.setId,
    species: pokedexNumber === undefined ? query.species : undefined,
    pokedexNumber,
    owned,
    limit: asPositiveInt(query.limit, 50, 100),
    offset: Math.max(0, Number.parseInt(query.offset ?? '0', 10) || 0),
    cursor: query.cursor ?? null,
  };
}

export function ownerOperations(env: CloudflareEnv, ownerId: string) {
  return {
    searchCatalogue: (filters: CatalogueFilters) => searchCards(env.DB, ownerId, filters),
    async cardDetail(cardId: string) {
      const card = await getCardDetail(env.DB, ownerId, cardId);
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
    binderVersion: (versionId: string, page = 0, limit = 1) =>
      getBinderVersion(env.DB, ownerId, versionId, page, limit),
    binderShortages: (versionId: string, offset = 0, limit = 100) =>
      getBinderVersionShortages(env.DB, ownerId, versionId, offset, limit),
    binderAssignmentCandidates: (versionId: string, location: BinderSlotLocation) =>
      getBinderAssignmentCandidates(env.DB, ownerId, versionId, location),
    createBinder: (name: string, layout: BinderLayout, capacity?: number) =>
      createBinder(env.DB, ownerId, name, layout, capacity),
    addCardsToBinderVersion: (versionId: string, cardIds: string[], expectedRevision: number) =>
      addCardsToBinderVersion(env.DB, ownerId, versionId, cardIds, expectedRevision),
    cloneBinderVersion: (versionId: string, expectedRevision: number) =>
      cloneBinderVersion(env.DB, ownerId, versionId, expectedRevision),
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
    resizeBinderCapacity: (versionId: string, capacity: number, expectedRevision: number) =>
      resizeBinderCapacity(env.DB, ownerId, versionId, capacity, expectedRevision),
    insertFullPokedex: (
      versionId: string,
      at: BinderSlotLocation,
      regionPageBreaks: boolean,
      expectedRevision: number,
    ) => insertFullPokedex(env.DB, ownerId, versionId, at, regionPageBreaks, expectedRevision),
    artManifest: (cursor: string | null, limit: number) => listArtManifest(env.DB, cursor, limit),
    art: (cardId: string, variant: 'high' | 'low', request: Request) =>
      getArtResponse(env.DB, env.ART, cardId, variant, request),
  };
}
