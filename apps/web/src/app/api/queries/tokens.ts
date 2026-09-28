import { DESKTOP_SCOPES } from '@pokedex/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { apiFetch } from '../client';
import { queryKeys } from '../keys';

// The worker stores a pairing code for 10 minutes (lib/desktop-auth.ts) but doesn't
// return its expiry, so the screen shows this window from the moment it was issued.
export const PAIR_CODE_LIFETIME_MS = 10 * 60 * 1000;

const tokenSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    scopes: z.array(z.string()).optional(),
    expiresAt: z.string().nullable().optional(),
    revokedAt: z.string().nullable().optional(),
    lastUsedAt: z.string().nullable().optional(),
  })
  .passthrough();
export type ApiToken = z.infer<typeof tokenSchema>;
const tokensEnvelope = z
  .object({ ok: z.literal(true), tokens: z.array(tokenSchema) })
  .passthrough();
const pairEnvelope = z
  .object({
    ok: z.literal(true),
    code: z.string().min(8).max(64),
    expiresAt: z.string().optional(),
  })
  .passthrough();
const okEnvelope = z.object({ ok: z.literal(true) }).passthrough();

export function useApiTokens() {
  return useQuery({
    queryKey: queryKeys.settings.tokens(),
    queryFn: ({ signal }) =>
      apiFetch('/api/desktop/tokens', tokensEnvelope, { signal }).then((body) => body.tokens),
  });
}

export function useApiTokenMutations() {
  const queryClient = useQueryClient();
  const createPairingCode = useMutation({
    mutationFn: () =>
      apiFetch('/api/desktop/pair', pairEnvelope, {
        method: 'POST',
        body: { scopes: [...DESKTOP_SCOPES] },
      }).then((body) => ({
        code: body.code,
        expiresAt: body.expiresAt ?? new Date(Date.now() + PAIR_CODE_LIFETIME_MS).toISOString(),
      })),
  });
  const revoke = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/desktop/tokens/${encodeURIComponent(id)}`, okEnvelope, {
        method: 'DELETE',
      }).then(() => undefined),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.settings.tokens() }),
  });
  return { createPairingCode, revoke };
}
