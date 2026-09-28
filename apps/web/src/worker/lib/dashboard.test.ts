import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { activeBinderShortages } from './binders';
import { applyAllMigrations, sqliteD1 } from './d1-test-helper';
import { dashboardBinderProgress, dashboardStillToFind } from './dashboard';

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

/**
 * Two owner binders: "Kanto" is a 2x2 with one exact-card target (Bulbasaur, placed)
 * and one any-Pokémon target (#25, unfilled); "Overflow" is a 3x3 with nothing
 * placed yet. A second owner's binder proves owner isolation.
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
      ('bulbasaur', 'Bulbasaur', 'en', 'pokemon', 'base', 'Base Set', '44', 44, 1, 1, 1);
    INSERT INTO collection_cards (owner_id, card_id, quantity, revision, updated_at)
    VALUES ('owner', 'bulbasaur', 1, 1, 1);
    INSERT INTO binders (id, owner_id, name, created_at, updated_at)
    VALUES ('kanto', 'owner', 'Kanto', 1, 2), ('overflow', 'owner', 'Overflow', 1, 1),
      ('other-binder', 'other', 'Other owner binder', 1, 1);
    INSERT INTO binder_versions
      (id, binder_id, version_number, status, layout_kind, rows, columns, capacity, created_at, revision)
    VALUES
      ('kanto-v1', 'kanto', 1, 'active', '2x2', 2, 2, 4, 1, 1),
      ('overflow-v1', 'overflow', 1, 'active', '3x3', 3, 3, 9, 1, 1),
      ('other-v1', 'other-binder', 1, 'active', '2x2', 2, 2, 4, 1, 1);
    UPDATE binders SET active_version_id = 'kanto-v1' WHERE id = 'kanto';
    UPDATE binders SET active_version_id = 'overflow-v1' WHERE id = 'overflow';
    UPDATE binders SET active_version_id = 'other-v1' WHERE id = 'other-binder';
    INSERT INTO binder_pages (id, binder_version_id, position)
    VALUES ('kanto-p0', 'kanto-v1', 0), ('overflow-p0', 'overflow-v1', 0),
      ('other-p0', 'other-v1', 0);
    INSERT INTO binder_slots
      (binder_page_id, row_index, column_index, card_id, pokemon_number, assigned_card_id, entry_kind)
    VALUES
      ('kanto-p0', 0, 0, 'bulbasaur', NULL, 'bulbasaur', 'exact-card'),
      ('kanto-p0', 0, 1, NULL, 25, NULL, 'pokemon'),
      ('kanto-p0', 1, 0, NULL, NULL, NULL, 'empty'),
      ('kanto-p0', 1, 1, NULL, NULL, NULL, 'empty'),
      ('overflow-p0', 0, 0, NULL, 2, NULL, 'pokemon'),
      ('overflow-p0', 0, 1, NULL, 3, NULL, 'pokemon'),
      ('overflow-p0', 0, 2, NULL, NULL, NULL, 'empty'),
      ('overflow-p0', 1, 0, NULL, NULL, NULL, 'empty'),
      ('overflow-p0', 1, 1, NULL, NULL, NULL, 'empty'),
      ('overflow-p0', 1, 2, NULL, NULL, NULL, 'empty'),
      ('overflow-p0', 2, 0, NULL, NULL, NULL, 'empty'),
      ('overflow-p0', 2, 1, NULL, NULL, NULL, 'empty'),
      ('overflow-p0', 2, 2, NULL, NULL, NULL, 'empty'),
      ('other-p0', 0, 0, NULL, 4, NULL, 'pokemon'),
      ('other-p0', 0, 1, NULL, NULL, NULL, 'empty'),
      ('other-p0', 1, 0, NULL, NULL, NULL, 'empty'),
      ('other-p0', 1, 1, NULL, NULL, NULL, 'empty');
  `);
  return { raw, db: sqliteD1(raw) };
}

it('reports per-binder targets, placed and percent using the placed-copy rule, scoped to the owner', async () => {
  const { db } = setup();
  const progress = await dashboardBinderProgress(db, 'owner');
  expect(progress).toEqual([
    { id: 'kanto', name: 'Kanto', targets: 2, placed: 1, percent: 50 },
    { id: 'overflow', name: 'Overflow', targets: 2, placed: 0, percent: 0 },
  ]);
});

it('ranks still-to-find by missing count, resolves labels and the binder each target is short in, and caps at 8', async () => {
  const { db } = setup();
  const report = await activeBinderShortages(db, 'owner');
  const stillToFind = await dashboardStillToFind(
    db,
    'owner',
    report.shortages,
    report.pokemonShortages,
  );

  // Bulbasaur (exact-card) is already fully placed, so it isn't a shortage; #25 in
  // Kanto and #2/#3 in Overflow are the owner's only unfilled targets.
  expect(stillToFind).toHaveLength(3);
  expect(stillToFind.every((item) => item.missing === 1)).toBe(true);
  const byPokemon = new Map(stillToFind.map((item) => [item.pokemonNumber, item]));
  expect(byPokemon.get(25)).toMatchObject({
    kind: 'pokemon',
    label: '#0025 Pikachu',
    binderId: 'kanto',
    binderName: 'Kanto',
  });
  expect(byPokemon.get(2)).toMatchObject({ binderId: 'overflow', binderName: 'Overflow' });
  expect(byPokemon.get(3)).toMatchObject({ binderId: 'overflow', binderName: 'Overflow' });
  // The other owner's shortage (#4) never appears.
  expect(byPokemon.has(4)).toBe(false);
});

it('sorts higher-missing targets first and never returns more than 8 entries', async () => {
  const raw = new DatabaseSync(':memory:');
  databases.push(raw);
  applyAllMigrations(raw);
  raw.exec("INSERT INTO users (id, label, created_at) VALUES ('owner', 'Owner', 1);");
  raw.exec(
    "INSERT INTO binders (id, owner_id, name, created_at, updated_at) VALUES ('binder', 'owner', 'Binder', 1, 1);",
  );
  raw.exec(
    `INSERT INTO binder_versions
      (id, binder_id, version_number, status, layout_kind, rows, columns, capacity, created_at, revision)
     VALUES ('v1', 'binder', 1, 'active', 'custom', 20, 20, 400, 1, 1);
     UPDATE binders SET active_version_id = 'v1' WHERE id = 'binder';
     INSERT INTO binder_pages (id, binder_version_id, position) VALUES ('p0', 'v1', 0);`,
  );
  // Ten any-Pokémon targets, each requiring an increasing number of copies (1..10)
  // and none owned, so #10 is the largest shortage and should sort first.
  for (let number = 1; number <= 10; number++)
    for (let copy = 0; copy < number; copy++)
      raw
        .prepare(
          `INSERT INTO binder_slots (binder_page_id, row_index, column_index, pokemon_number, entry_kind)
           VALUES ('p0', ?1, ?2, ?3, 'pokemon')`,
        )
        .run(number, copy, number);
  const db = sqliteD1(raw);
  const report = await activeBinderShortages(db, 'owner');
  const stillToFind = await dashboardStillToFind(
    db,
    'owner',
    report.shortages,
    report.pokemonShortages,
  );
  expect(stillToFind).toHaveLength(8);
  expect(stillToFind.map((item) => item.pokemonNumber)).toEqual([10, 9, 8, 7, 6, 5, 4, 3]);
  expect(stillToFind.map((item) => item.missing)).toEqual([10, 9, 8, 7, 6, 5, 4, 3]);
});
