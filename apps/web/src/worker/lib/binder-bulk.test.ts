import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addCardsToBinderVersion,
  createBinder,
  getBinderVersion,
  setBinderSlot,
  reserveBinderPage,
} from './binders';
import { applyAllMigrations, sqliteD1 } from './d1-test-helper';

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function setup(): { database: DatabaseSync; db: D1Database } {
  const database = new DatabaseSync(':memory:');
  databases.push(database);
  database.exec('PRAGMA foreign_keys = ON');
  applyAllMigrations(database);
  database.exec(`
    INSERT INTO users (id, label, created_at) VALUES ('owner', 'Owner', 1);
    INSERT INTO catalogue_cards
      (id, name, language, category, set_id, set_name, number, number_sort,
       pokedex_number, created_at, updated_at)
    VALUES
      ('card-1', 'One', 'en', 'pokemon', 'set', 'Set', '1', 1, 1, 1, 1),
      ('card-2', 'Two', 'en', 'pokemon', 'set', 'Set', '2', 2, 2, 1, 1),
      ('card-3', 'Three', 'en', 'pokemon', 'set', 'Set', '3', 3, 3, 1, 1);
  `);
  return { database, db: sqliteD1(database) };
}

describe('bulk binder placement', () => {
  it('creates an active binder, preserves order and duplicates, and allocates pages atomically', async () => {
    const { database, db } = setup();
    const created = await createBinder(
      db,
      'owner',
      'Binder',
      { kind: '2x2', rows: 2, columns: 2 },
      8,
    );
    expect(created.version.status).toBe('active');
    expect(
      database
        .prepare('SELECT active_version_id FROM binders WHERE id = ?1')
        .get(created.version.binderId),
    ).toEqual({ active_version_id: created.version.id });

    const result = await addCardsToBinderVersion(
      db,
      'owner',
      created.version.id,
      ['card-2', 'card-1', 'card-2', 'card-3', 'card-1'],
      created.version.revision,
    );
    expect(result.added).toBe(5);
    expect(result.binder.version.pageCount).toBe(2);
    const binder = await getBinderVersion(db, 'owner', created.version.id, 0, 2);
    expect(binder.pages.flatMap((page) => page.slots.map((slot) => slot.cardId))).toEqual([
      'card-2',
      'card-1',
      'card-2',
      'card-3',
      'card-1',
      null,
      null,
      null,
    ]);
  });

  it('rolls back page allocation when the expected revision is stale', async () => {
    const { database, db } = setup();
    const created = await createBinder(db, 'owner', 'Binder', { kind: '2x2', rows: 2, columns: 2 });
    await expect(
      addCardsToBinderVersion(db, 'owner', created.version.id, ['card-1'], 99),
    ).rejects.toMatchObject({ code: 'binder_revision_conflict' });
    expect(
      database
        .prepare('SELECT COUNT(*) AS count FROM binder_pages WHERE binder_version_id = ?1')
        .get(created.version.id),
    ).toEqual({ count: 1 });
  });
});

describe('binder copy choices', () => {
  it('adds and places one copy atomically and rejects replay without adding a second', async () => {
    const { database, db } = setup();
    const created = await createBinder(db, 'owner', 'Binder', { kind: '2x2', rows: 2, columns: 2 });
    const result = await setBinderSlot(db, 'owner', created.version.id, 0, 0, 0, 'card-1', 1, {
      action: 'add',
      expectedCollectionRevision: 0,
    });
    expect(result.pages[0]?.slots[0]).toMatchObject({ cardId: 'card-1', assignedCardId: 'card-1' });
    expect(database.prepare('SELECT quantity, revision FROM collection_cards').get()).toEqual({
      quantity: 1,
      revision: 1,
    });
    await expect(
      setBinderSlot(db, 'owner', created.version.id, 0, 0, 0, 'card-1', 1, {
        action: 'add',
        expectedCollectionRevision: 0,
      }),
    ).rejects.toMatchObject({ code: 'binder_revision_conflict' });
    expect(database.prepare('SELECT quantity FROM collection_cards').get()).toEqual({
      quantity: 1,
    });
    await setBinderSlot(db, 'owner', created.version.id, 0, 0, 1, 'card-1', 2, {
      action: 'add',
      expectedCollectionRevision: 1,
    });
    expect(database.prepare('SELECT quantity, revision FROM collection_cards').get()).toEqual({
      quantity: 2,
      revision: 2,
    });
  });

  it('uses an owned copy without incrementing and refuses to reuse it in another slot', async () => {
    const { database, db } = setup();
    database.exec(
      "INSERT INTO collection_cards (owner_id, card_id, quantity, revision, updated_at, notes) VALUES ('owner', 'card-1', 1, 1, 1, 'Keep note')",
    );
    const created = await createBinder(db, 'owner', 'Binder', { kind: '2x2', rows: 2, columns: 2 });
    await setBinderSlot(db, 'owner', created.version.id, 0, 0, 0, 'card-1', 1, {
      action: 'existing',
    });
    await expect(
      setBinderSlot(db, 'owner', created.version.id, 0, 0, 1, 'card-1', 2, { action: 'existing' }),
    ).rejects.toMatchObject({ code: 'binder_assignment_quantity_exceeded' });
    expect(
      database.prepare('SELECT quantity, revision, notes FROM collection_cards').get(),
    ).toEqual({ quantity: 1, revision: 1, notes: 'Keep note' });
    await setBinderSlot(db, 'owner', created.version.id, 0, 0, 0, 'card-1', 2, {
      action: 'existing',
    });
    const planned = await setBinderSlot(db, 'owner', created.version.id, 0, 0, 0, 'card-2', 3, {
      action: 'none',
    });
    expect(planned.pages[0]?.slots[0]).toMatchObject({ cardId: 'card-2', assignedCardId: null });
    expect(database.prepare('SELECT COUNT(*) AS count FROM collection_cards').get()).toEqual({
      count: 1,
    });
  });

  it('rolls back an added copy if the slot is on a reserved page', async () => {
    const { database, db } = setup();
    const created = await createBinder(db, 'owner', 'Binder', { kind: '2x2', rows: 2, columns: 2 });
    await reserveBinderPage(db, 'owner', created.version.id, 0, true, 'Reserved', 1);
    await expect(
      setBinderSlot(db, 'owner', created.version.id, 0, 0, 0, 'card-1', 2, {
        action: 'add',
        expectedCollectionRevision: 0,
      }),
    ).rejects.toThrow();
    expect(database.prepare('SELECT COUNT(*) AS count FROM collection_cards').get()).toEqual({
      count: 0,
    });
    const binder = await getBinderVersion(db, 'owner', created.version.id);
    expect(binder.version.revision).toBe(2);
  });

  it('rejects a changed collection count and the collection limit without changing the target', async () => {
    const { database, db } = setup();
    database.exec(
      "INSERT INTO collection_cards (owner_id, card_id, quantity, revision, updated_at) VALUES ('owner', 'card-1', 9999, 2, 1)",
    );
    const created = await createBinder(db, 'owner', 'Binder', { kind: '2x2', rows: 2, columns: 2 });
    await expect(
      setBinderSlot(db, 'owner', created.version.id, 0, 0, 0, 'card-1', 1, {
        action: 'add',
        expectedCollectionRevision: 1,
      }),
    ).rejects.toMatchObject({ code: 'collection_revision_conflict' });
    await expect(
      setBinderSlot(db, 'owner', created.version.id, 0, 0, 0, 'card-1', 1, {
        action: 'add',
        expectedCollectionRevision: 2,
      }),
    ).rejects.toMatchObject({ code: 'collection_quantity_out_of_bounds' });
    expect((await getBinderVersion(db, 'owner', created.version.id)).version.revision).toBe(1);
  });
});
