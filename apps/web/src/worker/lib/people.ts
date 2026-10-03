import type { InviteSummary, Person, UserRole } from '@pokedex/shared';
import { getUserById } from './auth';
import { isoFromSeconds, newId, nowSeconds } from './db';
import { ApplicationError } from './log';
import { SHOW_PRICES_KEY, setShowPrices } from './settings';
import type { PasskeyInsert, UserRow } from './types';

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
  show_prices: number;
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
    showPrices: row.show_prices !== 0,
  };
}

const PERSON_SELECT = `
  SELECT u.id, u.label, u.role, u.disabled_at, u.created_at,
    COUNT(p.id) AS passkey_count, MAX(p.last_used_at) AS last_used_at,
    COALESCE((
      SELECT CASE WHEN s.value_json = 'false' THEN 0 ELSE 1 END
      FROM user_settings s WHERE s.owner_id = u.id AND s.key = '${SHOW_PRICES_KEY}'
    ), 1) AS show_prices
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

export interface PatchPersonInput {
  role?: UserRole;
  disabled?: boolean;
  showPrices?: boolean;
}

export async function patchPerson(
  db: D1Database,
  targetId: string,
  patch: PatchPersonInput,
): Promise<Person> {
  const target = await getUserById(db, targetId);
  if (!target) throw new ApplicationError('person_not_found', 404);
  if (patch.showPrices !== undefined) await setShowPrices(db, targetId, patch.showPrices);
  // Prices alone touch no account state, so the role/disabled guards below don't apply.
  if (patch.role === undefined && patch.disabled === undefined) {
    const updated = await getPerson(db, targetId);
    if (!updated) throw new ApplicationError('person_not_found', 404);
    return updated;
  }
  const wasActiveAdmin = target.role === 'admin' && target.disabled_at === null;
  const nextRole = patch.role ?? target.role;
  const nextDisabled = patch.disabled ?? target.disabled_at !== null;
  const stillActiveAdmin = nextRole === 'admin' && !nextDisabled;
  const removesActiveAdmin = wasActiveAdmin && !stillActiveAdmin;

  const now = nowSeconds();
  const nextDisabledAt = nextDisabled ? (target.disabled_at ?? now) : null;
  // Only a transition from active to disabled needs to revoke anything —
  // enabling, or a role-only change, leaves existing sessions/tokens alone
  // (there's nothing stale to invalidate; a live session already re-checks
  // role on every admin-guarded request).
  const disablesNow = !target.disabled_at && nextDisabled;

  // Two guards, both evaluated against the live row at write time, not the
  // possibly-stale `target` read above:
  //   - optimistic concurrency: role and disabled_at must still match what
  //     was just read, or this write does nothing. Without this, a patch
  //     that only sets `disabled` (say) still carries a *computed* nextRole
  //     baked from the stale read, and would silently overwrite a role that
  //     changed in between — e.g. disabling a member who was promoted to
  //     the system's only active admin a moment earlier, using this
  //     request's stale "still just a member" role.
  //   - the last-admin invariant, via a live subquery: two concurrent
  //     demotions/disables of two different admins would each see "2 active
  //     admins" from a separate pre-check read, and both would then
  //     succeed, so the count is re-read here instead of trusted from
  //     wasActiveAdmin/stillActiveAdmin above.
  // Both guards matter together: removesActiveAdmin is only safe to trust
  // once the optimistic check confirms the row hasn't moved since it was
  // computed from.
  const statements = [
    db
      .prepare(
        `UPDATE users SET role = ?1, disabled_at = ?2
         WHERE id = ?3 AND role = ?4 AND disabled_at IS ?5
           AND (
             ?6 = 0
             OR (SELECT COUNT(*) FROM users WHERE role = 'admin' AND disabled_at IS NULL AND id != ?3) >= 1
           )`,
      )
      .bind(
        nextRole,
        nextDisabledAt,
        targetId,
        target.role,
        target.disabled_at,
        removesActiveAdmin ? 1 : 0,
      ),
  ];
  if (disablesNow) {
    // Each follow-on write is conditioned on the primary update above having
    // actually applied disabled_at = now to this row — if the last-admin
    // guard aborted it (0 rows), these must not revoke a still-active
    // admin's sessions, tokens, or pair codes.
    const disabledNowGuard = `EXISTS (SELECT 1 FROM users WHERE id = ?2 AND disabled_at = ?1)`;
    statements.push(
      db
        .prepare(
          `UPDATE users SET mutation_epoch = mutation_epoch + 1 WHERE id = ?1 AND disabled_at = ?2`,
        )
        .bind(targetId, now),
      db
        .prepare(
          `UPDATE web_sessions SET revoked_at = ?1 WHERE user_id = ?2 AND revoked_at IS NULL AND ${disabledNowGuard}`,
        )
        .bind(now, targetId),
      db
        .prepare(
          `UPDATE desktop_tokens SET revoked_at = ?1 WHERE owner_id = ?2 AND revoked_at IS NULL AND ${disabledNowGuard}`,
        )
        .bind(now, targetId),
      db
        .prepare(`DELETE FROM desktop_pair_codes WHERE owner_id = ?2 AND ${disabledNowGuard}`)
        .bind(now, targetId),
    );
  }
  const [primary] = await db.batch(statements);
  if (!primary || primary.meta.changes !== 1) {
    // The UPDATE's WHERE bundles two different reasons for 0 rows into one
    // outcome; re-reading the row is the cheap way to tell them apart,
    // and it only runs on this (rare) failure path.
    const current = await getUserById(db, targetId);
    if (!current) throw new ApplicationError('person_not_found', 404);
    if (current.role !== target.role || current.disabled_at !== target.disabled_at)
      throw new ApplicationError('person_changed', 409);
    throw new ApplicationError('last_admin', 409);
  }
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
// itself already succeeded (the caller already generated userId and built
// the credential row, since the credential's user_id must be known before
// this can insert it). Creates the new member account, marks the invite
// redeemed, and stores the passkey — all three gated on the SAME live
// invite-row check, inside one batch:
//   - the user insert only fires while the invite is still unredeemed,
//   - the invite claim only succeeds under that same condition,
//   - the passkey insert only fires once the invite shows THIS user as the
//     one who just redeemed it (set by the claim statement immediately
//     before, visible to later statements in the same transaction).
// A losing concurrent attempt — or a real failure partway through, which
// aborts the whole batch outright — therefore writes nothing at all: no
// orphan user, no wasted passkey, and the invite stays claimed by whichever
// attempt actually won.
export async function claimInviteForNewUser(
  db: D1Database,
  token: string,
  userId: string,
  label: string,
  passkey: PasskeyInsert,
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

  const [, claimed] = await db.batch([
    db
      .prepare(
        `INSERT INTO users (id, label, role, created_at)
         SELECT ?1, ?2, invites.role, ?3 FROM invites
         WHERE invites.id = ?4 AND invites.redeemed_at IS NULL AND invites.cancelled_at IS NULL
           AND invites.expires_at > ?3`,
      )
      .bind(userId, label, now, invite.id),
    db
      .prepare(
        `UPDATE invites SET redeemed_at = ?1, redeemed_by = ?2
         WHERE id = ?3 AND redeemed_at IS NULL AND cancelled_at IS NULL AND expires_at > ?1`,
      )
      .bind(now, userId, invite.id),
    db
      .prepare(
        `INSERT INTO passkeys (id, user_id, public_key, counter, transports, device_label, name, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8 FROM invites
         WHERE invites.id = ?9 AND invites.redeemed_by = ?2 AND invites.redeemed_at = ?10`,
      )
      .bind(
        passkey.id,
        userId,
        passkey.publicKey,
        passkey.counter,
        passkey.transports,
        passkey.deviceLabel,
        passkey.name,
        passkey.createdAt,
        invite.id,
        now,
      ),
  ]);
  if (!claimed || claimed.meta.changes !== 1) throw new ApplicationError('invite_used', 409);
  const created = await getUserById(db, userId);
  if (!created) throw new ApplicationError('internal_error', 500);
  return created;
}
