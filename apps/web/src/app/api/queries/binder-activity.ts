import { binderActivityResultSchema } from '@pokedex/shared';
import { z } from 'zod';
import { apiFetch } from '../client';

export const api = {
  binderActivity: (id: string, query: URLSearchParams, signal?: AbortSignal) =>
    apiFetch(
      `/api/binders/${encodeURIComponent(id)}/activity?${query}`,
      z.object({ ok: z.literal(true), activity: binderActivityResultSchema }),
      { signal },
    ).then((body) => body.activity),
  createBinderCheckpoint: (id: string) =>
    apiFetch(
      `/api/binders/${encodeURIComponent(id)}/checkpoints`,
      z.object({ ok: z.literal(true), checkpointId: z.string().nullable(), created: z.boolean() }),
      { method: 'POST' },
    ),
};
