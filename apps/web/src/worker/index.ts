import { Hono } from 'hono';
import { passkeyRoutes } from './routes/auth/passkey';
import { sessionRoutes } from './routes/auth/session';
import { describeError, logError } from './lib/log';

const app = new Hono<{ Bindings: CloudflareEnv }>();
app.get('/api/health', async (c) => {
  try {
    await c.env.DB.prepare('SELECT 1').first();
    return c.json({ ok: true, database: 'ok', ts: new Date().toISOString() });
  } catch (error) {
    logError({ evt: 'health.db_unreachable', err: describeError(error) });
    return c.json({ ok: false, database: 'unreachable', ts: new Date().toISOString() }, 503);
  }
});
app.route('/api/auth/passkey', passkeyRoutes);
app.route('/api/auth', sessionRoutes);
app.all('/api/*', (c) => c.json({ ok: false, error: 'not_found' }, 404));
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));
app.onError((error, c) => {
  logError({
    evt: 'worker.unhandled_error',
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    err: describeError(error),
  });
  return c.json({ ok: false, error: 'internal_error' }, 500);
});

export default { fetch: app.fetch } satisfies ExportedHandler<CloudflareEnv>;
