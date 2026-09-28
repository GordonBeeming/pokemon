import {
  binderPageSchema,
  binderSlotSchema,
  binderVersionPagesSchema,
  binderVersionSummarySchema,
  binderViewSchema,
} from '@pokedex/shared';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { apiFetch } from '../client';
import { queryKeys } from '../keys';

// Browser tabs can stay open across a worker deploy; passthrough so an additive field
// from a newer server doesn't break a client that hasn't reloaded yet.
const bindersResponseSchema = z
  .object({ ok: z.literal(true), binders: z.array(binderViewSchema.passthrough()) })
  .passthrough();

const binderSlotResponseSchema = binderSlotSchema.passthrough();
const binderPageResponseSchema = binderPageSchema
  .extend({ slots: z.array(binderSlotResponseSchema).max(400) })
  .passthrough();
const binderPagesResponseSchema = z
  .object({
    ok: z.literal(true),
    binder: binderVersionPagesSchema
      .extend({
        version: binderVersionSummarySchema.passthrough(),
        pages: z.array(binderPageResponseSchema).max(4),
      })
      .passthrough(),
  })
  .passthrough();

export function useBinders() {
  return useQuery({
    queryKey: queryKeys.binders.list(),
    queryFn: ({ signal }) =>
      apiFetch('/api/binders', bindersResponseSchema, { signal }).then((body) => body.binders),
  });
}

export function useBinderPage(binderId: string | undefined, page: number, limit = 1) {
  return useQuery({
    queryKey: queryKeys.binders.page(binderId ?? '', page),
    queryFn: ({ signal }) =>
      apiFetch(
        `/api/binders/versions/${encodeURIComponent(binderId ?? '')}?page=${page}&limit=${limit}`,
        binderPagesResponseSchema,
        { signal },
      ).then((body) => body.binder),
    enabled: binderId !== undefined && binderId.length > 0,
  });
}
