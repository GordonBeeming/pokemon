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
