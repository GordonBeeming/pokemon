import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createUser, getPasskeys, insertPasskey } from './auth';
import { applyAllMigrations, sqliteD1 } from './d1-test-helper';
import { ApplicationError } from './log';
import {
  cancelInvite,
  claimInviteForNewUser,
  createInvite,
  getPerson,
  listInvites,
  listPeople,
  lookupInvite,
  patchPerson,
} from './people';

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function setup(): D1Database {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  applyAllMigrations(db);
  return sqliteD1(db);
}

let passkeySeq = 0;
function fakePasskey(userId: string, id?: string) {
  passkeySeq += 1;
  return {
    id: id ?? `credential-${passkeySeq}`,
    userId,
    publicKey: new Uint8Array([1, 2, 3]),
    counter: 0,
    transports: null,
    deviceLabel: null,
    name: null,
    createdAt: 1,
  };
}

describe('listing and patching people', () => {
  it('lists every user with a live passkey count and last-used time', async () => {
    const db = setup();
    const admin = await createUser(db, 'Gordon', 'admin');
    await db
      .prepare(
        "INSERT INTO passkeys (id, user_id, public_key, counter, created_at, last_used_at) VALUES ('p1', ?1, x'00', 0, 1, 100), ('p2', ?1, x'00', 0, 1, 200)",
      )
      .bind(admin.id)
      .run();
    const people = await listPeople(db);
    expect(people).toEqual([
      expect.objectContaining({
        id: admin.id,
        label: 'Gordon',
        role: 'admin',
        disabledAt: null,
        passkeyCount: 2,
        lastUsedAt: new Date(200 * 1000).toISOString(),
      }),
    ]);
    expect(await getPerson(db, 'missing')).toBeNull();
  });

  it('refuses to demote or disable the last active admin, including yourself', async () => {
    const db = setup();
    const admin = await createUser(db, 'Gordon', 'admin');
    await expect(patchPerson(db, admin.id, { role: 'member' })).rejects.toMatchObject({
      code: 'last_admin',
    });
    await expect(patchPerson(db, admin.id, { disabled: true })).rejects.toMatchObject({
      code: 'last_admin',
    });
    // A second active admin makes either change on the first admin safe again.
    await createUser(db, 'Second admin', 'admin');
    await expect(patchPerson(db, admin.id, { role: 'member' })).resolves.toMatchObject({
      role: 'member',
    });
  });

  it('disabling revokes sessions and desktop tokens and can be reversed', async () => {
    const db = setup();
    const admin = await createUser(db, 'Gordon', 'admin');
    await createUser(db, 'Second admin', 'admin');
    const member = await createUser(db, 'Member', 'member');
    await db
      .prepare(
        'INSERT INTO web_sessions (id_hash, user_id, mutation_epoch, expires_at, created_at) VALUES (?1, ?2, 0, 999999999, 1)',
      )
      .bind('session-hash', member.id)
      .run();
    await db
      .prepare(
        'INSERT INTO desktop_tokens (token_hash, owner_id, label, scopes, created_at) VALUES (?1, ?2, ?3, ?4, 1)',
      )
      .bind('token-hash', member.id, 'Desktop', '["catalogue:read"]')
      .run();

    const disabled = await patchPerson(db, member.id, { disabled: true });
    expect(disabled.disabledAt).not.toBeNull();
    const sessionRow = await db
      .prepare('SELECT mutation_epoch, revoked_at FROM web_sessions WHERE id_hash = ?1')
      .bind('session-hash')
      .first<{ mutation_epoch: number; revoked_at: number | null }>();
    expect(sessionRow?.revoked_at).toEqual(expect.any(Number));
    expect(
      await db
        .prepare('SELECT mutation_epoch FROM users WHERE id = ?1')
        .bind(member.id)
        .first<{ mutation_epoch: number }>(),
    ).toMatchObject({ mutation_epoch: 1 });
    const tokenRow = await db
      .prepare('SELECT revoked_at FROM desktop_tokens WHERE token_hash = ?1')
      .bind('token-hash')
      .first<{ revoked_at: number | null }>();
    expect(tokenRow?.revoked_at).toEqual(expect.any(Number));

    void admin;
    const enabled = await patchPerson(db, member.id, { disabled: false });
    expect(enabled.disabledAt).toBeNull();
  });

  it('rejects a patch for an unknown person', async () => {
    await expect(patchPerson(setup(), 'missing', { role: 'admin' })).rejects.toMatchObject({
      code: 'person_not_found',
    });
  });

  // Reproduces finding 5: with two active admins, two concurrent demotions
  // must not both succeed. The mock D1 driver resolves every query
  // synchronously, so Promise.all deterministically interleaves the two
  // calls at each await boundary — both reach their pre-write read before
  // either reaches its write, exactly like two overlapping HTTP requests.
  // Against the old code (a separate activeAdminCount() pre-check before an
  // unconditional UPDATE) this leaves zero active admins; the fix bakes the
  // count into the UPDATE's own WHERE clause, re-evaluated live at write
  // time, so only the first write to actually commit can succeed.
  it('lets only one of two concurrent demotions of the two active admins through', async () => {
    const db = setup();
    const adminA = await createUser(db, 'Admin A', 'admin');
    const adminB = await createUser(db, 'Admin B', 'admin');

    const results = await Promise.allSettled([
      patchPerson(db, adminA.id, { role: 'member' }),
      patchPerson(db, adminB.id, { role: 'member' }),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'last_admin' });

    const remaining = await db
      .prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND disabled_at IS NULL")
      .first<{ count: number }>();
    expect(remaining?.count).toBe(1);
  });

  // Same race, but disabling instead of demoting — the finding's other
  // concurrent path to zero active admins, and the one that must also
  // refuse to revoke a still-active admin's sessions along the way.
  it('lets only one of two concurrent disables of the two active admins through', async () => {
    const db = setup();
    const adminA = await createUser(db, 'Admin A', 'admin');
    const adminB = await createUser(db, 'Admin B', 'admin');

    const results = await Promise.allSettled([
      patchPerson(db, adminA.id, { disabled: true }),
      patchPerson(db, adminB.id, { disabled: true }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'last_admin' });

    const remaining = await db
      .prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND disabled_at IS NULL")
      .first<{ count: number }>();
    expect(remaining?.count).toBe(1);
  });

  // Round 2 of the review: a *different* interleaving than the two races
  // above still zeroed out the admins. A is the sole admin; a request to
  // disable member B reads B as an ordinary, active member and then pauses
  // before its write. Meanwhile B is promoted to admin and A is demoted, so
  // B becomes the sole active admin. The paused request resumes and, under
  // the old code, its stale "B is just a member" read skipped the
  // last-admin subquery entirely (its own removesActiveAdmin flag was
  // false) and blindly overwrote B's role back to member plus disabled —
  // zero admins left. The fix adds an optimistic check (role/disabled_at
  // must still match what was read) to the same UPDATE, so a target that
  // moved underneath a paused request aborts the write instead of applying
  // a decision computed from data that's no longer true.
  //
  // A plain Promise.all can't force this exact ordering (both "meanwhile"
  // writes need to fully land between the paused request's read and its own
  // write), so this wraps the real db's batch() to run them at that exact
  // point, then lets the original (stale) write attempt proceed through the
  // same real patchPerson call and the same real SQL guard.
  it('rejects a paused disable whose stale read would otherwise leave zero admins', async () => {
    const db = setup();
    const admin = await createUser(db, 'Admin', 'admin');
    const member = await createUser(db, 'Member', 'member');

    let batchCalls = 0;
    const pausingDb = {
      ...db,
      batch: (async (statements: D1PreparedStatement[]) => {
        batchCalls += 1;
        if (batchCalls === 1) {
          await patchPerson(db, member.id, { role: 'admin' });
          await patchPerson(db, admin.id, { role: 'member' });
        }
        return db.batch(statements);
      }) as D1Database['batch'],
    } as unknown as D1Database;

    await expect(patchPerson(pausingDb, member.id, { disabled: true })).rejects.toMatchObject({
      code: 'person_changed',
    });

    const remaining = await db
      .prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND disabled_at IS NULL")
      .first<{ count: number }>();
    expect(remaining?.count).toBe(1);
    // The paused request wrote nothing at all — B is still the promoted
    // admin from the "meanwhile" step, not silently reset to member.
    expect(await getPerson(db, member.id)).toMatchObject({ role: 'admin', disabledAt: null });
  });
});

describe('invites', () => {
  it('creates a single-use, expiring invite and reports its public status', async () => {
    const db = setup();
    const admin = await createUser(db, 'Gordon', 'admin');
    const { id, token, expiresAt } = await createInvite(db, admin.id, {
      role: 'member',
      label: 'Family member',
    });
    expect(id).toBeTruthy();
    expect(expiresAt).toMatch(/\d{4}-\d{2}-\d{2}T/u);
    expect(await lookupInvite(db, token)).toEqual({
      valid: true,
      expired: false,
      used: false,
      label: 'Family member',
      role: 'member',
      expiresAt,
      invitedBy: 'Gordon',
    });
    expect(await lookupInvite(db, 'unknown-token')).toBeNull();

    const invites = await listInvites(db);
    expect(invites).toHaveLength(1);
    expect(invites[0]).toMatchObject({ role: 'member', label: 'Family member', redeemedAt: null });
  });

  it('redeems an invite into a brand-new user with the invite role, exactly once', async () => {
    const db = setup();
    const admin = await createUser(db, 'Gordon', 'admin');
    const { token } = await createInvite(db, admin.id, { role: 'member' });

    const userId = 'new-member';
    const created = await claimInviteForNewUser(
      db,
      token,
      userId,
      'New member',
      fakePasskey(userId),
    );
    expect(created.role).toBe('member');
    expect(created.id).not.toBe(admin.id);
    expect(await lookupInvite(db, token)).toMatchObject({ valid: false, used: true });
    expect(await getPasskeys(db, userId)).toHaveLength(1);

    // A second redemption attempt is refused and leaves no orphan user behind.
    await expect(
      claimInviteForNewUser(db, token, 'someone-else', 'Someone else', fakePasskey('someone-else')),
    ).rejects.toMatchObject({ code: 'invite_used' });
    expect(await listPeople(db)).toHaveLength(2);
  });

  it('refuses to redeem an expired or unknown invite', async () => {
    const db = setup();
    const admin = await createUser(db, 'Gordon', 'admin');
    const { token } = await createInvite(db, admin.id, { role: 'member' });
    await db
      .prepare('UPDATE invites SET expires_at = 1 WHERE created_by = ?1')
      .bind(admin.id)
      .run();
    await expect(
      claimInviteForNewUser(db, token, 'late', 'Late', fakePasskey('late')),
    ).rejects.toMatchObject({ code: 'invite_expired' });
    await expect(
      claimInviteForNewUser(db, 'not-a-real-token', 'nobody', 'Nobody', fakePasskey('nobody')),
    ).rejects.toMatchObject({ code: 'invite_invalid' });
    expect(await listPeople(db)).toHaveLength(1);
  });

  it('cancels an unredeemed invite but not one already redeemed', async () => {
    const db = setup();
    const admin = await createUser(db, 'Gordon', 'admin');
    const pending = await createInvite(db, admin.id, { role: 'member' });
    const redeemed = await createInvite(db, admin.id, { role: 'member' });
    await claimInviteForNewUser(
      db,
      redeemed.token,
      'redeemed-user',
      'Redeemed',
      fakePasskey('redeemed-user'),
    );

    const invites = await listInvites(db);
    const pendingId = invites.find((invite) => invite.redeemedAt === null)?.id;
    const redeemedId = invites.find((invite) => invite.redeemedAt !== null)?.id;
    if (!pendingId || !redeemedId) throw new Error('test setup invariant broken');

    expect(await cancelInvite(db, pendingId)).toBe(true);
    expect(await cancelInvite(db, redeemedId)).toBe(false);
    expect(await cancelInvite(db, 'missing')).toBe(false);
    void pending;
  });

  // Reproduces finding 7: a failed credential insert must not leave the
  // invite spent with an account that has no passkey. A duplicate passkey
  // id forces the final INSERT to throw a real constraint error, which — per
  // shared-context.md's D1 batch warning — aborts and rolls back the WHOLE
  // batch, undoing the user insert and the invite claim alongside it.
  it('leaves the invite unspent and creates no orphan user when the credential insert fails', async () => {
    const db = setup();
    const admin = await createUser(db, 'Gordon', 'admin');
    await insertPasskey(db, fakePasskey(admin.id, 'already-taken'));
    const { token } = await createInvite(db, admin.id, { role: 'member' });

    await expect(
      claimInviteForNewUser(
        db,
        token,
        'collides',
        'Collides',
        fakePasskey('collides', 'already-taken'),
      ),
    ).rejects.toThrow();

    expect(await lookupInvite(db, token)).toMatchObject({ valid: true, used: false });
    expect(await listPeople(db)).toHaveLength(1);
  });

  // Reproduces finding 7's other half: two attempts racing the same invite
  // link (e.g. a double-submitted registration) must not both write a user.
  // Same deterministic Promise.all interleaving as the last-admin race above.
  it('lets only one of two concurrent claims of the same invite through', async () => {
    const db = setup();
    const admin = await createUser(db, 'Gordon', 'admin');
    const { token } = await createInvite(db, admin.id, { role: 'member' });

    const results = await Promise.allSettled([
      claimInviteForNewUser(db, token, 'claimant-1', 'Claimant 1', fakePasskey('claimant-1')),
      claimInviteForNewUser(db, token, 'claimant-2', 'Claimant 2', fakePasskey('claimant-2')),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'invite_used' });

    // Exactly one new member account, with exactly one passkey — not zero,
    // not a passkey-less orphan for the loser.
    expect(await listPeople(db)).toHaveLength(2);
    const people = await listPeople(db);
    const member = people.find((person) => person.role === 'member');
    if (!member) throw new Error('test setup invariant broken');
    expect(member.passkeyCount).toBe(1);
  });
});

describe('ApplicationError shape', () => {
  it('carries the codes the screens teams key their UI off', () => {
    const error = new ApplicationError('last_admin', 409);
    expect(error.code).toBe('last_admin');
    expect(error.status).toBe(409);
  });
});
