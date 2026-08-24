import { Hono } from 'hono';
import {
  clearSessionCookie,
  createSession,
  getOrCreateOwner,
  getSession,
  logAudit,
  revokeSession,
  setSessionCookie,
} from '../../lib/auth';
import type { AuthVars } from '../../lib/types';

export const sessionRoutes = new Hono<{ Bindings: CloudflareEnv; Variables: AuthVars }>();
sessionRoutes.get('/me', async (c) => {
  const session = await getSession(c);
  return session
    ? c.json({ ok: true, sub: session.sub, label: session.label })
    : c.json({ ok: false, error: 'unauthorized' }, 401);
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
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1')
    return c.json({ ok: false, error: 'not_found' }, 404);
  const owner = await getOrCreateOwner(c.env.DB, c.env.OWNER_LABEL);
  setSessionCookie(c, await createSession(c.env.DB, { sub: owner.id, label: owner.label }, c.env));
  await logAudit(c.env.DB, { actor: owner.id, action: 'login.dev' });
  return c.json({ ok: true });
});
