import type { Context, Next } from 'hono';
import { z } from 'zod';
import { inviteTokenSchema } from '@pokedex/shared';
import { enrolSecretMatches, getSession, getUserById } from './auth';
import { logWarn } from './log';
import { lookupInvite } from './people';
import { boundedJson, MAX_AUTH_JSON_BYTES } from './request';
import type { AuthVars } from './types';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfter: number;
}

export type ChallengeKind = 'authentication' | 'registration';

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

async function coordinatorName(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function coordinator(env: CloudflareEnv, namespace: string, value: string) {
  const name = await coordinatorName(`${namespace}:${value}`);
  return env.AUTH_COORDINATOR.getByName(name);
}

export async function enforceRateLimit(
  env: CloudflareEnv,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const stub = await coordinator(env, 'rate', key);
  return stub.rateLimit('requests', limit, windowSeconds, nowSeconds());
}

export async function storeChallenge(
  env: CloudflareEnv,
  kind: ChallengeKind,
  subject: string,
  challenge: string,
  ttlSeconds = 300,
): Promise<void> {
  const stub = await coordinator(env, 'challenge', challenge);
  await stub.createChallenge(kind, subject, challenge, nowSeconds() + ttlSeconds);
}

export async function claimChallenge(
  env: CloudflareEnv,
  kind: ChallengeKind,
  subject: string,
  challenge: string,
): Promise<boolean> {
  const stub = await coordinator(env, 'challenge', challenge);
  return stub.consumeChallenge(kind, subject, challenge, nowSeconds());
}

export async function requireSession<Path extends string, Input extends object>(
  c: Context<{ Bindings: CloudflareEnv; Variables: AuthVars }, Path, Input>,
  next: Next,
): Promise<Response | void> {
  const session = await getSession(c);
  if (!session) return c.json({ ok: false, error: 'unauthorized' }, 401);
  c.set('session', session);
  await next();
}

// Layers on top of requireSession: looks the role up fresh from the users
// table on every request (never trusts the JWT for it) so a demotion takes
// effect on the demoted user's very next request, with no re-login needed.
export async function requireAdmin<Path extends string, Input extends object>(
  c: Context<{ Bindings: CloudflareEnv; Variables: AuthVars }, Path, Input>,
  next: Next,
): Promise<Response | void> {
  const session = c.get('session');
  if (!session) return c.json({ ok: false, error: 'unauthorized' }, 401);
  const user = await getUserById(c.env.DB, session.sub);
  if (!user || user.disabled_at !== null) return c.json({ ok: false, error: 'unauthorized' }, 401);
  if (user.role !== 'admin') return c.json({ ok: false, error: 'forbidden' }, 403);
  await next();
}

export function clientIp(request: Request): string {
  return (
    request.headers.get('CF-Connecting-IP') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  );
}

const enrolBody = z
  .object({ enrolSecret: z.string().min(1).max(256), inviteToken: inviteTokenSchema })
  .partial();

export async function requireEnrolAuth<Path extends string, Input extends object>(
  c: Context<{ Bindings: CloudflareEnv; Variables: AuthVars }, Path, Input>,
  next: Next,
): Promise<Response | void> {
  const session = await getSession(c);
  if (session) {
    const user = await getUserById(c.env.DB, session.sub);
    if (!user || user.disabled_at !== null)
      return c.json({ ok: false, error: 'unauthorized' }, 401);
    c.set('session', session);
    c.set('enrolMethod', 'session');
    await next();
    return;
  }

  let enrolSecret: string | null = c.req.header('x-enrol-secret') ?? null;
  let inviteToken: string | null = null;
  if (c.req.method === 'POST') {
    const body = await boundedJson(c.req.raw, MAX_AUTH_JSON_BYTES);
    c.set('requestBody', body);
    const parsed = enrolBody.safeParse(body);
    if (parsed.success) {
      enrolSecret = enrolSecret ?? parsed.data.enrolSecret ?? null;
      inviteToken = parsed.data.inviteToken ?? null;
    }
  }

  if (inviteToken) {
    const rate = await enforceRateLimit(c.env, `invite:${clientIp(c.req.raw)}`, 20, 15 * 60);
    if (!rate.allowed) {
      c.header('retry-after', String(rate.retryAfter));
      return c.json({ ok: false, error: 'rate_limited' }, 429);
    }
    const invite = await lookupInvite(c.env.DB, inviteToken);
    if (!invite || !invite.valid) {
      logWarn({
        evt: 'auth.enrol.denied',
        requestId: c.get('requestId'),
        reason: invite?.used ? 'invite_used' : invite?.expired ? 'invite_expired' : 'invalid',
      });
      return c.json(
        {
          ok: false,
          error: invite?.used
            ? 'invite_used'
            : invite?.expired
              ? 'invite_expired'
              : 'invite_invalid',
        },
        invite ? 409 : 400,
      );
    }
    c.set('enrolMethod', 'invite');
    c.set('inviteToken', inviteToken);
    c.set('inviteLabel', invite.label);
    await next();
    return;
  }

  const rate = enrolSecret
    ? await enforceRateLimit(c.env, `enrol:${clientIp(c.req.raw)}`, 10, 15 * 60)
    : null;
  const existingPasskey = await c.env.DB.prepare('SELECT 1 FROM passkeys LIMIT 1').first();
  if (
    !enrolSecret ||
    !rate?.allowed ||
    !enrolSecretMatches(enrolSecret, c.env) ||
    existingPasskey
  ) {
    logWarn({
      evt: 'auth.enrol.denied',
      requestId: c.get('requestId'),
      reason: existingPasskey
        ? 'bootstrap_closed'
        : rate && !rate.allowed
          ? 'rate_limited'
          : 'invalid',
    });
    if (rate && !rate.allowed) c.header('retry-after', String(rate.retryAfter));
    const status = rate && !rate.allowed ? 429 : 401;
    return c.json({ ok: false, error: status === 429 ? 'rate_limited' : 'unauthorized' }, status);
  }
  c.set('enrolMethod', 'bootstrap');
  await next();
}
