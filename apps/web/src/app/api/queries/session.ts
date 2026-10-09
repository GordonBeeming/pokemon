import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { apiFetch, ApiError, purgePrivateCaches } from '../client';
import { queryKeys } from '../keys';

// Not strict: /me grows fields (role today) and an unknown field must never lock
// everyone out of the shell. Role is optional so a pre-multi-user worker still parses.
const sessionSchema = z.object({
  ok: z.literal(true),
  sub: z.string(),
  label: z.string(),
  role: z.enum(['admin', 'member']).optional(),
});
export type Session = z.infer<typeof sessionSchema>;

const logoutSchema = z.object({ ok: z.literal(true) }).passthrough();

/**
 * Backs the app-shell auth gate: a 401 here (not a thrown network error) is the normal
 * "signed out" case, so callers read `query.data === undefined && !query.isLoading` for
 * that state rather than treating every failure as an error banner.
 */
export function useSession() {
  return useQuery({
    queryKey: queryKeys.session(),
    queryFn: ({ signal }) => apiFetch('/api/auth/me', sessionSchema, { signal }),
    retry: (failureCount, error) =>
      error instanceof ApiError && error.status === 401 ? false : failureCount < 2,
    staleTime: 60_000,
  });
}

/**
 * Ends the session on the server, then clears what this browser holds for it. On
 * success the shell lands on sign-in the same way a lost session does: every other
 * query is dropped so the next person never sees this one's data, and the session
 * query is reset so it refetches and comes back 401.
 */
export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<void> => {
      await apiFetch('/api/auth/logout', logoutSchema, { method: 'POST' });
      // The server session is already revoked here, so a purge failure must not read
      // as a failed logout.
      await purgePrivateCaches().catch((error: unknown) => {
        console.warn('Private cache purge failed after logout', error);
      });
    },
    onSuccess: async () => {
      const sessionKey = queryKeys.session();
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== sessionKey[0] });
      await queryClient.resetQueries({ queryKey: sessionKey });
    },
  });
}
