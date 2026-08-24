import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { enrolSecretMatches, getSession } from './auth';
import { logWarn } from './log';
import type { AuthVars, SessionPayload } from './types';

export const requireSession: MiddlewareHandler<{
  Bindings: CloudflareEnv;
  Variables: AuthVars;
}> = async (c, next) => {
  const session = await getSession(c);
  if (!session) return c.json({ ok: false, error: 'unauthorized' }, 401);
  c.set('session', session);
  await next();
};

function clientIp(request: Request): string {
  return (
    request.headers.get('CF-Connecting-IP') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  );
}
async function rateLimit(
  env: CloudflareEnv,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<{ allowed: boolean; remaining: number }> {
  const now = Math.floor(Date.now() / 1000);
  const stored = await env.RATE_LIMIT.get<{ count: number; resetAt: number }>(key, 'json');
  if (!stored || stored.resetAt <= now) {
    await env.RATE_LIMIT.put(key, JSON.stringify({ count: 1, resetAt: now + windowSeconds }), {
      expirationTtl: windowSeconds,
    });
    return { allowed: true, remaining: limit - 1 };
  }
  const count = stored.count + 1;
  await env.RATE_LIMIT.put(key, JSON.stringify({ count, resetAt: stored.resetAt }), {
    expirationTtl: Math.max(1, stored.resetAt - now),
  });
  return { allowed: count <= limit, remaining: Math.max(0, limit - count) };
}

const enrolBody = z.object({ enrolSecret: z.string().min(1).max(256) }).partial();
export const requireEnrolAuth: MiddlewareHandler<{
  Bindings: CloudflareEnv;
  Variables: AuthVars;
}> = async (c, next) => {
  const session = await getSession(c);
  if (session) {
    c.set('session', session);
    await next();
    return;
  }
  let candidate = c.req.header('x-enrol-secret') ?? null;
  if (!candidate && c.req.method === 'POST') {
    const body: unknown = await c.req.json().catch(() => null);
    const parsed = enrolBody.safeParse(body);
    candidate = parsed.success ? (parsed.data.enrolSecret ?? null) : null;
  }
  if (
    !candidate ||
    !(await rateLimit(c.env, `enrol:${clientIp(c.req.raw)}`, 10, 900)).allowed ||
    !enrolSecretMatches(candidate, c.env)
  ) {
    logWarn({ evt: 'auth.enrol.denied', ip: clientIp(c.req.raw) });
    return c.json({ ok: false, error: 'unauthorized' }, 401);
  }
  await next();
};

export const sessionVariables = (session: SessionPayload | undefined): AuthVars => ({ session });
