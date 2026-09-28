import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createUser } from './auth';
import { applyAllMigrations, sqliteD1 } from './d1-test-helper';
import { createPairCode, redeemPairCode, requireDesktopToken } from './desktop-auth';
import { patchPerson } from './people';

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

// Reproduces finding 4's other credential paths: a disabled user's
// outstanding pair codes and desktop tokens must stop working, not just
// their web session.
describe('desktop credentials refuse a disabled owner', () => {
  it('refuses to redeem a pair code once its owner is disabled', async () => {
    const db = setup();
    const admin = await createUser(db, 'Admin', 'admin');
    const member = await createUser(db, 'Member', 'member');
    void admin;
    const code = await createPairCode(db, member.id, ['catalogue:read']);

    await patchPerson(db, member.id, { disabled: true });

    await expect(redeemPairCode(db, code, 'Desktop')).rejects.toMatchObject({
      code: 'pair_code_invalid',
    });
    const tokenCount = await db
      .prepare('SELECT COUNT(*) AS count FROM desktop_tokens')
      .first<{ count: number }>();
    expect(tokenCount?.count).toBe(0);
  });

  // The race variant: disabling and redeeming happen concurrently, same
  // deterministic Promise.all interleaving used for the other findings.
  it('does not mint a usable token when redemption races a concurrent disable', async () => {
    const db = setup();
    const admin = await createUser(db, 'Admin', 'admin');
    const member = await createUser(db, 'Member', 'member');
    void admin;
    const code = await createPairCode(db, member.id, ['catalogue:read']);

    const [disableResult, redeemResult] = await Promise.allSettled([
      patchPerson(db, member.id, { disabled: true }),
      redeemPairCode(db, code, 'Desktop'),
    ]);
    expect(disableResult.status).toBe('fulfilled');
    expect(redeemResult.status).toBe('rejected');

    const tokenCount = await db
      .prepare('SELECT COUNT(*) AS count FROM desktop_tokens')
      .first<{ count: number }>();
    expect(tokenCount?.count).toBe(0);
  });

  it('invalidates an already-issued desktop token the instant its owner is disabled', async () => {
    const db = setup();
    const admin = await createUser(db, 'Admin', 'admin');
    const member = await createUser(db, 'Member', 'member');
    void admin;
    const code = await createPairCode(db, member.id, ['catalogue:read']);
    const { token } = await redeemPairCode(db, code, 'Desktop');
    await expect(requireDesktopToken(db, token, 'catalogue:read')).resolves.toBe(member.id);

    await patchPerson(db, member.id, { disabled: true });

    await expect(requireDesktopToken(db, token, 'catalogue:read')).rejects.toMatchObject({
      code: 'desktop_token_invalid',
    });
  });

  it('deletes outstanding pair codes for an owner as soon as they are disabled', async () => {
    const db = setup();
    const admin = await createUser(db, 'Admin', 'admin');
    const member = await createUser(db, 'Member', 'member');
    void admin;
    await createPairCode(db, member.id, ['catalogue:read']);

    await patchPerson(db, member.id, { disabled: true });

    const pairCodes = await db
      .prepare('SELECT COUNT(*) AS count FROM desktop_pair_codes WHERE owner_id = ?1')
      .bind(member.id)
      .first<{ count: number }>();
    expect(pairCodes?.count).toBe(0);
  });
});
