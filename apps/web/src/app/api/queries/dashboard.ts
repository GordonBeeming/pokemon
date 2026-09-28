import {
  binderPokemonShortageSchema,
  binderShortageSchema,
  catalogueCardViewSchema,
} from '@pokedex/shared';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { apiFetch, isAbortError } from '../client';
import { queryKeys } from '../keys';

const dashboardResponseSchema = z
  .object({
    ok: z.literal(true),
    collection: z
      .object({ uniqueOwned: z.number(), totalQuantity: z.number(), noted: z.number() })
      .passthrough(),
    pricing: z
      .object({ priced: z.number(), missing: z.number(), estimateAud: z.number() })
      .passthrough(),
    binderCount: z.number(),
    activeShortages: z.array(binderShortageSchema),
    activePokemonShortages: z.array(binderPokemonShortageSchema).optional().default([]),
    activeShortageCount: z.number().optional(),
    activeShortageEntries: z.number().optional(),
    cards: z.array(catalogueCardViewSchema),
  })
  .passthrough();
export type Dashboard = z.infer<typeof dashboardResponseSchema>;

export function useDashboard() {
  return useQuery({
    queryKey: queryKeys.dashboard.summary(),
    queryFn: ({ signal }) => apiFetch('/api/dashboard', dashboardResponseSchema, { signal }),
  });
}

/** `activeShortageCount` when the server sends it, else the sum of both shortage
 * arrays' `missing` — the same fallback the old app's dashboard metric used. */
export function activeShortageCount(data: Dashboard): number {
  if (typeof data.activeShortageCount === 'number') return data.activeShortageCount;
  const exact = data.activeShortages.reduce((sum, item) => sum + item.missing, 0);
  const pokemon = data.activePokemonShortages.reduce((sum, item) => sum + item.missing, 0);
  return exact + pokemon;
}

const activeShortageEntrySchema = z.object({
  kind: z.enum(['exact-card', 'pokemon']),
  label: z.string(),
  cardId: z.string().nullable(),
  pokemonNumber: z.number().nullable(),
  setId: z.string().nullable().optional(),
  number: z.string().nullable().optional(),
  language: z.string().nullable().optional(),
  required: z.number(),
  owned: z.number(),
  assigned: z.number(),
  available: z.number(),
  missing: z.number(),
});
export type ActiveShortageEntry = z.infer<typeof activeShortageEntrySchema>;

const activeShortagesResponseSchema = z
  .object({
    ok: z.literal(true),
    snapshot: z.string().optional(),
    entries: z.array(activeShortageEntrySchema).max(100),
    totalMissing: z.number(),
    totalEntries: z.number(),
    nextOffset: z.number().nullable(),
  })
  .passthrough();

interface ActiveShortagesState {
  entries: ActiveShortageEntry[] | null;
  totalMissing: number | null;
  totalEntries: number | null;
  nextOffset: number | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  loadMoreError: string | null;
}

/**
 * Home's "Active shortages" panel: loads page one on mount, paginates with "Load
 * more", de-dupes by kind+id, and silently reloads from page one if the
 * `snapshot`/totals the server reports mid-page don't match what page one saw —
 * ported from the old app's ActiveShortages component. Not a plain useInfiniteQuery
 * because that consistency re-check (and the row-level vs page-level error split)
 * doesn't fall out of the default cache-page model.
 */
export function useActiveShortages(active: boolean): ActiveShortagesState & {
  retry: () => void;
  loadMore: () => Promise<void>;
} {
  const [state, setState] = useState<ActiveShortagesState>({
    entries: null,
    totalMissing: null,
    totalEntries: null,
    nextOffset: null,
    loading: true,
    loadingMore: false,
    error: null,
    loadMoreError: null,
  });
  const snapshotRef = useRef<string | undefined>(undefined);
  const controllerRef = useRef<AbortController | null>(null);

  const loadInitial = useCallback(async (): Promise<void> => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const report = await apiFetch(
        '/api/dashboard/shortages?offset=0',
        activeShortagesResponseSchema,
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      snapshotRef.current = report.snapshot;
      setState({
        entries: report.entries,
        totalMissing: report.totalMissing,
        totalEntries: report.totalEntries,
        nextOffset: report.nextOffset,
        loading: false,
        loadingMore: false,
        error: null,
        loadMoreError: null,
      });
    } catch (cause) {
      if (isAbortError(cause)) return;
      setState((current) => ({
        ...current,
        loading: false,
        error: cause instanceof Error ? cause.message : 'Active shortages could not load.',
      }));
    }
  }, []);

  // A ref mirror of state, read inside loadMore's async body — state itself can
  // move on between the request going out and coming back (another loadMore, or a
  // snapshot-triggered reload), and the closure must see the latest values, not
  // the ones captured when the click happened.
  const stateRef = useRef(state);
  stateRef.current = state;

  const loadMore = useCallback(async (): Promise<void> => {
    const before = stateRef.current;
    if (before.nextOffset === null || before.loadingMore) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    setState((current) => ({ ...current, loadingMore: true, loadMoreError: null }));
    try {
      const report = await apiFetch(
        `/api/dashboard/shortages?offset=${before.nextOffset}`,
        activeShortagesResponseSchema,
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      if (
        report.snapshot !== snapshotRef.current ||
        report.totalEntries !== before.totalEntries ||
        report.totalMissing !== before.totalMissing
      ) {
        await loadInitial();
        return;
      }
      setState((current) => {
        const merged = new Map(
          [...(current.entries ?? []), ...report.entries].map((entry) => [
            `${entry.kind}:${entry.cardId ?? entry.pokemonNumber}`,
            entry,
          ]),
        );
        return {
          ...current,
          entries: [...merged.values()],
          totalMissing: report.totalMissing,
          totalEntries: report.totalEntries,
          nextOffset: report.nextOffset,
          loadingMore: false,
        };
      });
    } catch (cause) {
      if (isAbortError(cause)) return;
      setState((current) => ({
        ...current,
        loadingMore: false,
        loadMoreError: cause instanceof Error ? cause.message : 'Could not load more shortages.',
      }));
    }
  }, [loadInitial]);

  useEffect(() => {
    if (!active) return;
    void loadInitial();
    return () => controllerRef.current?.abort();
  }, [active, loadInitial]);

  return { ...state, retry: () => void loadInitial(), loadMore };
}
