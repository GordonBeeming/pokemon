import { Hono } from 'hono';
import { uploadArt } from '../../lib/art';
import { redeemPairCode } from '../../lib/desktop-auth';
import { clientIp, enforceRateLimit } from '../../lib/guards';
import { ApplicationError } from '../../lib/log';
import type { AuthVars } from '../../lib/types';
import { apiFailure, parsedJson } from './errors';
import { parseDesktopBearer, redeemBody } from './contracts';

export const publicApiRoutes = new Hono<{ Bindings: CloudflareEnv; Variables: AuthVars }>();

publicApiRoutes.post('/desktop/pair/redeem', async (c) => {
  try {
    const rate = await enforceRateLimit(c.env, `pair:${clientIp(c.req.raw)}`, 6, 15 * 60);
    if (!rate.allowed) {
      c.header('retry-after', String(rate.retryAfter));
      return c.json({ ok: false, error: 'rate_limited', requestId: c.get('requestId') }, 429);
    }
    const parsed = redeemBody.safeParse(await parsedJson(c.req.raw));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const token = await redeemPairCode(c.env.DB, parsed.data.code, parsed.data.label);
    return c.json({ ok: true, ...token });
  } catch (error) {
    return apiFailure(c, error);
  }
});

publicApiRoutes.put('/desktop/art/uploads/:token', async (c) => {
  try {
    const pathTicket = c.req.param('token');
    const token =
      parseDesktopBearer(c.req.header('authorization')) ??
      (/^[a-f0-9]{64}$/iu.test(pathTicket) ? pathTicket : null);
    if (!token)
      return c.json(
        { ok: false, error: 'art_upload_token_invalid', requestId: c.get('requestId') },
        401,
      );
    return c.json({
      ok: true,
      ...(await uploadArt(c.env.DB, c.env.ART, token, pathTicket, c.req.raw)),
    });
  } catch (error) {
    if (error instanceof ApplicationError && error.code === 'art_upload_in_progress')
      c.header('retry-after', '2');
    return apiFailure(c, error);
  }
});
