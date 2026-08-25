import type { Context, Next } from 'hono';
import { z } from 'zod';
import { enrolSecretMatches, getSession } from './auth';
import { logWarn } from './log';
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

export function clientIp(request: Request): string {
  return (
    request.headers.get('CF-Connecting-IP') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  );
}

const enrolBody = z.object({ enrolSecret: z.string().min(1).max(256) }).partial();

export async function requireEnrolAuth<Path extends string, Input extends object>(
  c: Context<{ Bindings: CloudflareEnv; Variables: AuthVars }, Path, Input>,
  next: Next,
): Promise<Response | void> {
  const session = await getSession(c);
  if (session) {
    c.set('session', session);
    c.set('enrolMethod', 'session');
    await next();
    return;
  }

  let candidate = c.req.header('x-enrol-secret') ?? null;
  if (!candidate && c.req.method === 'POST') {
    const body = await boundedJson(c.req.raw, MAX_AUTH_JSON_BYTES);
    c.set('requestBody', body);
    const parsed = enrolBody.safeParse(body);
    candidate = parsed.success ? (parsed.data.enrolSecret ?? null) : null;
  }

  const rate = candidate
    ? await enforceRateLimit(c.env, `enrol:${clientIp(c.req.raw)}`, 10, 15 * 60)
    : null;
  const existingPasskey = await c.env.DB.prepare('SELECT 1 FROM passkeys LIMIT 1').first();
  if (!candidate || !rate?.allowed || !enrolSecretMatches(candidate, c.env) || existingPasskey) {
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
