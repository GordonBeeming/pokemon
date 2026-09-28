import { useQueryClient } from '@tanstack/react-query';
import { startAuthentication } from '@simplewebauthn/browser';
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { useState, type ReactElement } from 'react';
import { z } from 'zod';
import { apiFetch, ApiError } from '../api/client';
import { queryKeys } from '../api/keys';

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
const successSchema = z.object({ ok: z.literal(true) }).passthrough();

function userMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return '';
  if (!(error instanceof ApiError)) return 'The request could not be completed. Try again.';
  if (error.code === 'verification_failed')
    return 'The passkey could not be verified. Try again on this device.';
  if (error.code === 'rate_limited')
    return `Too many attempts were made. Wait a moment, then try again.`;
  return 'Sign-in could not be completed. Try again.';
}

/**
 * The gate every real route sits behind. Deliberately thin: full passkey management
 * (registration, naming a device) belongs to the Settings screen wave 2 builds; this
 * only needs to get an already-enrolled owner back in.
 */
export function SignIn(): ReactElement {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function authenticate(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      const options = await apiFetch(
        '/api/auth/passkey/auth/options',
        authenticationOptionsSchema,
        {
          method: 'POST',
        },
      );
      const response = await startAuthentication({ optionsJSON: options });
      await apiFetch('/api/auth/passkey/auth/verify', successSchema, {
        method: 'POST',
        body: { response },
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.session() });
    } catch (reason) {
      const message = userMessage(reason);
      if (message) setError(message);
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="sign-in-shell">
      <section className="sign-in-card" aria-labelledby="sign-in-heading">
        <h1 id="sign-in-heading">Sign in</h1>
        <p>Use the passkey registered for this collection.</p>
        {error ? (
          <p className="notice error" role="alert">
            {error}
          </p>
        ) : null}
        <button type="button" onClick={() => void authenticate()} disabled={pending}>
          {pending ? 'Signing in…' : 'Sign in with a passkey'}
        </button>
      </section>
    </main>
  );
}
