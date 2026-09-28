import {
  type BinderLayout,
  type BinderSlotLocation,
  formatDexNumber,
  NATIONAL_POKEDEX,
  type PeekColumns,
} from '@pokedex/shared';
import { ApiError, isAbortError } from '../../api/client';
import type { BinderPageView, BinderSlotView, ResolvedCard } from '../../api/queries/binders';
import type { CardFrameCard } from '../../cards/CardFrame';

export const BINDER_NAME_MAX = 120;
export const INSERT_SELECTION_CAP = 1025;

export const PAGE_FACES: ReadonlyArray<{
  kind: BinderLayout['kind'];
  label: string;
  rows: number;
  columns: number;
}> = [
  { kind: '2x2', label: '2 × 2', rows: 2, columns: 2 },
  { kind: '3x3', label: '3 × 3', rows: 3, columns: 3 },
  { kind: '4x3', label: '4 × 3', rows: 3, columns: 4 },
  { kind: 'top-loader', label: 'Top-loader', rows: 2, columns: 2 },
  { kind: 'custom', label: 'Custom', rows: 3, columns: 3 },
];

export function layoutFor(kind: BinderLayout['kind'], rows: number, columns: number): BinderLayout {
  if (kind === 'custom') return { kind, rows, columns };
  if (kind === '2x2') return { kind, rows: 2, columns: 2 };
  if (kind === '3x3') return { kind, rows: 3, columns: 3 };
  if (kind === '4x3') return { kind, rows: 3, columns: 4 };
  return { kind: 'top-loader', rows: 2, columns: 2 };
}

export function capacityDescription(capacity: number, face: number): string {
  if (!Number.isInteger(capacity)) return 'Enter a whole number of pockets.';
  if (capacity < 1) return 'Enter at least 1 pocket.';
  const pages = Math.ceil(capacity / face);
  const finalPage = capacity % face || face;
  const pageLabel = pages === 1 ? 'page face' : 'page faces';
  const pocketLabel = finalPage === 1 ? 'pocket' : 'pockets';
  const capacityLabel = capacity === 1 ? 'pocket' : 'pockets';
  const partial = finalPage < face ? ` The final page has ${finalPage} ${pocketLabel}.` : '';
  return `${capacity.toLocaleString('en-AU')} ${capacityLabel} in this binder across ${pages.toLocaleString('en-AU')} ${pageLabel}.${partial}`;
}

// ---------------------------------------------------------------------------
// Slot addressing. The URL carries `sel=<pageId>:<row>:<col>` (the worker's slotId
// shape), so a selection survives page reordering: it names the page, not a position.
// ---------------------------------------------------------------------------

export function slotIdOf(pageId: string, row: number, column: number): string {
  return `${pageId}:${row}:${column}`;
}

export function parseSlotId(
  slotId: string | undefined,
): { pageId: string; row: number; column: number } | null {
  if (!slotId) return null;
  const match = /^(.+):(\d{1,3}):(\d{1,3})$/u.exec(slotId);
  if (!match?.[1] || match[2] === undefined || match[3] === undefined) return null;
  return { pageId: match[1], row: Number(match[2]), column: Number(match[3]) };
}

export type PocketState = 'placed' | 'reserved' | 'empty' | 'target';

export function pocketState(slot: BinderSlotView): PocketState {
  if (slot.assignedCardId) return 'placed';
  if (slot.entryKind === 'reserved') return 'reserved';
  if (slot.entryKind === 'empty' || (!slot.entryKind && !slot.cardId)) return 'empty';
  return 'target';
}

export function isTarget(slot: BinderSlotView | null | undefined): boolean {
  return slot?.entryKind === 'exact-card' || slot?.entryKind === 'pokemon';
}

export function placeText(at: BinderSlotLocation): string {
  return `page ${at.page + 1}, row ${at.row + 1}, pocket ${at.column + 1}`;
}

export type CardLookup = ReadonlyMap<string, ResolvedCard>;

/** "#0025 Pikachu", the exact card's name, the reservation label, or "Empty pocket". */
export function pocketTitle(slot: BinderSlotView, cards: CardLookup): string {
  if (slot.assignedCardId) {
    const placed = cards.get(slot.assignedCardId);
    const dex = placed?.pokedexNumber ?? slot.pokemonNumber;
    if (placed) return dex ? `${formatDexNumber(dex)} ${placed.name}` : placed.name;
  }
  if (slot.entryKind === 'reserved')
    return slot.label ? `Reserved: ${slot.label}` : 'Reserved sleeve';
  if (slot.entryKind === 'pokemon' && slot.pokemonNumber) {
    const pokemon = NATIONAL_POKEDEX[slot.pokemonNumber - 1];
    return pokemon
      ? `${formatDexNumber(pokemon.number)} ${pokemon.name}`
      : `Pokémon #${slot.pokemonNumber}`;
  }
  if (slot.entryKind === 'exact-card' && slot.cardId) {
    const card = cards.get(slot.cardId);
    if (!card) return 'Exact card target';
    return card.pokedexNumber ? `${formatDexNumber(card.pokedexNumber)} ${card.name}` : card.name;
  }
  return 'Empty pocket';
}

export function pocketKindLabel(slot: BinderSlotView): string {
  if (slot.entryKind === 'pokemon') return 'Any printing of this Pokémon';
  if (slot.entryKind === 'exact-card') return 'Exact card target';
  if (slot.entryKind === 'reserved') return 'Reserved sleeve';
  return 'Empty pocket';
}

export function placedStatus(slot: BinderSlotView, cards: CardLookup): string {
  if (slot.assignedCardId) {
    const placed = cards.get(slot.assignedCardId);
    return `Placed: ${placed ? placed.name : 'owned copy'}`;
  }
  if (isTarget(slot)) return 'Nothing placed';
  if (slot.entryKind === 'reserved') return 'Reserved';
  return 'Empty';
}

export function bookmarkDefaultName(slot: BinderSlotView, cards: CardLookup): string {
  if (slot.entryKind === 'pokemon' && slot.pokemonNumber)
    return NATIONAL_POKEDEX[slot.pokemonNumber - 1]?.name ?? 'Pokémon';
  if (slot.entryKind === 'exact-card' && slot.cardId) return cards.get(slot.cardId)?.name ?? 'Card';
  if (slot.entryKind === 'reserved') return slot.label ?? 'Reserved sleeve';
  return 'Empty';
}

export function pocketAriaLabel(
  slot: BinderSlotView,
  at: BinderSlotLocation,
  cards: CardLookup,
): string {
  return `${placeText(at)}: ${pocketTitle(slot, cards)}. ${placedStatus(slot, cards)}.`;
}

export function frameCardFrom(card: ResolvedCard): CardFrameCard {
  return {
    id: card.id,
    name: card.name,
    frameType: card.frameType ?? null,
    setCode: card.setCode ?? null,
    number: card.number,
    rarityKey: card.rarityKey ?? null,
    pokedexNumber: card.pokedexNumber ?? null,
    imageUrl: card.imageLowUrl,
  };
}

/** An unfilled any-printing target: the species with no printing, drawn as the ANY frame. */
export function anyFrameCard(pokemonNumber: number): CardFrameCard {
  const pokemon = NATIONAL_POKEDEX[pokemonNumber - 1];
  return {
    id: `any:${pokemonNumber}`,
    name: pokemon?.name ?? `Pokémon #${pokemonNumber}`,
    frameType: null,
    setCode: null,
    number: null,
    rarityKey: null,
    pokedexNumber: pokemonNumber,
    imageUrl: null,
  };
}

export function cardIdsOnPages(pages: readonly BinderPageView[]): string[] {
  const ids = new Set<string>();
  for (const page of pages)
    for (const slot of page.slots) {
      if (slot.cardId) ids.add(slot.cardId);
      if (slot.assignedCardId) ids.add(slot.assignedCardId);
    }
  return [...ids];
}

// ---------------------------------------------------------------------------
// Page track geometry. Pocket size is derived from the width available for art, never
// the other way round, so a card is never cropped or squished to fit a row.
// ---------------------------------------------------------------------------

export interface TrackGeometry {
  pocketWidth: number;
  gap: number;
  pad: number;
  spine: number;
  pageWidth: number;
  stride: number;
  /** Room for the previous page's peek, left of the current page. */
  offset: number;
  /** Room for the next page's peek, right of the current page. */
  offsetRight: number;
  viewportWidth: number;
}

export function trackGeometry(
  availableWidth: number,
  columns: number,
  peek: PeekColumns,
  neighbours: { before: boolean; after: boolean } = { before: true, after: true },
  maxPocket = 168,
): TrackGeometry {
  const compact = availableWidth < 600;
  const gap = compact ? 6 : 10;
  const pad = compact ? 8 : 14;
  const spine = peek ? (compact ? 10 : 28) : 0;
  // On a phone a whole neighbouring column would shrink every pocket to a thumbnail,
  // so only a slice of it shows: enough to see it's there and to drag a card onto it.
  const peekFraction = compact ? 0.35 : 1;
  const peekUnits = peek * peekFraction;
  // Pocket size assumes both neighbours, so it stays the same on the first and last
  // page and a page turn never resizes the cards.
  const pocketWidth = Math.max(
    40,
    Math.min(
      maxPocket,
      Math.floor(
        (availableWidth -
          (columns - 1) * gap -
          2 * pad -
          (peek ? 2 * (spine + pad) + 2 * peekUnits * gap : 0)) /
          (columns + 2 * peekUnits),
      ),
    ),
  );
  const pageWidth = columns * pocketWidth + (columns - 1) * gap + 2 * pad;
  const stride = pageWidth + spine;
  const peekWidth = peek ? Math.round(spine + pad + peekUnits * (pocketWidth + gap)) : 0;
  // A phone has no room to spare for a neighbour that doesn't exist: with no page
  // before (or after), that side draws nothing instead of an empty strip, and the
  // stage centres what's left. Desktop keeps both sides so its layout never shifts.
  const offset = peek && (!compact || neighbours.before) ? peekWidth : 0;
  const offsetRight = peek && (!compact || neighbours.after) ? peekWidth : 0;
  return {
    pocketWidth,
    gap,
    pad,
    spine,
    pageWidth,
    stride,
    offset,
    offsetRight,
    viewportWidth: pageWidth + offset + offsetRight,
  };
}

// ---------------------------------------------------------------------------
// Conflicts: what changed between the page we had and the page the server now has.
// ---------------------------------------------------------------------------

export function changedPockets(
  before: BinderPageView | undefined,
  after: BinderPageView | undefined,
): Array<{ row: number; column: number }> {
  if (!before || !after) return [];
  const key = (slot: BinderSlotView) =>
    [slot.entryKind, slot.cardId, slot.pokemonNumber, slot.assignedCardId, slot.label].join('|');
  const previous = new Map(before.slots.map((slot) => [`${slot.row}:${slot.column}`, key(slot)]));
  return after.slots
    .filter((slot) => previous.get(`${slot.row}:${slot.column}`) !== key(slot))
    .map((slot) => ({ row: slot.row, column: slot.column }));
}

const ERROR_MESSAGES: Record<string, string> = {
  binder_page_contains_targets:
    'Move or remove the entries on this page before reserving it. No sleeves were changed.',
  binder_shift_page_break:
    'The page break keeps these targets in place. Remove the page break or shift by a whole page.',
  binder_not_found:
    'This binder is no longer available or its name changed. Reopen the binder and try again.',
  binder_shift_occupied: 'The sleeves before this target must be empty to shift backward.',
  binder_revision_conflict: 'This binder changed elsewhere. The latest pages have been reloaded.',
  binder_paste_no_space:
    'The copied cards do not fit before the next reserved page or the end of this section. Choose another pocket, fewer cards, or grow the binder.',
  binder_paste_confirmation_required: 'Confirm replacement of the occupied targets before pasting.',
  binder_bookmark_reserved_page: 'Use Manage page to change a reserved-page bookmark.',
  binder_assignment_quantity_exceeded:
    'All owned copies of this card are already placed. Use Find cards to add a copy and place it.',
  binder_assignment_incompatible: 'That copy does not fit this target.',
  binder_version_not_draft: 'Only a draft can be discarded. The active binder was not changed.',
  binder_version_not_found:
    'That version of the binder no longer exists. Open the binder again from the library.',
  binder_version_archived:
    'This archived binder version is read-only. Open the current binder to continue editing.',
  binder_last_page: 'A binder must keep at least one page.',
  binder_page_limit_reached: 'This binder has reached its page limit.',
  binder_shrink_occupied:
    'Pockets past the new capacity still hold targets. Move or remove them first; nothing was changed.',
  binder_capacity_exceeded: 'This needs more pockets than the binder has.',
  binder_reserved_page_not_empty: 'Empty this reserved page before unreserving it.',
  reserved_page_full:
    'There is not enough room on this reserved page. Choose fewer targets or free a pocket on this page.',
  collection_revision_conflict:
    'This card changed elsewhere. Refresh the owned count and try again.',
  rate_limited: 'Too many attempts were made. Wait a moment, then try again.',
  invalid_response: 'The server returned an unreadable response. Try again.',
  internal_error: 'The server could not complete the request. Try again.',
};

export function binderErrorMessage(error: unknown): string {
  if (isAbortError(error)) return '';
  if (!(error instanceof ApiError)) return 'The request could not be completed. Try again.';
  const base = ERROR_MESSAGES[error.code] ?? 'The request could not be completed. Try again.';
  const retry = error.retryAfterSeconds ? ` Try again in ${error.retryAfterSeconds} seconds.` : '';
  return `${base}${retry}`;
}

export function isRevisionConflict(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'binder_revision_conflict';
}
