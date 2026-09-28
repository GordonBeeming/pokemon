import { cardIdSchema } from '@pokedex/shared';
import { useSyncExternalStore } from 'react';
import { z } from 'zod';

// Shared with binders' "Paste cards here" tool (ws-screens-b): same localStorage
// key and schema as the old app's clipboard, so a clipboard copied before this
// rewrite (or in the old SPA, still running at '/') keeps working across both.
const STORAGE_KEY = 'pokedex.binder-card-clipboard.v1';

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
export type ClipboardCard = CardClipboard['cards'][number];

let cachedRaw: string | null | undefined;
let cached: CardClipboard | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent): void => {
    if (event.key === STORAGE_KEY || event.key === null) listener();
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
    raw = localStorage.getItem(STORAGE_KEY);
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

export function copyCardsToClipboard(cards: ClipboardCard[]): void {
  const value = clipboardSchema.parse({ version: 1, cards });
  localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  notify();
}

export function clearCardClipboard(): void {
  localStorage.removeItem(STORAGE_KEY);
  notify();
}

/** Cross-tab reactive read — a copy in one tab shows up in a binder's "Paste cards
 * here" open in another tab without a manual refresh (FEATURES.md's clipboard
 * cross-tab requirement). `getServerSnapshot` returns null since there is no
 * clipboard during SSR/prerender (this app has none, but useSyncExternalStore
 * requires the argument regardless). */
export function useCardClipboard(): CardClipboard | null {
  return useSyncExternalStore(subscribe, readCardClipboard, () => null);
}
