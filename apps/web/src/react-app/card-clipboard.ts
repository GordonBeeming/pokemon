import { useSyncExternalStore } from 'react';
import { z } from 'zod';
import { cardIdSchema } from '@pokedex/shared';
import { api, type CatalogueCardView } from './api';

const key = 'pokedex.binder-card-clipboard.v1';
const clipboardSchema = z.object({
  version: z.literal(1),
  cards: z
    .array(
      z.object({
        id: cardIdSchema,
        name: z.string().max(200),
        setName: z.string().max(200),
        number: z.string().max(128),
      }),
    )
    .min(1)
    .max(2000),
});
export type CardClipboard = z.infer<typeof clipboardSchema>;
let cachedRaw: string | null | undefined;
let cached: CardClipboard | null = null;
const listeners = new Set<() => void>();
function changed(): void {
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === key || event.key === null) listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}
export function readCardClipboard(): CardClipboard | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return null;
  }
  if (raw === cachedRaw) return cached;
  cachedRaw = raw;
  cached = null;
  if (!raw || raw.length > 1_500_000) return null;
  try {
    const parsed = clipboardSchema.safeParse(JSON.parse(raw));
    if (parsed.success) cached = parsed.data;
  } catch {
    return null;
  }
  return cached;
}
export function copyCards(
  cards: Pick<CatalogueCardView, 'id' | 'name' | 'setName' | 'number'>[],
): void {
  const value = clipboardSchema.parse({
    version: 1,
    cards: cards.map(({ id, name, setName, number }) => ({ id, name, setName, number })),
  });
  localStorage.setItem(key, JSON.stringify(value));
  changed();
}
export function clearCardClipboard(): void {
  localStorage.removeItem(key);
  changed();
}
export const useCardClipboard = (): CardClipboard | null =>
  useSyncExternalStore(subscribe, readCardClipboard, () => null);

export async function collectCardsForClipboard(
  filters: URLSearchParams,
  signal: AbortSignal,
): Promise<CatalogueCardView[]> {
  const params = new URLSearchParams(filters);
  params.delete('offset');
  params.delete('cursor');
  params.delete('setName');
  params.set('limit', '100');
  const cards: CatalogueCardView[] = [];
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let expected: number | undefined;
  let cursor: string | null = null;
  do {
    const result = await api.search(params, signal);
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    expected ??= result.total;
    if (expected > 2000)
      throw new Error(
        'Copy up to 2,000 cards at once. Narrow this search or copy the current page.',
      );
    if (result.total !== expected || (result.cursor && !result.cards.length))
      throw new Error('The results changed while copying. Please try again.');
    for (const card of result.cards) {
      if (ids.has(card.id)) throw new Error('The results changed while copying. Please try again.');
      ids.add(card.id);
      cards.push(card);
    }
    if (cards.length > 2000) throw new Error('Copy up to 2,000 cards at once. Narrow this search.');
    cursor = result.cursor;
    if (!cursor) break;
    if (cursors.has(cursor))
      throw new Error('The results changed while copying. Please try again.');
    cursors.add(cursor);
    params.set('cursor', cursor);
  } while (cursor !== null);
  if (cards.length !== expected)
    throw new Error('The results changed while copying. Please try again.');
  return cards;
}
