import type { APIRequestContext } from '@playwright/test';
import type { BinderCardMatches, CatalogueCardView } from '@pokedex/shared';
import * as api from './api';

/**
 * Fixture discovery for a suite that runs against a disposable copy of Gordon's real
 * collection rather than a synthetic seed: every scenario finds (or, where the API
 * allows it, builds) the card/binder state it needs at run time instead of hard-coding
 * an id from one particular snapshot of the database.
 */

export async function findMissingCard(request: APIRequestContext): Promise<CatalogueCardView> {
  const result = await api.searchCatalogue(request, { owned: 'missing', page: 1 });
  const card = result.cards[0];
  if (!card)
    throw new Error(
      'No card with zero copies is available in this database copy to use as a fixture.',
    );
  return card;
}

export async function activeVersionId(
  request: APIRequestContext,
  binderId: string,
): Promise<string> {
  const binders = await api.listBinders(request);
  const binder = binders.find((item) => item.id === binderId);
  const versionId = binder?.activeVersionId ?? binder?.latestVersionId;
  if (!versionId) throw new Error(`Binder ${binderId} has no active or latest version.`);
  return versionId;
}

export interface Placement {
  binderId: string;
  binderName: string;
  slotId: string;
  /** 0-based page index, matching the URL's `page` search param minus one and
   * `data-pocket`'s own page component. */
  page: number;
  row: number;
  column: number;
}

/**
 * Fills one of the card's loose copies into whichever binder has room, using the
 * same "next open target, else the end of the binder" priority order the card
 * inspector's Binder rows use. Throws if every binder is genuinely full, which
 * would mean the fixture data itself has changed shape.
 */
export async function placeLooseCopy(
  request: APIRequestContext,
  cardId: string,
): Promise<Placement> {
  const matches = await api.binderMatches(request, cardId);
  for (const binder of matches) {
    const destination = binder.nextTarget ?? binder.endDestination;
    if (!destination) continue;
    const versionId = await activeVersionId(request, binder.binderId);
    const page = await api.binderPage(request, versionId, 0);
    const response = await api.placeCard(request, cardId, {
      binderId: binder.binderId,
      slotId: destination.slotId,
      addCopy: false,
      expectedRevision: page.version.revision,
    });
    if (response.ok())
      return {
        binderId: binder.binderId,
        binderName: binder.name,
        slotId: destination.slotId,
        page: destination.page,
        row: destination.row,
        column: destination.col,
      };
  }
  throw new Error(`No binder had room to place a loose copy of ${cardId}.`);
}

/** A card with exactly one copy, placed in a binder pocket, and nothing loose — the
 * fixture "remove a copy" needs for its loose-disabled/miscount-asks-for-a-pocket
 * cases. */
export async function cardFullyPlaced(
  request: APIRequestContext,
): Promise<{ card: CatalogueCardView; placement: Placement }> {
  const card = await findMissingCard(request);
  await api.incrementCollection(request, card.id, 1);
  const placement = await placeLooseCopy(request, card.id);
  return { card, placement };
}

/** A card with two copies, one placed and one loose — the fixture "remove a copy"
 * needs for its pocket-removal case. */
export async function cardWithMix(
  request: APIRequestContext,
): Promise<{ card: CatalogueCardView; placement: Placement }> {
  const card = await findMissingCard(request);
  await api.incrementCollection(request, card.id, 2);
  const placement = await placeLooseCopy(request, card.id);
  return { card, placement };
}

/** A missing card whose species still has an open any-Pokémon target in the named
 * binder (National Pokédex, in production data) — flow 4's "place into a matching
 * target" scenario. Searches missing cards a handful of pages deep rather than
 * assuming a specific id, since the copied dataset is real data the suite doesn't shape. */
export async function findCardWithOpenPokemonTarget(
  request: APIRequestContext,
  binderName: string,
  maxPages = 15,
): Promise<{ card: CatalogueCardView; match: BinderCardMatches }> {
  for (let page = 1; page <= maxPages; page += 1) {
    const result = await api.searchCatalogue(request, { owned: 'missing', page });
    if (result.cards.length === 0) break;
    for (const card of result.cards) {
      if (!card.pokedexNumber) continue;
      const matches = await api.binderMatches(request, card.id);
      const match = matches.find(
        (item) => item.name === binderName && item.pokemonTargets.length > 0,
      );
      if (match) return { card, match };
    }
  }
  throw new Error(
    `No missing card with an open any-Pokémon target in "${binderName}" found in the first ${maxPages} pages of missing cards.`,
  );
}

/** A binder with no matching target at all for the given card (used for "Add at the
 * end" with no match): any binder whose matches entry has neither a next target nor
 * placed copies, only an endDestination. */
export function binderWithNoMatch(matches: BinderCardMatches[]): BinderCardMatches | undefined {
  return matches.find(
    (binder) =>
      binder.placed.length === 0 && binder.nextTarget === null && binder.endDestination !== null,
  );
}
