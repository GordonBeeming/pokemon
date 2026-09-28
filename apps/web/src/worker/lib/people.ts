import type { InviteSummary, Person, UserRole } from '@pokedex/shared';
import { getUserById } from './auth';
import { isoFromSeconds, newId, nowSeconds } from './db';
import { ApplicationError } from './log';
import type { UserRow } from './types';

const INVITE_TTL_SECONDS = 7 * 24 * 60 * 60;

async function hashInviteToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function newInviteToken(): string {
  return `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll('-', '');
}

interface PersonRow {
  id: string;
  label: string;
  role: UserRole;
  disabled_at: number | null;
  created_at: number;
  passkey_count: number;
  last_used_at: number | null;
}

function personView(row: PersonRow): Person {
  return {
    id: row.id,
    label: row.label,
    role: row.role,
    disabledAt: row.disabled_at === null ? null : isoFromSeconds(row.disabled_at),
    createdAt: isoFromSeconds(row.created_at),
    passkeyCount: row.passkey_count,
    lastUsedAt: row.last_used_at === null ? null : isoFromSeconds(row.last_used_at),
  };
}

const PERSON_SELECT = `
  SELECT u.id, u.label, u.role, u.disabled_at, u.created_at,
    COUNT(p.id) AS passkey_count, MAX(p.last_used_at) AS last_used_at
  FROM users u LEFT JOIN passkeys p ON p.user_id = u.id`;

export async function listPeople(db: D1Database): Promise<Person[]> {
  const result = await db
    .prepare(`${PERSON_SELECT} GROUP BY u.id ORDER BY u.created_at ASC, u.id ASC`)
    .all<PersonRow>();
  return result.results.map(personView);
}

export async function getPerson(db: D1Database, id: string): Promise<Person | null> {
  const row = await db
    .prepare(`${PERSON_SELECT} WHERE u.id = ?1 GROUP BY u.id`)
    .bind(id)
    .first<PersonRow>();
  return row ? personView(row) : null;
}

async function activeAdminCount(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND disabled_at IS NULL")
    .first<{ count: number }>();
  return row?.count ?? 0;
}

export interface PatchPersonInput {
  role?: UserRole;
  disabled?: boolean;
}

export async function patchPerson(
  db: D1Database,
  targetId: string,
  patch: PatchPersonInput,
): Promise<Person> {
  const target = await getUserById(db, targetId);
  if (!target) throw new ApplicationError('person_not_found', 404);
  const wasActiveAdmin = target.role === 'admin' && target.disabled_at === null;
  const nextRole = patch.role ?? target.role;
  const nextDisabled = patch.disabled ?? target.disabled_at !== null;
  const stillActiveAdmin = nextRole === 'admin' && !nextDisabled;
  if (wasActiveAdmin && !stillActiveAdmin && (await activeAdminCount(db)) <= 1)
    throw new ApplicationError('last_admin', 409);

  const now = nowSeconds();
  // Only a transition from active to disabled needs to revoke anything —
  // enabling, or a role-only change, leaves existing sessions/tokens alone
  // (there's nothing stale to invalidate; a live session already re-checks
  // role on every admin-guarded request).
  const disablesNow = !target.disabled_at && nextDisabled;
  const statements = [
    db
      .prepare('UPDATE users SET role = ?1, disabled_at = ?2 WHERE id = ?3')
      .bind(nextRole, nextDisabled ? (target.disabled_at ?? now) : null, targetId),
  ];
  if (disablesNow) {
    statements.push(
      db
        .prepare('UPDATE users SET mutation_epoch = mutation_epoch + 1 WHERE id = ?1')
        .bind(targetId),
      db
        .prepare(
          'UPDATE web_sessions SET revoked_at = ?1 WHERE user_id = ?2 AND revoked_at IS NULL',
        )
        .bind(now, targetId),
      db
        .prepare(
          'UPDATE desktop_tokens SET revoked_at = ?1 WHERE owner_id = ?2 AND revoked_at IS NULL',
        )
        .bind(now, targetId),
    );
  }
  await db.batch(statements);
  const updated = await getPerson(db, targetId);
  if (!updated) throw new ApplicationError('person_not_found', 404);
  return updated;
}

export async function createInvite(
  db: D1Database,
  createdBy: string,
  input: { label?: string; role: UserRole },
): Promise<{ id: string; token: string; expiresAt: string }> {
  const id = newId('invite');
  const token = newInviteToken();
  const now = nowSeconds();
  const expiresAt = now + INVITE_TTL_SECONDS;
  await db
    .prepare(
      `INSERT INTO invites (id, token_hash, created_by, role, label, created_at, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
    .bind(
      id,
      await hashInviteToken(token),
      createdBy,
      input.role,
      input.label ?? null,
      now,
      expiresAt,
    )
    .run();
  return { id, token, expiresAt: isoFromSeconds(expiresAt) };
}

interface InviteRow {
  id: string;
  role: UserRole;
  label: string | null;
  created_at: number;
  expires_at: number;
  redeemed_at: number | null;
  redeemed_by: string | null;
  cancelled_at: number | null;
}

function inviteView(row: InviteRow): InviteSummary {
  return {
    id: row.id,
    role: row.role,
    label: row.label,
    createdAt: isoFromSeconds(row.created_at),
    expiresAt: isoFromSeconds(row.expires_at),
    redeemedAt: row.redeemed_at === null ? null : isoFromSeconds(row.redeemed_at),
    redeemedBy: row.redeemed_by,
    cancelledAt: row.cancelled_at === null ? null : isoFromSeconds(row.cancelled_at),
  };
}

export async function listInvites(db: D1Database): Promise<InviteSummary[]> {
  const result = await db
    .prepare(
      `SELECT id, role, label, created_at, expires_at, redeemed_at, redeemed_by, cancelled_at
       FROM invites ORDER BY created_at DESC`,
    )
    .all<InviteRow>();
  return result.results.map(inviteView);
}

export async function cancelInvite(db: D1Database, id: string): Promise<boolean> {
  const result = await db
    .prepare(
      'UPDATE invites SET cancelled_at = ?1 WHERE id = ?2 AND redeemed_at IS NULL AND cancelled_at IS NULL',
    )
    .bind(nowSeconds(), id)
    .run();
  return result.meta.changes === 1;
}

export interface InviteLookup {
  valid: boolean;
  expired: boolean;
  used: boolean;
  label: string | null;
  role: UserRole | null;
  expiresAt: string | null;
  invitedBy: string | null;
}

export async function lookupInvite(db: D1Database, token: string): Promise<InviteLookup | null> {
  const row = await db
    .prepare(
      `SELECT invites.label, invites.role, invites.expires_at, invites.redeemed_at,
         invites.cancelled_at, creator.label AS created_by_label
       FROM invites JOIN users creator ON creator.id = invites.created_by
       WHERE invites.token_hash = ?1`,
    )
    .bind(await hashInviteToken(token))
    .first<{
      label: string | null;
      role: UserRole;
      expires_at: number;
      redeemed_at: number | null;
      cancelled_at: number | null;
      created_by_label: string;
    }>();
  if (!row) return null;
  const expired = row.expires_at <= nowSeconds();
  const used = row.redeemed_at !== null || row.cancelled_at !== null;
  const valid = !expired && !used;
  return {
    valid,
    expired,
    used,
    label: row.label,
    role: valid ? row.role : null,
    expiresAt: valid ? isoFromSeconds(row.expires_at) : null,
    invitedBy: valid ? row.created_by_label : null,
  };
}

// Called from passkey registration verify, after the WebAuthn ceremony
// itself already succeeded. Creates the new member account and marks the
// invite redeemed in one transaction; if a concurrent request already
// claimed the same link, the just-created account is removed rather than
// left as an orphan with no passkey.
export async function claimInviteForNewUser(
  db: D1Database,
  token: string,
  label: string,
): Promise<UserRow> {
  const tokenHash = await hashInviteToken(token);
  const now = nowSeconds();
  const invite = await db
    .prepare(
      'SELECT id, role, expires_at, redeemed_at, cancelled_at FROM invites WHERE token_hash = ?1',
    )
    .bind(tokenHash)
    .first<{
      id: string;
      role: UserRole;
      expires_at: number;
      redeemed_at: number | null;
      cancelled_at: number | null;
    }>();
  if (!invite) throw new ApplicationError('invite_invalid', 400);
  if (invite.redeemed_at !== null || invite.cancelled_at !== null)
    throw new ApplicationError('invite_used', 409);
  if (invite.expires_at <= now) throw new ApplicationError('invite_expired', 409);

  const userId = newId('user');
  const results = await db.batch([
    db
      .prepare('INSERT INTO users (id, label, role, created_at) VALUES (?1, ?2, ?3, ?4)')
      .bind(userId, label, invite.role, now),
    db
      .prepare(
        `UPDATE invites SET redeemed_at = ?1, redeemed_by = ?2
         WHERE id = ?3 AND redeemed_at IS NULL AND cancelled_at IS NULL AND expires_at > ?1`,
      )
      .bind(now, userId, invite.id),
  ]);
  const claimed = results[1];
  if (!claimed || claimed.meta.changes !== 1) {
    await db.prepare('DELETE FROM users WHERE id = ?1').bind(userId).run();
    throw new ApplicationError('invite_used', 409);
  }
  const created = await getUserById(db, userId);
  if (!created) throw new ApplicationError('internal_error', 500);
  return created;
}
