import type { BinderSlot, CatalogueCardView } from './api';

export function pageSlots(slots: BinderSlot[]): BinderSlot[] {
  const pageId = slots[0]?.pageId;
  return pageId ? slots.filter((slot) => slot.pageId === pageId) : [];
}

export function cardForSlot(
  cards: CatalogueCardView[],
  cardId: string | null,
): CatalogueCardView | null {
  return cardId ? (cards.find((card) => card.id === cardId) ?? null) : null;
}
