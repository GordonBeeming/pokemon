import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Context } from 'hono';
import { errors as joseErrors, jwtVerify, SignJWT } from 'jose';
import { timingSafeStringEqual } from './crypto';
import type { AuditInsert, PasskeyInsert, PasskeyRow, SessionPayload, UserRow } from './types';

export const SESSION_COOKIE = 'pokedex_session';
const SESSION_MAX_AGE = 60 * 60 * 24 * 30;
type SessionEnv = Pick<CloudflareEnv, 'SESSION_SECRET' | 'SESSION_SECRET_PREV'>;
type AuthContext = Context<{ Bindings: CloudflareEnv; Variables: import('./types').AuthVars }>;

export async function signSession(
  payload: Omit<SessionPayload, 'iat' | 'exp'>,
  env: SessionEnv,
): Promise<string> {
  if (new TextEncoder().encode(env.SESSION_SECRET).byteLength < 32)
    throw new Error('SESSION_SECRET must be at least 32 bytes');
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(payload)
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
    const { sub, label, iat, exp } = result.payload;
    if (
      typeof sub !== 'string' ||
      typeof label !== 'string' ||
      typeof iat !== 'number' ||
      typeof exp !== 'number'
    )
      return null;
    return { sub, label, iat, exp };
  } catch (error) {
    if (!(error instanceof joseErrors.JWSSignatureVerificationFailed)) return null;
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

export function cookieSecureFor(request: Request): boolean {
  const host = new URL(request.url).hostname;
  return host !== 'localhost' && host !== '127.0.0.1' && host !== '::1';
}

export function getSession(c: AuthContext): Promise<SessionPayload | null> {
  const token = getCookie(c, SESSION_COOKIE);
  return token ? verifySession(token, c.env) : Promise.resolve(null);
}
export function setSessionCookie(c: AuthContext, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: cookieSecureFor(c.req.raw),
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_MAX_AGE,
  });
}
export function clearSessionCookie(c: AuthContext): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}
export function enrolSecretMatches(
  input: string,
  env: Pick<CloudflareEnv, 'ENROLL_SECRET'>,
): boolean {
  return timingSafeStringEqual(input, env.ENROLL_SECRET);
}

export async function getOrCreateOwner(db: D1Database, label: string): Promise<UserRow> {
  const existing = await db
    .prepare('SELECT id, label, created_at FROM users WHERE id = ?1')
    .bind('owner')
    .first<UserRow>();
  if (existing) return existing;
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare('INSERT OR IGNORE INTO users (id, label, created_at) VALUES (?1, ?2, ?3)')
    .bind('owner', label, now)
    .run();
  const created = await db
    .prepare('SELECT id, label, created_at FROM users WHERE id = ?1')
    .bind('owner')
    .first<UserRow>();
  if (!created) throw new Error('Owner row could not be created');
  return created;
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
export async function insertPasskey(db: D1Database, input: PasskeyInsert): Promise<void> {
  await db
    .prepare(
      'INSERT INTO passkeys (id, user_id, public_key, counter, transports, device_label, name, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)',
    )
    .bind(
      input.id,
      input.userId,
      input.publicKey,
      input.counter,
      input.transports,
      input.deviceLabel,
      input.name,
      input.createdAt,
    )
    .run();
}
export async function updatePasskeyUsage(
  db: D1Database,
  id: string,
  counter: number,
  usedAt: number,
): Promise<void> {
  await db
    .prepare('UPDATE passkeys SET counter = ?1, last_used_at = ?2 WHERE id = ?3')
    .bind(counter, usedAt, id)
    .run();
}
export async function renamePasskey(
  db: D1Database,
  id: string,
  userId: string,
  name: string | null,
): Promise<boolean> {
  const result = await db
    .prepare('UPDATE passkeys SET name = ?1 WHERE id = ?2 AND user_id = ?3')
    .bind(name, id, userId)
    .run();
  return result.meta.changes === 1;
}
export async function deletePasskey(db: D1Database, id: string, userId: string): Promise<boolean> {
  const result = await db
    .prepare('DELETE FROM passkeys WHERE id = ?1 AND user_id = ?2')
    .bind(id, userId)
    .run();
  return result.meta.changes === 1;
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
      Math.floor(Date.now() / 1000),
    )
    .run();
}
