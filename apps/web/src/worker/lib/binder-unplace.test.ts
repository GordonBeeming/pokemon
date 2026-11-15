import { DatabaseSync } from 'node:sqlite';
import { cardIdSchema, type BinderEntry } from '@pokedex/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createBinder,
  getBinderVersion,
  insertBinderEntries,
  setBinderEntryAssignment,
} from './binders';
import { setCollectionState } from './collection';
import { applyAllMigrations, sqliteD1 } from './d1-test-helper';

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
const targets: BinderEntry[] = [
  { kind: 'set', setId: '30th', setLanguage: 'en', startsNewPage: false },
  { kind: 'pokemon', pokemonNumber: 25, startsNewPage: false },
  { kind: 'exact-card', cardId: cardIdSchema.parse('print-a'), startsNewPage: false },
];

describe('moving a placed copy out of its pocket', () => {
  it.each(targets)('preserves the $kind target and the owned copies', async (target) => {
    const raw = new DatabaseSync(':memory:');
    databases.push(raw);
    applyAllMigrations(raw);
    raw.exec(`INSERT INTO users(id,label,created_at) VALUES('owner','Owner',1);
      INSERT INTO catalogue_cards(id,name,language,category,set_id,set_name,number,pokedex_number,created_at,updated_at)
      VALUES('print-a','Pikachu','en','pokemon','30th','30th Classic','1',25,1,1);
      INSERT INTO catalogue_sets(set_id,language,set_name,updated_at) VALUES('30th','en','30th Classic',1);`);
    const db = sqliteD1(raw);
    await setCollectionState(db, 'owner', {
      cardId: 'print-a',
      mutationId: crypto.randomUUID(),
      expectedRevision: 0,
      quantity: 2,
      notes: 'Keep this note',
    });
    const created = await createBinder(db, 'owner', 'Binder', { kind: '2x2', rows: 2, columns: 2 });
    const versionId = created.version.id;
    const at = { page: 0, row: 0, column: 0 };
    const inserted = await insertBinderEntries(
      db,
      'owner',
      versionId,
      at,
      [target],
      created.version.revision,
    );
    const placed = await setBinderEntryAssignment(
      db,
      'owner',
      versionId,
      at,
      'print-a',
      inserted.version.revision,
    );
    const before = await getBinderVersion(db, 'owner', versionId, 0, 1);
    const beforeSlot = before.pages[0]?.slots[0];
    if (!beforeSlot) throw new Error('Missing placed fixture');
    const collectionBefore = raw.prepare('SELECT * FROM collection_cards').all();

    const moved = await setBinderEntryAssignment(
      db,
      'owner',
      versionId,
      at,
      null,
      placed.version.revision,
    );
    const after = await getBinderVersion(db, 'owner', versionId, 0, 1);
    expect(after.pages[0]?.slots[0]).toEqual({ ...beforeSlot, assignedCardId: null });
    expect(after.pages[0]?.slots.slice(1)).toEqual(before.pages[0]?.slots.slice(1));
    expect(raw.prepare('SELECT * FROM collection_cards').all()).toEqual(collectionBefore);
    expect(moved.version.revision).toBeGreaterThan(placed.version.revision);
  });
});
