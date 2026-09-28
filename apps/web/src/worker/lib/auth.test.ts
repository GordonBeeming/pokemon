import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cookieSecureFor,
  createUser,
  deletePasskey,
  enrolSecretMatches,
  getFirstActiveAdmin,
  getPasskeys,
  getUserById,
  insertBootstrapPasskey,
  insertPasskey,
  isLoopbackHost,
  signSession,
  verifySession,
} from './auth';
import { timingSafeStringEqual } from './crypto';
import { applyAllMigrations, sqliteD1 } from './d1-test-helper';

const current = '01234567890123456789012345678901';
const previous = '98765432109876543210987654321098';

describe('auth foundation', () => {
  it('compares bootstrap secrets without accepting a different value', () => {
    expect(timingSafeStringEqual('same-secret', 'same-secret')).toBe(true);
    expect(timingSafeStringEqual('same-secret', 'other-secret')).toBe(false);
    expect(enrolSecretMatches('enrol', { ENROLL_SECRET: 'enrol' })).toBe(true);
  });

  it('signs bounded sessions and accepts the previous rotation secret', async () => {
    const token = await signSession(
      { sub: 'owner', label: 'Owner', sid: 'session-id', epoch: 3 },
      { SESSION_SECRET: previous, SESSION_SECRET_PREV: undefined },
    );
    await expect(
      verifySession(token, { SESSION_SECRET: current, SESSION_SECRET_PREV: previous }),
    ).resolves.toMatchObject({ sub: 'owner', label: 'Owner', sid: 'session-id', epoch: 3 });
  });

  it('only marks secure cookies on non-local origins', () => {
    expect(cookieSecureFor(new Request('http://localhost:5173/login'))).toBe(false);
    expect(cookieSecureFor(new Request('http://[::1]:5173/login'))).toBe(false);
    expect(cookieSecureFor(new Request('https://pokedex.example/login'))).toBe(true);
  });

  it('recognises bracketed IPv6 localhost as loopback', () => {
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('pokedex.example')).toBe(false);
  });
});

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

function fakePasskey(userId: string, id = 'credential-1') {
  return {
    id,
    userId,
    publicKey: new Uint8Array([1, 2, 3]),
    counter: 0,
    transports: null,
    deviceLabel: null,
    name: null,
    createdAt: 1,
  };
}

describe('multi-user accounts', () => {
  it('creates users with random ids rather than a fixed owner id', async () => {
    const db = setup();
    const first = await createUser(db, 'Gordon', 'admin');
    const second = await createUser(db, 'Invitee', 'member');
    expect(first.id).not.toBe('owner');
    expect(first.id).not.toBe(second.id);
    expect(first.role).toBe('admin');
    expect(second.role).toBe('member');
    expect(await getUserById(db, first.id)).toMatchObject({ label: 'Gordon', role: 'admin' });
    expect(await getUserById(db, 'missing')).toBeNull();
  });

  it('lets exactly one bootstrap passkey claim the system, ever', async () => {
    const db = setup();
    const admin = await createUser(db, 'Gordon', 'admin');
    expect(await insertBootstrapPasskey(db, fakePasskey(admin.id, 'first'))).toBe(true);

    const second = await createUser(db, 'Someone else', 'admin');
    // A passkey already exists anywhere in the system, so bootstrap refuses
    // to insert a second one even for a different, brand-new user.
    expect(await insertBootstrapPasskey(db, fakePasskey(second.id, 'second'))).toBe(false);
  });

  it('finds the earliest-created active admin and skips disabled or member accounts', async () => {
    const db = setup();
    const member = await createUser(db, 'Member', 'member');
    void member;
    expect(await getFirstActiveAdmin(db)).toBeNull();

    const firstAdmin = await createUser(db, 'First admin', 'admin');
    const secondAdmin = await createUser(db, 'Second admin', 'admin');
    // createUser stamps created_at from the current second, which two calls
    // in the same test can share; force a deterministic order to test.
    await db.prepare('UPDATE users SET created_at = 1 WHERE id = ?1').bind(firstAdmin.id).run();
    await db.prepare('UPDATE users SET created_at = 2 WHERE id = ?1').bind(secondAdmin.id).run();
    expect((await getFirstActiveAdmin(db))?.id).toBe(firstAdmin.id);

    await db.prepare('UPDATE users SET disabled_at = 1 WHERE id = ?1').bind(firstAdmin.id).run();
    expect((await getFirstActiveAdmin(db))?.id).toBe(secondAdmin.id);
  });
});

// node:sqlite's reported change count only reflects the top-level DELETE, so
// it can't reproduce the real D1 quirk this guards against (D1 sums in the
// passkeys AFTER DELETE trigger's cascaded rows too) — see
// verify-api-token-routes.mjs for the real-D1 regression check for that.
// This still documents the intended behaviour and catches an outcome-level
// regression under either engine.
describe('deletePasskey', () => {
  it('deletes a passkey that is not the only one, refuses the last one, and reports an unknown one', async () => {
    const db = setup();
    const user = await createUser(db, 'Gordon', 'admin');
    await insertPasskey(db, fakePasskey(user.id, 'first'));
    await insertPasskey(db, fakePasskey(user.id, 'second'));

    expect(await deletePasskey(db, 'unknown', user.id)).toBe('not_found');
    expect(await deletePasskey(db, 'first', user.id)).toBe('deleted');
    expect(await getPasskeys(db, user.id)).toHaveLength(1);

    expect(await deletePasskey(db, 'second', user.id)).toBe('last_passkey');
    expect(await getPasskeys(db, user.id)).toHaveLength(1);
  });
});
