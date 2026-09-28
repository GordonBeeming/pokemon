import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { Hono } from 'hono';
import { z } from 'zod';
import { inviteTokenSchema } from '@pokedex/shared';
import { base64UrlDecode } from '../../lib/crypto';
import {
  clearSessionCookie,
  createSession,
  createUser,
  deletePasskey,
  getPasskey,
  getPasskeys,
  getUserById,
  insertPasskey,
  insertBootstrapPasskey,
  logAudit,
  renamePasskey,
  setSessionCookie,
  updatePasskeyUsage,
} from '../../lib/auth';
import {
  claimChallenge,
  clientIp,
  enforceRateLimit,
  requireEnrolAuth,
  requireSession,
  storeChallenge,
} from '../../lib/guards';
import type { RateLimitResult } from '../../lib/guards';
import { describeError, logWarn } from '../../lib/log';
import { claimInviteForNewUser } from '../../lib/people';
import { boundedJson, MAX_AUTH_JSON_BYTES } from '../../lib/request';
import type {
  AuthVars,
  AuthenticationResponseShape,
  RegistrationResponseShape,
} from '../../lib/types';

const nameSchema = z.string().trim().min(1).max(60);
const registrationBody = z.object({
  response: z.unknown(),
  enrolSecret: z.string().max(256).optional(),
  inviteToken: inviteTokenSchema.optional(),
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

export function passkeyIdentity(ownerLabel: string): {
  rpName: string;
  userName: string;
  userDisplayName: string;
} {
  const userDisplayName = ownerLabel.trim();
  const userName = userDisplayName
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '.')
    .replace(/^\.+|\.+$/gu, '');
  return {
    rpName: `${userDisplayName || 'Owner'}'s Pokédex`,
    userName: userName || 'member',
    userDisplayName: userDisplayName || 'Owner',
  };
}

function responseChallenge(clientDataJSON: string): string | null {
  try {
    const decoded = new TextDecoder().decode(base64UrlDecode(clientDataJSON));
    const parsed = z
      .object({ challenge: z.string().min(1).max(512) })
      .safeParse(JSON.parse(decoded));
    return parsed.success ? parsed.data.challenge : null;
  } catch {
    return null;
  }
}

async function limitOptions(c: {
  env: CloudflareEnv;
  req: { raw: Request };
}): Promise<RateLimitResult | null> {
  const rate = await enforceRateLimit(c.env, `passkey-options:${clientIp(c.req.raw)}`, 20, 5 * 60);
  return rate.allowed ? null : rate;
}

// Login is a discoverable-credential (resident key) flow: the authenticator
// tells us who's signing in, not the other way around, so there's no real
// subject to key the challenge on until after verification resolves one.
const LOGIN_CHALLENGE_SUBJECT = 'login';
// Mirrors LOGIN_CHALLENGE_SUBJECT for the one enrolment path with no user
// row yet at options time either.
const BOOTSTRAP_CHALLENGE_SUBJECT = 'bootstrap';

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
  const limited = await limitOptions(c);
  if (limited) {
    c.header('retry-after', String(limited.retryAfter));
    return c.json({ ok: false, error: 'rate_limited' }, 429);
  }
  const method = c.get('enrolMethod');
  const session = c.get('session');
  // For bootstrap/invite there's no user row yet — the WebAuthn userID here
  // is a throwaway ceremony handle, not looked at again once verify creates
  // the real account, so a random one is fine.
  const { label, userIdBytes, existing, challengeSubject } =
    method === 'session' && session
      ? {
          label: session.label,
          userIdBytes: new TextEncoder().encode(session.sub),
          existing: await getPasskeys(c.env.DB, session.sub),
          challengeSubject: session.sub,
        }
      : method === 'invite'
        ? {
            label: c.get('inviteLabel') ?? 'New member',
            userIdBytes: crypto.getRandomValues(new Uint8Array(32)),
            existing: [],
            challengeSubject: c.get('inviteToken') ?? '',
          }
        : {
            label: c.env.OWNER_LABEL,
            userIdBytes: crypto.getRandomValues(new Uint8Array(32)),
            existing: [],
            challengeSubject: BOOTSTRAP_CHALLENGE_SUBJECT,
          };
  const identity = passkeyIdentity(label);
  const options = await generateRegistrationOptions({
    rpName: identity.rpName,
    rpID: new URL(origin(c)).hostname,
    userID: userIdBytes,
    userName: identity.userName,
    userDisplayName: identity.userDisplayName,
    attestationType: 'none',
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    excludeCredentials: existing.map((passkey) => ({
      id: passkey.id,
      transports: transports(passkey.transports),
    })),
  });
  await storeChallenge(c.env, 'registration', challengeSubject, options.challenge);
  return c.json(options);
});
passkeyRoutes.post('/register/verify', requireEnrolAuth, async (c) => {
  const parsed = registrationBody.safeParse(
    c.get('requestBody') ?? (await boundedJson(c.req.raw, MAX_AUTH_JSON_BYTES)),
  );
  if (!parsed.success || !registrationResponse(parsed.data.response))
    return c.json({ ok: false, error: 'invalid_body' }, 400);
  const method = c.get('enrolMethod');
  const session = c.get('session');
  const challengeSubject =
    method === 'session' && session
      ? session.sub
      : method === 'invite'
        ? (c.get('inviteToken') ?? '')
        : BOOTSTRAP_CHALLENGE_SUBJECT;
  const challenge = responseChallenge(parsed.data.response.response.clientDataJSON);
  if (!challenge || !(await claimChallenge(c.env, 'registration', challengeSubject, challenge)))
    return c.json({ ok: false, error: 'challenge_expired' }, 400);
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: parsed.data.response,
      expectedChallenge: challenge,
      expectedOrigin: origin(c),
      expectedRPID: new URL(origin(c)).hostname,
      requireUserVerification: true,
    });
  } catch (error) {
    logWarn({
      evt: 'auth.register.verify_failed',
      requestId: c.get('requestId'),
      err: describeError(error),
    });
    return c.json({ ok: false, error: 'verification_failed' }, 400);
  }
  if (!verification.verified || !verification.registrationInfo)
    return c.json({ ok: false, error: 'not_verified' }, 400);
  const credential = verification.registrationInfo.credential;

  // Only session (adding a passkey to yourself) has a user already; bootstrap
  // and invite each create the account here, now that the ceremony proved a
  // real authenticator is behind it.
  let user: { id: string; label: string };
  if (method === 'session' && session) {
    user = { id: session.sub, label: session.label };
  } else if (method === 'invite') {
    user = await claimInviteForNewUser(
      c.env.DB,
      c.get('inviteToken') ?? '',
      c.get('inviteLabel') ?? 'New member',
    );
  } else {
    user = await createUser(c.env.DB, c.env.OWNER_LABEL, 'admin');
  }

  const passkey = {
    id: credential.id,
    userId: user.id,
    publicKey: credential.publicKey,
    counter: credential.counter,
    transports: credential.transports?.join(',') ?? null,
    deviceLabel: null,
    name: parsed.data.name ?? null,
    createdAt: Math.floor(Date.now() / 1000),
  };
  if (method === 'bootstrap') {
    if (!(await insertBootstrapPasskey(c.env.DB, passkey))) {
      // Lost the race to a concurrent bootstrap attempt — don't leave an
      // orphan admin account with no passkey behind.
      await c.env.DB.prepare('DELETE FROM users WHERE id = ?1').bind(user.id).run();
      return c.json({ ok: false, error: 'bootstrap_closed' }, 409);
    }
  } else {
    await insertPasskey(c.env.DB, passkey);
  }
  await logAudit(c.env.DB, { actor: user.id, action: 'passkey.register', target: credential.id });
  setSessionCookie(c, await createSession(c.env.DB, { sub: user.id, label: user.label }, c.env));
  return c.json({ ok: true });
});
passkeyRoutes.post('/auth/options', async (c) => {
  const limited = await limitOptions(c);
  if (limited) {
    c.header('retry-after', String(limited.retryAfter));
    return c.json({ ok: false, error: 'rate_limited' }, 429);
  }
  const options = await generateAuthenticationOptions({
    rpID: new URL(origin(c)).hostname,
    userVerification: 'required',
  });
  await storeChallenge(c.env, 'authentication', LOGIN_CHALLENGE_SUBJECT, options.challenge);
  return c.json(options);
});
passkeyRoutes.post('/auth/verify', async (c) => {
  const parsed = authenticationBody.safeParse(await boundedJson(c.req.raw, MAX_AUTH_JSON_BYTES));
  if (!parsed.success || !authenticationResponse(parsed.data.response))
    return c.json({ ok: false, error: 'invalid_body' }, 400);
  const response = parsed.data.response;
  const challenge = responseChallenge(response.response.clientDataJSON);
  if (!challenge) return c.json({ ok: false, error: 'missing_challenge' }, 400);
  if (!(await claimChallenge(c.env, 'authentication', LOGIN_CHALLENGE_SUBJECT, challenge)))
    return c.json({ ok: false, error: 'challenge_expired' }, 400);
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
      requireUserVerification: true,
    });
  } catch (error) {
    logWarn({
      evt: 'auth.login.verify_failed',
      requestId: c.get('requestId'),
      err: describeError(error),
    });
    return c.json({ ok: false, error: 'verification_failed' }, 400);
  }
  if (!verification.verified || !verification.authenticationInfo)
    return c.json({ ok: false, error: 'not_verified' }, 400);
  // The credential, not any session or bootstrap state, is what says who's
  // logging in — this resolves the actual account behind it rather than
  // assuming a single fixed owner.
  const user = await getUserById(c.env.DB, passkey.user_id);
  if (!user) return c.json({ ok: false, error: 'unknown_credential' }, 400);
  if (user.disabled_at !== null) return c.json({ ok: false, error: 'user_disabled' }, 403);
  await updatePasskeyUsage(
    c.env.DB,
    passkey.id,
    verification.authenticationInfo.newCounter,
    Math.floor(Date.now() / 1000),
  );
  setSessionCookie(c, await createSession(c.env.DB, { sub: user.id, label: user.label }, c.env));
  await logAudit(c.env.DB, { actor: user.id, action: 'login.passkey', target: passkey.id });
  return c.json({ ok: true });
});
passkeyRoutes.patch('/:id', requireSession, async (c) => {
  const session = c.get('session');
  const parsed = renameBody.safeParse(await boundedJson(c.req.raw, MAX_AUTH_JSON_BYTES));
  if (!session) return c.json({ ok: false, error: 'unauthorized' }, 401);
  if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
  if (!(await renamePasskey(c.env.DB, c.req.param('id'), session.sub, parsed.data.name)))
    return c.json({ ok: false, error: 'not_found' }, 404);
  return c.json({ ok: true });
});
passkeyRoutes.delete('/:id', requireSession, async (c) => {
  const session = c.get('session');
  if (!session) return c.json({ ok: false, error: 'unauthorized' }, 401);
  const result = await deletePasskey(c.env.DB, c.req.param('id'), session.sub);
  if (result === 'last_passkey') return c.json({ ok: false, error: 'last_passkey' }, 409);
  if (result === 'not_found') return c.json({ ok: false, error: 'not_found' }, 404);
  clearSessionCookie(c);
  return c.json({ ok: true });
});
