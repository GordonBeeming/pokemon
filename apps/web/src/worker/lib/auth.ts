import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Context } from 'hono';
import { jwtVerify, SignJWT } from 'jose';
import type { UserRole } from '@pokedex/shared';
import { timingSafeStringEqual } from './crypto';
import { newId, nowSeconds } from './db';
import type { AuditInsert, PasskeyInsert, PasskeyRow, SessionPayload, UserRow } from './types';

export const SESSION_COOKIE = 'pokedex_session';
export const SESSION_MAX_AGE = 60 * 60 * 24 * 7;
const SESSION_ACTIVITY_INTERVAL = 60 * 60;
type SessionEnv = Pick<CloudflareEnv, 'SESSION_SECRET' | 'SESSION_SECRET_PREV'>;
type AuthContext<
  Path extends string = string,
  Input extends object = Record<string, never>,
> = Context<{ Bindings: CloudflareEnv; Variables: import('./types').AuthVars }, Path, Input>;

async function hashIdentifier(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function randomIdentifier(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function signSession(
  payload: Omit<SessionPayload, 'iat' | 'exp'>,
  env: SessionEnv,
): Promise<string> {
  if (new TextEncoder().encode(env.SESSION_SECRET).byteLength < 32)
    throw new Error('SESSION_SECRET must be at least 32 bytes');
  const now = nowSeconds();
  return new SignJWT({ label: payload.label, sid: payload.sid, epoch: payload.epoch })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setExpirationTime(now + SESSION_MAX_AGE)
    .setSubject(payload.sub)
    .sign(new TextEncoder().encode(env.SESSION_SECRET));
}

async function verifyWithSecret(token: string, secret: string): Promise<SessionPayload | null> {
  try {
    const result = await jwtVerify(token, new TextEncoder().encode(secret), {
      algorithms: ['HS256'],
    });
    const { sub, label, sid, epoch, iat, exp } = result.payload;
    if (
      typeof sub !== 'string' ||
      typeof label !== 'string' ||
      typeof sid !== 'string' ||
      typeof epoch !== 'number' ||
      typeof iat !== 'number' ||
      typeof exp !== 'number'
    )
      return null;
    return { sub, label, sid, epoch, iat, exp };
  } catch {
    return null;
  }
}

export async function verifySession(
  token: string,
  env: SessionEnv,
): Promise<SessionPayload | null> {
  const current = await verifyWithSecret(token, env.SESSION_SECRET);
  return (
    current ?? (env.SESSION_SECRET_PREV ? verifyWithSecret(token, env.SESSION_SECRET_PREV) : null)
  );
}

export async function createSession(
  db: D1Database,
  payload: Pick<SessionPayload, 'sub' | 'label'>,
  env: SessionEnv,
): Promise<string> {
  const owner = await db
    .prepare('SELECT mutation_epoch FROM users WHERE id = ?1')
    .bind(payload.sub)
    .first<{ mutation_epoch: number }>();
  if (!owner) throw new Error('session_owner_not_found');
  const sid = randomIdentifier();
  const now = nowSeconds();
  await db.batch([
    db
      .prepare(
        'DELETE FROM web_sessions WHERE expires_at <= ?1 OR (revoked_at IS NOT NULL AND revoked_at <= ?2)',
      )
      .bind(now, now - SESSION_MAX_AGE),
    db
      .prepare(
        'INSERT INTO web_sessions (id_hash, user_id, mutation_epoch, expires_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5)',
      )
      .bind(
        await hashIdentifier(sid),
        payload.sub,
        owner.mutation_epoch,
        now + SESSION_MAX_AGE,
        now,
      ),
  ]);
  return signSession({ ...payload, sid, epoch: owner.mutation_epoch }, env);
}

export function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

export function cookieSecureFor(request: Request): boolean {
  const host = new URL(request.url).hostname;
  return !isLoopbackHost(host);
}

export async function getSession<Path extends string, Input extends object>(
  c: AuthContext<Path, Input>,
): Promise<SessionPayload | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const session = await verifySession(token, c.env);
  if (!session) return null;
  const now = nowSeconds();
  const stored = await c.env.DB.prepare(
    `SELECT s.last_seen_at FROM web_sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id_hash = ?1 AND s.user_id = ?2 AND s.mutation_epoch = ?3
       AND u.mutation_epoch = s.mutation_epoch AND s.revoked_at IS NULL AND s.expires_at > ?4`,
  )
    .bind(await hashIdentifier(session.sid), session.sub, session.epoch, now)
    .first<{ last_seen_at: number | null }>();
  if (!stored) return null;
  if (stored.last_seen_at === null || stored.last_seen_at <= now - SESSION_ACTIVITY_INTERVAL) {
    await c.env.DB.prepare(
      'UPDATE web_sessions SET last_seen_at = ?1 WHERE id_hash = ?2 AND (last_seen_at IS NULL OR last_seen_at <= ?3)',
    )
      .bind(now, await hashIdentifier(session.sid), now - SESSION_ACTIVITY_INTERVAL)
      .run();
  }
  return session;
}

export function setSessionCookie<Path extends string, Input extends object>(
  c: AuthContext<Path, Input>,
  token: string,
): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: cookieSecureFor(c.req.raw),
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_MAX_AGE,
  });
}

export function clearSessionCookie<Path extends string, Input extends object>(
  c: AuthContext<Path, Input>,
): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

export async function revokeSession(db: D1Database, session: SessionPayload): Promise<void> {
  await db
    .prepare(
      'UPDATE web_sessions SET revoked_at = ?1 WHERE id_hash = ?2 AND user_id = ?3 AND revoked_at IS NULL',
    )
    .bind(nowSeconds(), await hashIdentifier(session.sid), session.sub)
    .run();
}

export function enrolSecretMatches(
  input: string,
  env: Pick<CloudflareEnv, 'ENROLL_SECRET'>,
): boolean {
  return timingSafeStringEqual(input, env.ENROLL_SECRET);
}

const USER_COLUMNS = 'id, label, role, disabled_at, mutation_epoch, created_at';

export async function getUserById(db: D1Database, id: string): Promise<UserRow | null> {
  return db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?1`).bind(id).first<UserRow>();
}

// Every user (bootstrap admin, invited member, or one an admin creates by
// hand later) gets a random id — nothing in runtime code depends on a fixed
// 'owner' id any more; that literal only remains in migrations, which set it
// on the one account that already existed before multi-user shipped.
export async function createUser(db: D1Database, label: string, role: UserRole): Promise<UserRow> {
  const id = newId('user');
  const now = nowSeconds();
  await db
    .prepare('INSERT INTO users (id, label, role, created_at) VALUES (?1, ?2, ?3, ?4)')
    .bind(id, label, role, now)
    .run();
  const created = await getUserById(db, id);
  if (!created) throw new Error('user_create_failed');
  return created;
}

// Used by dev-login (loopback only) and nothing else: picks a stable,
// deterministic account to sign in as when the caller didn't ask for a
// specific user id.
export async function getFirstActiveAdmin(db: D1Database): Promise<UserRow | null> {
  return db
    .prepare(
      `SELECT ${USER_COLUMNS} FROM users WHERE role = 'admin' AND disabled_at IS NULL
       ORDER BY created_at ASC, id ASC LIMIT 1`,
    )
    .first<UserRow>();
}

export async function getPasskeys(db: D1Database, userId: string): Promise<PasskeyRow[]> {
  const result = await db
    .prepare(
      'SELECT id, user_id, public_key, counter, transports, device_label, name, last_used_at, created_at FROM passkeys WHERE user_id = ?1 ORDER BY created_at DESC',
    )
    .bind(userId)
    .all<PasskeyRow>();
  return result.results;
}

export async function getPasskey(db: D1Database, id: string): Promise<PasskeyRow | null> {
  return db
    .prepare(
      'SELECT id, user_id, public_key, counter, transports, device_label, name, last_used_at, created_at FROM passkeys WHERE id = ?1',
    )
    .bind(id)
    .first<PasskeyRow>();
}

function passkeyInsert(db: D1Database, input: PasskeyInsert, bootstrapOnly: boolean) {
  const values = '(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)';
  // Bootstrap's guard is global ("no passkey exists anywhere yet"), not
  // per-user: with multiple real users now possible, checking only this
  // user's own passkeys would let bootstrap re-fire for every new invitee.
  const sql = bootstrapOnly
    ? `INSERT INTO passkeys (id, user_id, public_key, counter, transports, device_label, name, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8 WHERE NOT EXISTS (SELECT 1 FROM passkeys)`
    : `INSERT INTO passkeys (id, user_id, public_key, counter, transports, device_label, name, created_at) VALUES ${values}`;
  return db
    .prepare(sql)
    .bind(
      input.id,
      input.userId,
      input.publicKey,
      input.counter,
      input.transports,
      input.deviceLabel,
      input.name,
      input.createdAt,
    );
}

export async function insertPasskey(db: D1Database, input: PasskeyInsert): Promise<void> {
  await passkeyInsert(db, input, false).run();
}

export async function insertBootstrapPasskey(
  db: D1Database,
  input: PasskeyInsert,
): Promise<boolean> {
  // Safe to trust meta.changes here, unlike deletePasskey below: passkeys
  // only has an AFTER DELETE trigger (migration 006), nothing on INSERT.
  const result = await passkeyInsert(db, input, true).run();
  return result.meta.changes === 1;
}

export async function updatePasskeyUsage(
  db: D1Database,
  id: string,
  counter: number,
  usedAt: number,
): Promise<void> {
  await db
    .prepare('UPDATE passkeys SET counter = MAX(counter, ?1), last_used_at = ?2 WHERE id = ?3')
    .bind(counter, usedAt, id)
    .run();
}

export async function renamePasskey(
  db: D1Database,
  id: string,
  userId: string,
  name: string | null,
): Promise<boolean> {
  // Same reasoning as insertBootstrapPasskey: no trigger fires on UPDATE,
  // only on DELETE, so meta.changes is trustworthy here.
  const result = await db
    .prepare('UPDATE passkeys SET name = ?1 WHERE id = ?2 AND user_id = ?3')
    .bind(name, id, userId)
    .run();
  return result.meta.changes === 1;
}

export async function deletePasskey(
  db: D1Database,
  id: string,
  userId: string,
): Promise<'deleted' | 'last_passkey' | 'not_found'> {
  const before = await db
    .prepare('SELECT 1 FROM passkeys WHERE id = ?1 AND user_id = ?2')
    .bind(id, userId)
    .first();
  if (!before) return 'not_found';
  await db
    .prepare(
      'DELETE FROM passkeys WHERE id = ?1 AND user_id = ?2 AND (SELECT COUNT(*) FROM passkeys WHERE user_id = ?2) > 1',
    )
    .bind(id, userId)
    .run();
  // passkeys has an AFTER DELETE trigger (migration 006) that cascades a
  // mutation_epoch bump and a session revocation, and D1 reports a
  // statement's meta.changes as the sum including those cascaded writes —
  // never just the top-level DELETE's own row count — so success is
  // confirmed by re-reading the row, the same pattern already used for
  // patchBinderDisplay/removeCollectionCopy on other triggered tables.
  const after = await db
    .prepare('SELECT 1 FROM passkeys WHERE id = ?1 AND user_id = ?2')
    .bind(id, userId)
    .first();
  return after ? 'last_passkey' : 'deleted';
}

export async function logAudit(db: D1Database, input: AuditInsert): Promise<void> {
  await db
    .prepare(
      'INSERT INTO audit (actor, action, target, meta, created_at) VALUES (?1, ?2, ?3, ?4, ?5)',
    )
    .bind(
      input.actor,
      input.action,
      input.target ?? null,
      input.meta ? JSON.stringify(input.meta) : null,
      nowSeconds(),
    )
    .run();
}
