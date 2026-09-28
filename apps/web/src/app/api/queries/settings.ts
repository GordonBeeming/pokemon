import {
  DEFAULT_FRAME_PALETTE,
  framePaletteSchema,
  framePalettePutRequestSchema,
  type FramePalette,
  type FrameType,
} from '@pokedex/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { apiFetch } from '../client';
import { queryKeys } from '../keys';

// The worker (apps/web/src/worker/routes/api/browser.ts) always replaces the whole
// overrides map — PUT takes the complete { palette }, DELETE resets all of it, and
// there is no per-key endpoint — so every mutation below sends a full next map built
// from the current one.
const settingsEnvelopeSchema = z
  .object({ ok: z.literal(true), framePalette: framePaletteSchema })
  .passthrough();

function withoutFrameType(overrides: FramePalette, frameType: FrameType): FramePalette {
  return Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== frameType));
}

/**
 * Read + save for the one settings slice the frame gallery needs this wave. The rest
 * of /settings (passkeys, api tokens, catalogue sync, people) is wave 2's screen.
 */
export function useFramePalette() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.settings.framePalette(),
    queryFn: ({ signal }) =>
      apiFetch('/api/settings', settingsEnvelopeSchema, { signal }).then(
        (body) => body.framePalette,
      ),
    staleTime: 60_000,
  });

  const applyResult = (framePalette: FramePalette): void => {
    queryClient.setQueryData(queryKeys.settings.framePalette(), framePalette);
  };

  const putPalette = useMutation({
    mutationFn: (palette: FramePalette) =>
      apiFetch('/api/settings/frame-palette', settingsEnvelopeSchema, {
        method: 'PUT',
        body: framePalettePutRequestSchema.parse({ palette }),
      }).then((body) => body.framePalette),
    onSuccess: applyResult,
  });

  const resetAll = useMutation({
    mutationFn: () =>
      apiFetch('/api/settings/frame-palette', settingsEnvelopeSchema, { method: 'DELETE' }).then(
        (body) => body.framePalette,
      ),
    onSuccess: applyResult,
  });

  const overrides: FramePalette = query.data ?? {};

  return {
    palette: { ...DEFAULT_FRAME_PALETTE, ...overrides },
    overrides,
    isLoading: query.isLoading,
    error: query.error,
    /** Sets one type's override, keeping every other current override in place. */
    setOverride: (frameType: FrameType, hex: string) =>
      putPalette.mutateAsync({ ...overrides, [frameType]: hex }),
    /** Drops one type's override back to its default (PUT without that key). */
    resetOverride: (frameType: FrameType) =>
      putPalette.mutateAsync(withoutFrameType(overrides, frameType)),
    /** Resets every type at once (DELETE, no body or query param). */
    resetAll: () => resetAll.mutateAsync(),
  };
}

// ---------------------------------------------------------------------------
// Passkeys ("Your sign-in")
// ---------------------------------------------------------------------------

const passkeySchema = z
  .object({
    id: z.string(),
    name: z.string().nullable().optional(),
    device_label: z.string().nullable().optional(),
    transports: z.string().nullable().optional(),
    last_used_at: z.number().nullable().optional(),
    created_at: z.number().optional(),
  })
  .passthrough();
export type PasskeyView = z.infer<typeof passkeySchema>;
const passkeysEnvelope = z.object({ passkeys: z.array(passkeySchema) }).passthrough();
const okEnvelope = z.object({ ok: z.literal(true) }).passthrough();

export function usePasskeys() {
  return useQuery({
    queryKey: queryKeys.settings.passkeys(),
    queryFn: ({ signal }) =>
      apiFetch('/api/auth/passkey', passkeysEnvelope, { signal }).then((body) => body.passkeys),
  });
}

export function usePasskeyMutations() {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.settings.passkeys() });
  const rename = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      apiFetch(`/api/auth/passkey/${encodeURIComponent(id)}`, okEnvelope, {
        method: 'PATCH',
        body: { name },
      }),
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/auth/passkey/${encodeURIComponent(id)}`, okEnvelope, { method: 'DELETE' }),
    onSettled: refresh,
  });
  return { rename, remove, refresh };
}

// ---------------------------------------------------------------------------
// Catalogue sync
// ---------------------------------------------------------------------------

const readinessSchema = z
  .object({
    freshness: z
      .object({
        catalogue: z
          .object({ state: z.string(), lastSuccessAt: z.string().nullable() })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

/** When the catalogue last finished a full TCGdex sync. Read from the public readiness
 * probe, which answers 503 whenever *any* scheduled job is stale; that status is about
 * the whole service, not this value, so the body is read either way. */
export function useCatalogueLastSynced() {
  return useQuery({
    queryKey: ['settings', 'catalogue-last-synced'] as const,
    queryFn: async ({ signal }) => {
      const response = await fetch('/api/ready', { signal, credentials: 'same-origin' });
      const parsed = readinessSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error('The sync status could not be read.');
      return parsed.data.freshness.catalogue.lastSuccessAt;
    },
    staleTime: 30_000,
  });
}

const syncStartEnvelope = z
  .object({ ok: z.literal(true), workflowId: z.string().min(1) })
  .passthrough();
const syncStatusEnvelope = z.object({ ok: z.literal(true), status: z.string() }).passthrough();

export function startCatalogueSync() {
  return apiFetch('/api/catalogue/full-sync', syncStartEnvelope, { method: 'POST' }).then(
    (body) => body.workflowId,
  );
}

export function useCatalogueSyncProgress(workflowId: string | null) {
  return useQuery({
    queryKey: ['settings', 'catalogue-sync', workflowId ?? ''] as const,
    queryFn: ({ signal }) =>
      apiFetch(
        `/api/catalogue/full-sync/${encodeURIComponent(workflowId ?? '')}`,
        syncStatusEnvelope,
        { signal },
      ).then((body) => body.status),
    enabled: workflowId !== null,
    refetchInterval: (query) =>
      query.state.data === 'complete' || query.state.error ? false : 4000,
    retry: false,
  });
}

/**
 * POST /api/prices/refresh — prices the cards people own or hold in binders now.
 * With `everyCard`, it instead starts the background walk over the whole catalogue;
 * that returns only the first link's workflow id, so it has no progress to poll.
 */
export function startPriceRefresh(options: { everyCard?: boolean } = {}) {
  return apiFetch('/api/prices/refresh', syncStartEnvelope, {
    method: 'POST',
    ...(options.everyCard ? { body: { everyCard: true } } : {}),
  }).then((body) => body.workflowId);
}

export function usePriceRefreshProgress(workflowId: string | null) {
  return useQuery({
    queryKey: ['settings', 'price-refresh', workflowId ?? ''] as const,
    queryFn: ({ signal }) =>
      apiFetch(`/api/prices/refresh/${encodeURIComponent(workflowId ?? '')}`, syncStatusEnvelope, {
        signal,
      }).then((body) => body.status),
    enabled: workflowId !== null,
    refetchInterval: (query) =>
      query.state.data === 'complete' || query.state.error ? false : 4000,
    retry: false,
  });
}
