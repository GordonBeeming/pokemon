import {
  createInviteResponseSchema,
  inviteSummarySchema,
  invitePublicStatusSchema,
  personSchema,
  type UserRole,
} from '@pokedex/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { apiFetch, ApiError } from '../client';
import { queryKeys } from '../keys';

// Passthrough on every envelope: a newer worker adding a field must not break an
// already-open tab. The shared schemas are strict, so each is relaxed here.
const personView = personSchema.passthrough();
export type PersonView = z.input<typeof personView>;
const meEnvelope = z.object({ ok: z.literal(true), person: personView }).passthrough();
const peopleEnvelope = z.object({ ok: z.literal(true), people: z.array(personView) }).passthrough();
const personEnvelope = z.object({ ok: z.literal(true), person: personView }).passthrough();
const inviteView = inviteSummarySchema.passthrough();
export type InviteView = z.input<typeof inviteView>;
const invitesEnvelope = z
  .object({ ok: z.literal(true), invites: z.array(inviteView) })
  .passthrough();
const createInviteEnvelope = createInviteResponseSchema
  .extend({ ok: z.literal(true) })
  .passthrough();
const okEnvelope = z.object({ ok: z.literal(true) }).passthrough();
const invitePublicEnvelope = invitePublicStatusSchema.passthrough();
export type InvitePublicView = z.input<typeof invitePublicEnvelope>;

/** The signed-in person, including their role. Members get their own record; the
 * admin-only People tab is hidden from anyone this says isn't an admin. */
export function useMe() {
  return useQuery({
    queryKey: queryKeys.people.me(),
    queryFn: ({ signal }) =>
      apiFetch('/api/people/me', meEnvelope, { signal }).then((body) => body.person),
    staleTime: 60_000,
    retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
  });
}

export function usePeople(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.people.list(),
    queryFn: ({ signal }) =>
      apiFetch('/api/people', peopleEnvelope, { signal }).then((body) => body.people),
    enabled,
  });
}

export function useInvites(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.people.invites(),
    queryFn: ({ signal }) =>
      apiFetch('/api/people/invites', invitesEnvelope, { signal }).then((body) => body.invites),
    enabled,
  });
}

export function usePeopleMutations() {
  const queryClient = useQueryClient();
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.people.list() }),
      queryClient.invalidateQueries({ queryKey: queryKeys.people.invites() }),
      queryClient.invalidateQueries({ queryKey: queryKeys.people.me() }),
    ]);

  const patchPerson = useMutation({
    mutationFn: ({
      id,
      patch,
    }: {
      id: string;
      patch: { role?: UserRole; disabled?: boolean; showPrices?: boolean };
    }) =>
      apiFetch(`/api/people/${encodeURIComponent(id)}`, personEnvelope, {
        method: 'PATCH',
        body: patch,
      }).then((body) => body.person),
    onSettled: refresh,
  });

  const createInvite = useMutation({
    mutationFn: (input: { label?: string; role: UserRole }) =>
      apiFetch('/api/people/invites', createInviteEnvelope, { method: 'POST', body: input }),
    onSettled: refresh,
  });

  const cancelInvite = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/people/invites/${encodeURIComponent(id)}`, okEnvelope, {
        method: 'DELETE',
      }).then(() => undefined),
    onSettled: refresh,
  });

  return { patchPerson, createInvite, cancelInvite };
}

/** Public lookup for the invite landing page; works signed out. */
export function useInviteStatus(token: string) {
  return useQuery({
    queryKey: queryKeys.people.invite(token),
    queryFn: ({ signal }) =>
      apiFetch(`/api/auth/invites/${encodeURIComponent(token)}`, invitePublicEnvelope, {
        signal,
      }),
    retry: false,
  });
}

const PEOPLE_MESSAGES: Record<string, string> = {
  last_admin:
    'Someone else needs to be an active admin first. There must always be at least one active admin.',
  person_changed: 'This person changed while you were editing them. Refresh and try again.',
  user_disabled: 'This account has been turned off by an admin. Ask them to turn it back on.',
  invite_expired: 'This invite link has expired. Ask for a new one.',
  invite_used: 'This invite link has already been used. Ask for a new one.',
  invite_invalid: 'This invite link isn’t valid. Check you copied all of it, or ask for a new one.',
  invite_not_found: 'That invite was already cancelled or used.',
  forbidden: 'Only admins can do that.',
  rate_limited: 'Too many attempts were made. Wait a moment, then try again.',
};

export function peopleErrorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return '';
  if (error instanceof ApiError)
    return PEOPLE_MESSAGES[error.code] ?? 'The request could not be completed. Try again.';
  return 'The request could not be completed. Try again.';
}
