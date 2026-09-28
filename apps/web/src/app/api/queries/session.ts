import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { apiFetch, ApiError } from '../client';
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
