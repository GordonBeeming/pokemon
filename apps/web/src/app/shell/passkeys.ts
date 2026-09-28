import {
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { z } from 'zod';
import { apiFetch, ApiError } from '../api/client';

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? { ...value } : null;
}

const authenticationOptionsSchema = z.custom<PublicKeyCredentialRequestOptionsJSON>((value) => {
  const candidate = record(value);
  return (
    candidate !== null &&
    typeof candidate.challenge === 'string' &&
    (candidate.rpId === undefined || typeof candidate.rpId === 'string')
  );
});
const registrationOptionsSchema = z.custom<PublicKeyCredentialCreationOptionsJSON>((value) => {
  const candidate = record(value);
  return (
    candidate !== null &&
    typeof candidate.challenge === 'string' &&
    record(candidate.rp) !== null &&
    record(candidate.user) !== null
  );
});
const successSchema = z.object({ ok: z.literal(true) }).passthrough();

export async function signInWithPasskey(): Promise<void> {
  const options = await apiFetch('/api/auth/passkey/auth/options', authenticationOptionsSchema, {
    method: 'POST',
  });
  const response = await startAuthentication({ optionsJSON: options });
  await apiFetch('/api/auth/passkey/auth/verify', successSchema, {
    method: 'POST',
    body: { response },
  });
}

/** Registers a passkey on this device. Exactly one way in authorises it: the signed-in
 * session (adding another device), an invite token (a new person), or the enrolment
 * secret (the very first passkey on a fresh deploy). */
export async function registerPasskey(input: {
  name: string;
  inviteToken?: string;
  enrolSecret?: string;
}): Promise<void> {
  const grant = {
    ...(input.inviteToken ? { inviteToken: input.inviteToken } : {}),
    ...(input.enrolSecret ? { enrolSecret: input.enrolSecret } : {}),
  };
  const options = await apiFetch('/api/auth/passkey/register/options', registrationOptionsSchema, {
    method: 'POST',
    body: grant,
  });
  const response = await startRegistration({ optionsJSON: options });
  await apiFetch('/api/auth/passkey/register/verify', successSchema, {
    method: 'POST',
    body: { response, name: input.name, ...grant },
  });
}

export async function devLogin(): Promise<void> {
  await apiFetch('/api/auth/dev-login', successSchema, { method: 'POST' });
}

export function isLocalHost(hostname: string): boolean {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname);
}

const AUTH_MESSAGES: Record<string, string> = {
  verification_failed: 'The passkey could not be verified. Try again on this device.',
  challenge_expired: 'That passkey request expired. Start again.',
  unknown_credential: 'This passkey isn’t registered here.',
  user_disabled:
    'This account has been turned off by an admin. Nothing of yours was deleted; ask them to turn it back on.',
  rate_limited: 'Too many attempts were made. Wait a moment, then try again.',
  unauthorized: 'That enrolment secret isn’t right, or this app already has a passkey.',
  bootstrap_closed: 'This app already has a passkey. Sign in with it, or ask for an invite.',
  invite_expired: 'This invite link has expired. Ask for a new one.',
  invite_used: 'This invite link has already been used. Ask for a new one.',
  invite_invalid: 'This invite link isn’t valid. Ask for a new one.',
};

/** Empty string means "the person cancelled the browser prompt": say nothing. */
export function authErrorMessage(error: unknown): string {
  if (
    error instanceof DOMException &&
    (error.name === 'AbortError' || error.name === 'NotAllowedError')
  )
    return '';
  if (error instanceof ApiError)
    return AUTH_MESSAGES[error.code] ?? 'Sign-in could not be completed. Try again.';
  return 'The request could not be completed. Try again.';
}
