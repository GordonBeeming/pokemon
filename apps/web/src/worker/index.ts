import { DurableObject } from 'cloudflare:workers';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { apiRoutes } from './routes/api';
import { passkeyRoutes } from './routes/auth/passkey';
import { sessionRoutes } from './routes/auth/session';
import type { ChallengeKind, RateLimitResult } from './lib/guards';
import { ApplicationError, describeError, logError, logInfo } from './lib/log';
import { applySecurityHeaders } from './lib/security-headers';
import type { AuthVars } from './lib/types';
export { BackupWorkflow } from './workflows/backup';
export { CatalogueSyncWorkflow } from './workflows/catalogue';
export { FxSyncWorkflow } from './workflows/fx';
export { PriceSyncWorkflow } from './workflows/pricing';

export class AuthCoordinator extends DurableObject<CloudflareEnv> {
  constructor(ctx: DurableObjectState, env: CloudflareEnv) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(() => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS rate_limits (
          bucket TEXT PRIMARY KEY NOT NULL,
          count INTEGER NOT NULL,
          reset_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS challenges (
          challenge TEXT PRIMARY KEY NOT NULL,
          kind TEXT NOT NULL,
          subject TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        );
      `);
      return Promise.resolve();
    });
  }

  rateLimit(bucket: string, limit: number, windowSeconds: number, now: number): RateLimitResult {
    if (!bucket || limit < 1 || windowSeconds < 1) throw new Error('invalid_rate_limit');
    const row = this.ctx.storage.sql
      .exec<{ count: number; reset_at: number }>(
        `INSERT INTO rate_limits (bucket, count, reset_at) VALUES (?, 1, ?)
         ON CONFLICT(bucket) DO UPDATE SET
           count = CASE WHEN rate_limits.reset_at <= ? THEN 1 ELSE rate_limits.count + 1 END,
           reset_at = CASE WHEN rate_limits.reset_at <= ? THEN excluded.reset_at ELSE rate_limits.reset_at END
         RETURNING count, reset_at`,
        bucket,
        now + windowSeconds,
        now,
        now,
      )
      .one();
    return {
      allowed: row.count <= limit,
      remaining: Math.max(0, limit - row.count),
      retryAfter: Math.max(1, row.reset_at - now),
    };
  }

  createChallenge(
    kind: ChallengeKind,
    subject: string,
    challenge: string,
    expiresAt: number,
  ): void {
    this.ctx.storage.sql.exec(
      'DELETE FROM challenges WHERE expires_at <= ?',
      Math.floor(Date.now() / 1000),
    );
    this.ctx.storage.sql.exec(
      'INSERT OR REPLACE INTO challenges (challenge, kind, subject, expires_at) VALUES (?, ?, ?, ?)',
      challenge,
      kind,
      subject,
      expiresAt,
    );
  }

  consumeChallenge(kind: ChallengeKind, subject: string, challenge: string, now: number): boolean {
    const result = this.ctx.storage.sql.exec(
      'DELETE FROM challenges WHERE challenge = ? AND kind = ? AND subject = ? AND expires_at > ?',
      challenge,
      kind,
      subject,
      now,
    );
    return result.rowsWritten === 1;
  }

  health(): boolean {
    this.ctx.storage.sql.exec('SELECT 1').one();
    return true;
  }
}

const app = new Hono<{ Bindings: CloudflareEnv; Variables: AuthVars }>();

app.use('*', async (c, next) => {
  const supplied = c.req.header('cf-ray') ?? c.req.header('x-request-id');
  const requestId =
    supplied && /^[A-Za-z0-9._:-]{1,128}$/u.test(supplied) ? supplied : crypto.randomUUID();
  const startedAt = Date.now();
  c.set('requestId', requestId);
  await next();
  c.header('x-request-id', requestId);
  applySecurityHeaders(c.res.headers, c.req.raw);
  logInfo({
    evt: 'worker.request.complete',
    requestId,
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    status: c.res.status,
    durationMs: Date.now() - startedAt,
  });
});

app.get('/api/live', (c) => c.json({ ok: true, ts: new Date().toISOString() }));

const ready = async (c: Context<{ Bindings: CloudflareEnv; Variables: AuthVars }>) => {
  try {
    const [database, latestBackup, latestCatalogue, r2, coordinator] = await Promise.all([
      c.env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>(),
      c.env.DB.prepare('SELECT MAX(created_at) AS created_at FROM backup_runs WHERE owner_id = ?1')
        .bind('owner')
        .first<{ created_at: number | null }>(),
      c.env.DB.prepare(
        "SELECT MAX(completed_at) AS completed_at FROM sync_runs WHERE status = 'complete'",
      ).first<{ completed_at: number | null }>(),
      c.env.ART.head('__pokedex_readiness__'),
      c.env.AUTH_COORDINATOR.getByName('readiness').health(),
    ]);
    void r2;
    if (database?.ok !== 1 || !coordinator) throw new Error('readiness_dependency_failed');
    return c.json({
      ok: true,
      dependencies: { database: 'ok', objectStorage: 'ok', coordinator: 'ok' },
      freshness: {
        backup: latestBackup?.created_at
          ? new Date(latestBackup.created_at * 1000).toISOString()
          : null,
        catalogue: latestCatalogue?.completed_at
          ? new Date(latestCatalogue.completed_at * 1000).toISOString()
          : null,
      },
      ts: new Date().toISOString(),
    });
  } catch (error) {
    logError({
      evt: 'health.readiness_failed',
      requestId: c.get('requestId'),
      err: describeError(error),
    });
    return c.json({ ok: false, error: 'not_ready', ts: new Date().toISOString() }, 503);
  }
};

app.get('/api/ready', ready);
app.get('/api/health', ready);
app.route('/api/auth/passkey', passkeyRoutes);
app.route('/api/auth', sessionRoutes);
app.route('/api', apiRoutes);
app.all('/api/*', (c) => c.json({ ok: false, error: 'not_found' }, 404));
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));
app.onError((error, c) => {
  const requestId = c.get('requestId') ?? crypto.randomUUID();
  if (error instanceof ApplicationError) {
    c.header('x-request-id', requestId);
    applySecurityHeaders(c.res.headers, c.req.raw);
    return c.json({ ok: false, error: error.code, requestId }, error.status);
  }
  logError({
    evt: 'worker.unhandled_error',
    requestId,
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    err: describeError(error),
  });
  c.header('x-request-id', requestId);
  applySecurityHeaders(c.res.headers, c.req.raw);
  return c.json({ ok: false, error: 'internal_error', requestId }, 500);
});

export default { fetch: app.fetch } satisfies ExportedHandler<CloudflareEnv>;
