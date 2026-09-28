import { Hono } from 'hono';
import { z } from 'zod';
import { invitePublicStatusSchema } from '@pokedex/shared';
import {
  clearSessionCookie,
  createSession,
  createUser,
  getFirstActiveAdmin,
  getSession,
  getUserById,
  isLoopbackHost,
  logAudit,
  revokeSession,
  setSessionCookie,
} from '../../lib/auth';
import { clientIp, enforceRateLimit } from '../../lib/guards';
import { lookupInvite } from '../../lib/people';
import { boundedJson, MAX_AUTH_JSON_BYTES } from '../../lib/request';
import type { AuthVars } from '../../lib/types';

const devLoginBody = z.object({ userId: z.string().trim().min(1).max(128) }).partial();

export const sessionRoutes = new Hono<{ Bindings: CloudflareEnv; Variables: AuthVars }>();
sessionRoutes.get('/me', async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ ok: false, error: 'unauthorized' }, 401);
  const user = await getUserById(c.env.DB, session.sub);
  if (!user || user.disabled_at !== null) return c.json({ ok: false, error: 'unauthorized' }, 401);
  return c.json({ ok: true, sub: session.sub, label: session.label, role: user.role });
});
sessionRoutes.post('/logout', async (c) => {
  const session = await getSession(c);
  clearSessionCookie(c);
  if (session) {
    await revokeSession(c.env.DB, session);
    await logAudit(c.env.DB, { actor: session.sub, action: 'logout' });
  }
  return c.json({ ok: true });
});
sessionRoutes.post('/dev-login', async (c) => {
  const host = new URL(c.req.raw.url).hostname;
  if (!isLoopbackHost(host)) return c.json({ ok: false, error: 'not_found' }, 404);
  // A body is optional (existing callers send none, which means "sign in as
  // the first active admin"); only parse one if the caller actually sent it.
  const contentLength = c.req.header('content-length');
  let userId: string | undefined;
  if (contentLength && contentLength !== '0') {
    const parsed = devLoginBody.safeParse(await boundedJson(c.req.raw, MAX_AUTH_JSON_BYTES));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    userId = parsed.data.userId;
  }
  // No userId given and nobody has bootstrapped yet: dev-login is the
  // loopback-only convenience that has always let local dev/CI start from a
  // completely empty database without a real WebAuthn ceremony, so it keeps
  // that by creating the first admin on demand rather than 404ing.
  const user = userId
    ? await getUserById(c.env.DB, userId)
    : ((await getFirstActiveAdmin(c.env.DB)) ??
      (await createUser(c.env.DB, c.env.OWNER_LABEL, 'admin')));
  if (!user) return c.json({ ok: false, error: 'not_found' }, 404);
  if (user.disabled_at !== null) return c.json({ ok: false, error: 'user_disabled' }, 403);
  setSessionCookie(c, await createSession(c.env.DB, { sub: user.id, label: user.label }, c.env));
  await logAudit(c.env.DB, { actor: user.id, action: 'login.dev' });
  return c.json({ ok: true });
});

sessionRoutes.get('/invites/:token', async (c) => {
  const rate = await enforceRateLimit(c.env, `invite-lookup:${clientIp(c.req.raw)}`, 20, 15 * 60);
  if (!rate.allowed) {
    c.header('retry-after', String(rate.retryAfter));
    return c.json({ ok: false, error: 'rate_limited' }, 429);
  }
  const invite = await lookupInvite(c.env.DB, c.req.param('token'));
  const status = invite ?? {
    valid: false,
    expired: false,
    used: false,
    label: null,
    role: null,
    expiresAt: null,
    invitedBy: null,
  };
  return c.json({ ok: true, ...invitePublicStatusSchema.parse(status) });
});
