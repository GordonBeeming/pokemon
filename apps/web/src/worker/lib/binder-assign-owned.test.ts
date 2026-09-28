import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { assignOwnedExactTargets } from './binders';
import { applyAllMigrations, sqliteD1 } from './d1-test-helper';

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

/**
 * An active 2x2 binder shaped like Gordon's older pages: Squirtle and Bulbasaur are
 * exact targets with nothing recorded as placed, a Pikachu any-Pokémon target, and an
 * empty pocket. He owns 1 Squirtle and 2 Bulbasaur, one Bulbasaur already placed in a
 * second binder.
 */
function setup(): { raw: DatabaseSync; db: D1Database } {
  const raw = new DatabaseSync(':memory:');
  databases.push(raw);
  applyAllMigrations(raw);
  raw.exec(`
    INSERT INTO users (id, label, created_at) VALUES ('owner', 'Owner', 1), ('other', 'Other', 1);
    INSERT INTO catalogue_cards
      (id, name, language, category, set_id, set_name, number, number_sort, pokedex_number, created_at, updated_at)
    VALUES
      ('squirtle', 'Squirtle', 'en', 'pokemon', 'base', 'Base', '63', 63, 7, 1, 1),
      ('bulbasaur', 'Bulbasaur', 'en', 'pokemon', 'base', 'Base', '44', 44, 1, 1, 1),
      ('bulbasaur-2', 'Bulbasaur', 'en', 'pokemon', 'jungle', 'Jungle', '1', 1, 1, 1, 1);
    INSERT INTO collection_cards (owner_id, card_id, quantity, revision, updated_at)
    VALUES ('owner', 'squirtle', 1, 1, 1), ('owner', 'bulbasaur', 2, 1, 1);
    INSERT INTO binders (id, owner_id, name, created_at, updated_at)
    VALUES ('binder', 'owner', 'National', 1, 1), ('binder-b', 'owner', 'Other binder', 1, 1);
    INSERT INTO binder_versions
      (id, binder_id, version_number, status, layout_kind, rows, columns, capacity, created_at, revision)
    VALUES
      ('version', 'binder', 1, 'active', '2x2', 2, 2, 4, 1, 5),
      ('version-b', 'binder-b', 1, 'active', '2x2', 2, 2, 4, 1, 1);
    UPDATE binders SET active_version_id = 'version' WHERE id = 'binder';
    UPDATE binders SET active_version_id = 'version-b' WHERE id = 'binder-b';
    INSERT INTO binder_pages (id, binder_version_id, position)
    VALUES ('page', 'version', 0), ('page-b', 'version-b', 0);
    INSERT INTO binder_slots (binder_page_id, row_index, column_index, card_id, pokemon_number, assigned_card_id, entry_kind)
    VALUES
      ('page', 0, 0, 'bulbasaur', NULL, NULL, 'exact-card'),
      ('page', 0, 1, NULL, 25, NULL, 'pokemon'),
      ('page', 1, 0, 'squirtle', NULL, NULL, 'exact-card'),
      ('page', 1, 1, 'bulbasaur', NULL, NULL, 'exact-card'),
      ('page-b', 0, 0, 'bulbasaur', NULL, 'bulbasaur', 'exact-card'),
      ('page-b', 0, 1, NULL, NULL, NULL, 'empty'),
      ('page-b', 1, 0, NULL, NULL, NULL, 'empty'),
      ('page-b', 1, 1, NULL, NULL, NULL, 'empty');
  `);
  return { raw, db: sqliteD1(raw) };
}

function assigned(raw: DatabaseSync): unknown {
  return raw
    .prepare(
      `SELECT row_index, column_index, assigned_card_id FROM binder_slots
       WHERE binder_page_id = 'page' ORDER BY row_index, column_index`,
    )
    .all();
}

describe('assignOwnedExactTargets', () => {
  it('previews only pockets with a loose owned copy, in page order, and changes nothing', async () => {
    const { raw, db } = setup();
    const before = assigned(raw);
    const result = await assignOwnedExactTargets(db, 'owner', 'version', 5, false);
    // One Bulbasaur is already placed in the other binder, so only one loose copy is left.
    expect(result.locations).toEqual([
      { page: 0, row: 0, column: 0 },
      { page: 0, row: 1, column: 0 },
    ]);
    expect(assigned(raw)).toEqual(before);
  });

  it('applies the same pockets, bumps the revision, and never touches any-Pokémon targets', async () => {
    const { raw, db } = setup();
    await assignOwnedExactTargets(db, 'owner', 'version', 5, true);
    expect(assigned(raw)).toEqual([
      { row_index: 0, column_index: 0, assigned_card_id: 'bulbasaur' },
      { row_index: 0, column_index: 1, assigned_card_id: null },
      { row_index: 1, column_index: 0, assigned_card_id: 'squirtle' },
      { row_index: 1, column_index: 1, assigned_card_id: null },
    ]);
    expect(raw.prepare(`SELECT revision FROM binder_versions WHERE id = 'version'`).get()).toEqual({
      revision: 6,
    });
    // Nothing left to do on a second run.
    expect((await assignOwnedExactTargets(db, 'owner', 'version', 6, false)).locations).toEqual([]);
  });

  it('refuses a stale revision without changing anything', async () => {
    const { raw, db } = setup();
    const before = assigned(raw);
    await expect(assignOwnedExactTargets(db, 'owner', 'version', 4, true)).rejects.toMatchObject({
      code: 'binder_revision_conflict',
    });
    expect(assigned(raw)).toEqual(before);
  });

  it("can't reach another owner's binder", async () => {
    const { raw, db } = setup();
    const before = assigned(raw);
    await expect(assignOwnedExactTargets(db, 'other', 'version', 5, true)).rejects.toMatchObject({
      code: 'binder_version_not_found',
    });
    expect(assigned(raw)).toEqual(before);
  });
});
