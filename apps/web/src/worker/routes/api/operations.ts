import type {
  BinderLayout,
  BinderSlotLocation,
  CollectionIncrementRequest,
  CollectionNotesPatchRequest,
  CollectionSetRequest,
} from '@pokedex/shared';
import { getArtResponse, listArtManifest } from '../../lib/art';
import {
  createBinder,
  cloneBinderVersion,
  activateBinderVersion,
  addBinderPage,
  arrangeBinderVersion,
  deleteBinderPage,
  getBinderVersion,
  getBinderVersionShortages,
  listBinders,
  reorderBinderPages,
  setBinderSlot,
  swapBinderSlots,
  type ArrangementMode,
} from '../../lib/binders';
import { getCardDetail, searchCards, type CatalogueFilters } from '../../lib/catalogue';
import {
  incrementCollectionQuantity,
  patchCollectionNotes,
  setCollectionState,
} from '../../lib/collection';
import { ApplicationError } from '../../lib/log';

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
    createBinder: (name: string, layout: BinderLayout) =>
      createBinder(env.DB, ownerId, name, layout),
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
    swapBinderSlots(
      versionId: string,
      source: BinderSlotLocation,
      target: BinderSlotLocation,
      expectedRevision: number,
    ) {
      return swapBinderSlots(env.DB, ownerId, versionId, source, target, expectedRevision);
    },
    artManifest: (cursor: string | null, limit: number) => listArtManifest(env.DB, cursor, limit),
    art: (cardId: string, variant: 'high' | 'low', request: Request) =>
      getArtResponse(env.DB, env.ART, cardId, variant, request),
  };
}
