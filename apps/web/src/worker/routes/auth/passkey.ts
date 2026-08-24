import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { Hono } from 'hono';
import { z } from 'zod';
import { base64UrlDecode } from '../../lib/crypto';
import {
  deletePasskey,
  getOrCreateOwner,
  getPasskey,
  getPasskeys,
  insertPasskey,
  logAudit,
  renamePasskey,
  setSessionCookie,
  signSession,
  updatePasskeyUsage,
} from '../../lib/auth';
import { requireEnrolAuth, requireSession } from '../../lib/guards';
import { logWarn } from '../../lib/log';
import type {
  AuthVars,
  AuthenticationResponseShape,
  RegistrationResponseShape,
} from '../../lib/types';

const nameSchema = z.string().trim().min(1).max(60);
const registrationBody = z.object({
  response: z.unknown(),
  enrolSecret: z.string().max(256).optional(),
  name: nameSchema.optional(),
});
const authenticationBody = z.object({ response: z.unknown() });
const renameBody = z.object({ name: nameSchema.nullable() });
function toRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? { ...value } : null;
}

type AuthenticatorTransportFuture = 'ble' | 'hybrid' | 'internal' | 'nfc' | 'usb';
function registrationResponse(value: unknown): value is RegistrationResponseShape {
  const record = toRecord(value);
  if (
    !record ||
    typeof record.id !== 'string' ||
    typeof record.rawId !== 'string' ||
    record.type !== 'public-key'
  )
    return false;
  const response = toRecord(record.response);
  if (!response) return false;
  if (!toRecord(record.clientExtensionResults)) return false;
  return (
    typeof response.clientDataJSON === 'string' && typeof response.attestationObject === 'string'
  );
}
function authenticationResponse(value: unknown): value is AuthenticationResponseShape {
  const record = toRecord(value);
  if (
    !record ||
    typeof record.id !== 'string' ||
    typeof record.rawId !== 'string' ||
    record.type !== 'public-key'
  )
    return false;
  const response = toRecord(record.response);
  if (!response) return false;
  if (!toRecord(record.clientExtensionResults)) return false;
  return (
    typeof response.clientDataJSON === 'string' &&
    typeof response.authenticatorData === 'string' &&
    typeof response.signature === 'string'
  );
}
function transports(value: string | null): AuthenticatorTransportFuture[] | undefined {
  return value
    ? value
        .split(',')
        .filter((item): item is AuthenticatorTransportFuture =>
          ['ble', 'hybrid', 'internal', 'nfc', 'usb'].includes(item),
        )
    : undefined;
}
function origin(c: { req: { raw: Request }; env: CloudflareEnv }): string {
  return c.env.PUBLIC_ORIGIN || new URL(c.req.raw.url).origin;
}

export const passkeyRoutes = new Hono<{ Bindings: CloudflareEnv; Variables: AuthVars }>();
passkeyRoutes.get('/', requireSession, async (c) => {
  const session = c.get('session');
  if (!session) return c.json({ ok: false, error: 'unauthorized' }, 401);
  const passkeys = await getPasskeys(c.env.DB, session.sub);
  return c.json({
    passkeys: passkeys.map((passkey) => {
      const { public_key: publicKey, ...safePasskey } = passkey;
      void publicKey;
      return safePasskey;
    }),
  });
});
passkeyRoutes.post('/register/options', requireEnrolAuth, async (c) => {
  const owner = await getOrCreateOwner(c.env.DB, c.env.OWNER_LABEL);
  const existing = await getPasskeys(c.env.DB, owner.id);
  const options = await generateRegistrationOptions({
    rpName: 'Pokédex',
    rpID: new URL(origin(c)).hostname,
    userID: new TextEncoder().encode(owner.id),
    userName: `owner@${owner.label.toLowerCase()}`,
    attestationType: 'none',
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    excludeCredentials: existing.map((passkey) => ({
      id: passkey.id,
      transports: transports(passkey.transports),
    })),
  });
  await c.env.SESSIONS.put(`pk:reg:${owner.id}`, options.challenge, { expirationTtl: 300 });
  return c.json(options);
});
passkeyRoutes.post('/register/verify', requireEnrolAuth, async (c) => {
  const parsed = registrationBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success || !registrationResponse(parsed.data.response))
    return c.json({ ok: false, error: 'invalid_body' }, 400);
  const owner = await getOrCreateOwner(c.env.DB, c.env.OWNER_LABEL);
  const challenge = await c.env.SESSIONS.get(`pk:reg:${owner.id}`);
  if (!challenge) return c.json({ ok: false, error: 'challenge_expired' }, 400);
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: parsed.data.response,
      expectedChallenge: challenge,
      expectedOrigin: origin(c),
      expectedRPID: new URL(origin(c)).hostname,
      requireUserVerification: false,
    });
  } catch (error) {
    logWarn({ evt: 'auth.register.verify_failed', err: String(error) });
    return c.json({ ok: false, error: 'verification_failed' }, 400);
  }
  if (!verification.verified || !verification.registrationInfo)
    return c.json({ ok: false, error: 'not_verified' }, 400);
  const credential = verification.registrationInfo.credential;
  await insertPasskey(c.env.DB, {
    id: credential.id,
    userId: owner.id,
    publicKey: credential.publicKey,
    counter: credential.counter,
    transports: credential.transports?.join(',') ?? null,
    deviceLabel: null,
    name: parsed.data.name ?? null,
    createdAt: Math.floor(Date.now() / 1000),
  });
  await c.env.SESSIONS.delete(`pk:reg:${owner.id}`);
  await logAudit(c.env.DB, { actor: owner.id, action: 'passkey.register', target: credential.id });
  setSessionCookie(c, await signSession({ sub: owner.id, label: owner.label }, c.env));
  return c.json({ ok: true });
});
passkeyRoutes.post('/auth/options', async (c) => {
  const owner = await getOrCreateOwner(c.env.DB, c.env.OWNER_LABEL);
  const existing = await getPasskeys(c.env.DB, owner.id);
  const options = await generateAuthenticationOptions({
    rpID: new URL(origin(c)).hostname,
    userVerification: 'preferred',
    allowCredentials: existing.map((passkey) => ({
      id: passkey.id,
      transports: transports(passkey.transports),
    })),
  });
  await c.env.SESSIONS.put(`pk:auth:${options.challenge}`, options.challenge, {
    expirationTtl: 300,
  });
  return c.json(options);
});
passkeyRoutes.post('/auth/verify', async (c) => {
  const parsed = authenticationBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success || !authenticationResponse(parsed.data.response))
    return c.json({ ok: false, error: 'invalid_body' }, 400);
  const response = parsed.data.response;
  const clientDataParsed = z
    .object({ challenge: z.string() })
    .safeParse(
      JSON.parse(new TextDecoder().decode(base64UrlDecode(response.response.clientDataJSON))),
    );
  if (!clientDataParsed.success) return c.json({ ok: false, error: 'missing_challenge' }, 400);
  const challenge = await c.env.SESSIONS.get(`pk:auth:${clientDataParsed.data.challenge}`);
  if (!challenge) return c.json({ ok: false, error: 'challenge_expired' }, 400);
  const passkey = await getPasskey(c.env.DB, response.id);
  if (!passkey) return c.json({ ok: false, error: 'unknown_credential' }, 400);
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: origin(c),
      expectedRPID: new URL(origin(c)).hostname,
      credential: {
        id: passkey.id,
        publicKey: new Uint8Array(passkey.public_key),
        counter: passkey.counter,
        transports: transports(passkey.transports),
      },
      requireUserVerification: false,
    });
  } catch (error) {
    logWarn({ evt: 'auth.login.verify_failed', err: String(error) });
    return c.json({ ok: false, error: 'verification_failed' }, 400);
  }
  if (!verification.verified || !verification.authenticationInfo)
    return c.json({ ok: false, error: 'not_verified' }, 400);
  const owner = await getOrCreateOwner(c.env.DB, c.env.OWNER_LABEL);
  await updatePasskeyUsage(
    c.env.DB,
    passkey.id,
    verification.authenticationInfo.newCounter,
    Math.floor(Date.now() / 1000),
  );
  await c.env.SESSIONS.delete(`pk:auth:${clientDataParsed.data.challenge}`);
  setSessionCookie(c, await signSession({ sub: owner.id, label: owner.label }, c.env));
  await logAudit(c.env.DB, { actor: owner.id, action: 'login.passkey', target: passkey.id });
  return c.json({ ok: true });
});
passkeyRoutes.patch('/:id', requireSession, async (c) => {
  const session = c.get('session');
  const parsed = renameBody.safeParse(await c.req.json().catch(() => null));
  if (!session) return c.json({ ok: false, error: 'unauthorized' }, 401);
  if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
  if (!(await renamePasskey(c.env.DB, c.req.param('id'), session.sub, parsed.data.name)))
    return c.json({ ok: false, error: 'not_found' }, 404);
  return c.json({ ok: true });
});
passkeyRoutes.delete('/:id', requireSession, async (c) => {
  const session = c.get('session');
  if (!session) return c.json({ ok: false, error: 'unauthorized' }, 401);
  const passkeys = await getPasskeys(c.env.DB, session.sub);
  if (passkeys.length <= 1 && passkeys.some((passkey) => passkey.id === c.req.param('id')))
    return c.json({ ok: false, error: 'last_passkey' }, 409);
  if (!(await deletePasskey(c.env.DB, c.req.param('id'), session.sub)))
    return c.json({ ok: false, error: 'not_found' }, 404);
  return c.json({ ok: true });
});
