import { wantedListSchema, wantedScopesSchema, type WantedEntry } from '@pokedex/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
  return useQuery({
    queryKey: ['wanted', 'list', filters],
    enabled,
    queryFn: ({ signal }) =>
      apiFetch(
        `/api/wanted?${new URLSearchParams({ scope: filters.scope, placement: filters.placement ?? 'all', includeUnfilled: String(filters.includeUnfilled), q: filters.q, sort: filters.sort, offset: String(filters.offset) })}`,
        z.object({ ok: z.literal(true), list: wantedListSchema }),
        { signal },
      ).then((d) => d.list),
  });
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
