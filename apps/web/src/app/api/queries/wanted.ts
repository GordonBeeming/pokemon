import { useMemo } from 'react';
import { uniqueItems } from '../infinite-data';
import { wantedListSchema, wantedScopesSchema, type WantedEntry } from '@pokedex/shared';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { apiFetch } from '../client';
export interface WantedFilters {
  scope: string;
  placement?: 'all' | 'placed' | 'not-placed' | 'ordered';
  includeUnfilled: boolean;
  q: string;
  sort: 'name' | 'newest' | 'pokedex' | 'set';
  offset: number;
}
export function useWantedList(filters: WantedFilters, enabled = true) {
  const criteria = {
    scope: filters.scope,
    placement: filters.placement ?? 'all',
    includeUnfilled: filters.includeUnfilled,
    q: filters.q,
    sort: filters.sort,
  };
  const query = useInfiniteQuery({
    queryKey: ['wanted', 'list', criteria],
    enabled,
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) =>
      apiFetch(
        `/api/wanted?${new URLSearchParams({ ...criteria, includeUnfilled: String(criteria.includeUnfilled), offset: String(pageParam) })}`,
        z.object({ ok: z.literal(true), list: wantedListSchema }),
        { signal },
      ).then((d) => d.list),
    getNextPageParam: (last, _pages, _param, params) =>
      last.nextOffset !== null && !params.includes(last.nextOffset) ? last.nextOffset : undefined,
  });
  const data = useMemo(() => {
    const first = query.data?.pages[0];
    if (!first) return undefined;
    return {
      ...first,
      entries: uniqueItems(
        query.data?.pages.flatMap((page) => page.entries) ?? [],
        (entry) => entry.key,
      ),
      nextOffset: query.data?.pages.at(-1)?.nextOffset ?? null,
    };
  }, [query.data]);
  return { ...query, data };
}

export function useWantedScopes(cardId: string) {
  return useQuery({
    queryKey: ['wanted', 'card', cardId],
    queryFn: ({ signal }) =>
      apiFetch(
        `/api/wanted/cards/${encodeURIComponent(cardId)}`,
        z.object({ ok: z.literal(true), scopes: wantedScopesSchema }),
        { signal },
      ).then((d) => d.scopes),
  });
}
export function useSetWanted() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { cardId: string; binderId: string | null; wanted: boolean }) =>
      apiFetch('/api/wanted', z.object({ ok: z.literal(true), scopes: wantedScopesSchema }), {
        method: 'PUT',
        body: input,
      }),
    onSuccess: (result, input) => {
      client.setQueryData(['wanted', 'card', input.cardId], result.scopes);
      return client.invalidateQueries({ queryKey: ['wanted', 'list'] });
    },
  });
}
export function wantedPrinting(entry: WantedEntry): string {
  return [entry.setName, entry.number, entry.language?.toUpperCase()].filter(Boolean).join(' · ');
}
