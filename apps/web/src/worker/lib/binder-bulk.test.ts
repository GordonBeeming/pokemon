import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { addCardsToBinderVersion, createBinder, getBinderVersion } from './binders';
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
    const created = await createBinder(db, 'owner', 'Binder', { kind: '2x2', rows: 2, columns: 2 });
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
