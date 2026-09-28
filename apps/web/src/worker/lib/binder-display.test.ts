import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { BinderDomainError, createBinder, listBinders, patchBinderDisplay } from './binders';
import { applyAllMigrations, sqliteD1 } from './d1-test-helper';

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

async function setup(): Promise<{ db: D1Database; binderId: string }> {
  const raw = new DatabaseSync(':memory:');
  databases.push(raw);
  applyAllMigrations(raw);
  raw.exec("INSERT INTO users(id,label,created_at) VALUES('owner','Owner',1);");
  const db = sqliteD1(raw);
  await createBinder(db, 'owner', 'Binder', { kind: '2x2', rows: 2, columns: 2 });
  const [binder] = await listBinders(db, 'owner');
  if (!binder) throw new Error('binder_not_created');
  return { db, binderId: binder.id };
}

describe('binder display preferences', () => {
  it('defaults every binder to one peek column and the frame shown', async () => {
    const { db } = await setup();
    const [binder] = await listBinders(db, 'owner');
    expect(binder).toMatchObject({ peekColumns: 1, showFrame: true });
  });

  it('updates peekColumns and showFrame independently', async () => {
    const { db, binderId } = await setup();
    const afterPeek = await patchBinderDisplay(db, 'owner', binderId, { peekColumns: 2 });
    expect(afterPeek).toMatchObject({ peekColumns: 2, showFrame: true });
    const afterFrame = await patchBinderDisplay(db, 'owner', binderId, { showFrame: false });
    expect(afterFrame).toMatchObject({ peekColumns: 2, showFrame: false });
  });

  it('refuses an empty patch', async () => {
    const { db, binderId } = await setup();
    await expect(patchBinderDisplay(db, 'owner', binderId, {})).rejects.toThrow(BinderDomainError);
  });

  it('refuses to patch a binder owned by someone else', async () => {
    const { db, binderId } = await setup();
    await expect(
      patchBinderDisplay(db, 'someone-else', binderId, { showFrame: false }),
    ).rejects.toThrow(BinderDomainError);
  });
});
