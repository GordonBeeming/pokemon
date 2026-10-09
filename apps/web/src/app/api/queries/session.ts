import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { apiFetch, ApiError, purgePrivateCaches } from '../client';
import { queryKeys } from '../keys';
import { announceLoggedOut, reloadSignedOut } from '../session-exit';

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

/** True when the server confirms there's no session; any other answer is "unknown". */
async function serverSaysSignedOut(): Promise<boolean> {
  try {
    await apiFetch('/api/auth/me', sessionSchema);
    return false;
  } catch (error) {
    return error instanceof ApiError && error.status === 401;
  }
}

/**
 * Ends the session on the server, clears this browser's caches, tells other tabs, and
 * reloads to sign-in. Cached queries are dropped first so nothing private is on screen
 * while the reload starts.
 */
export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<void> => {
      try {
        await apiFetch('/api/auth/logout', logoutSchema, { method: 'POST' });
      } catch (error) {
        // The response can be lost after the server already revoked the session, so
        // only report a failure the server confirms.
        if (!(await serverSaysSignedOut())) throw error;
      }
      // The server session is gone here, so a purge failure must not read as a failed
      // logout.
      await purgePrivateCaches().catch((error: unknown) => {
        console.warn('Private cache purge failed after logout', error);
      });
    },
    onSuccess: () => {
      const sessionKey = queryKeys.session();
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== sessionKey[0] });
      announceLoggedOut();
      reloadSignedOut();
    },
  });
}
