import { Hono } from 'hono';
import { createInviteRequestSchema, patchPersonRequestSchema } from '@pokedex/shared';
import { requireAdmin, requireSession } from '../../lib/guards';
import {
  cancelInvite,
  createInvite,
  getPerson,
  listInvites,
  listPeople,
  patchPerson,
} from '../../lib/people';
import { ApplicationError } from '../../lib/log';
import type { AuthVars } from '../../lib/types';
import { apiFailure, parsedJson } from './errors';
import { sessionOwner } from './contracts';

export const peopleRoutes = new Hono<{ Bindings: CloudflareEnv; Variables: AuthVars }>();

// The lead flips this at cutover, once the new SPA has a real route to land
// an invitee on; it isn't wired to anything else in the meantime.
const INVITE_LANDING_PATH = '/invite';

function requestOrigin(c: { req: { raw: Request }; env: CloudflareEnv }): string {
  return c.env.PUBLIC_ORIGIN || new URL(c.req.raw.url).origin;
}

peopleRoutes.get('/people/me', requireSession, async (c) => {
  try {
    const person = await getPerson(c.env.DB, sessionOwner(c));
    if (!person) throw new ApplicationError('person_not_found', 404);
    return c.json({ ok: true, person });
  } catch (error) {
    return apiFailure(c, error);
  }
});

peopleRoutes.get('/people', requireSession, requireAdmin, async (c) => {
  try {
    return c.json({ ok: true, people: await listPeople(c.env.DB) });
  } catch (error) {
    return apiFailure(c, error);
  }
});

peopleRoutes.patch('/people/:id', requireSession, requireAdmin, async (c) => {
  try {
    const parsed = patchPersonRequestSchema.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const person = await patchPerson(c.env.DB, c.req.param('id'), parsed.data);
    return c.json({ ok: true, person });
  } catch (error) {
    return apiFailure(c, error);
  }
});

peopleRoutes.get('/people/invites', requireSession, requireAdmin, async (c) => {
  try {
    return c.json({ ok: true, invites: await listInvites(c.env.DB) });
  } catch (error) {
    return apiFailure(c, error);
  }
});

peopleRoutes.post('/people/invites', requireSession, requireAdmin, async (c) => {
  try {
    const parsed = createInviteRequestSchema.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const { id, token, expiresAt } = await createInvite(c.env.DB, sessionOwner(c), parsed.data);
    return c.json(
      { ok: true, id, inviteUrl: `${requestOrigin(c)}${INVITE_LANDING_PATH}/${token}`, expiresAt },
      201,
    );
  } catch (error) {
    return apiFailure(c, error);
  }
});

peopleRoutes.delete('/people/invites/:id', requireSession, requireAdmin, async (c) => {
  try {
    const cancelled = await cancelInvite(c.env.DB, c.req.param('id'));
    return cancelled ? c.json({ ok: true }) : c.json({ ok: false, error: 'invite_not_found' }, 404);
  } catch (error) {
    return apiFailure(c, error);
  }
});
