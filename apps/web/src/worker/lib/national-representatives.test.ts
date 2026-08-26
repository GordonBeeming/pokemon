import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { setNationalRepresentativesFromSources } from './catalogue';
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
      (id, name, language, category, set_id, set_name, number, created_at, updated_at)
    VALUES ('card-bulbasaur', 'Bulbasaur', 'en', 'pokemon', 'set', 'Set', '1', 1, 1);
    INSERT INTO card_sources
      (provider, source_id, card_id, language, source_updated_at, checksum, active, imported_at)
    VALUES ('tcgdex', 'set-1', 'card-bulbasaur', 'en', 1, 'hash', 1, 1);
  `);
  return { database, db: sqliteD1(database) };
}

describe('bulk National Pokédex representatives', () => {
  it('sets an owner-scoped representative without rewriting canonical card metadata', async () => {
    const { database, db } = setup();
    const resolved = await setNationalRepresentativesFromSources(db, 'owner', [
      { number: 1, name: 'Bulbasaur', sourceId: 'set-1' },
    ]);
    expect(resolved).toEqual([{ number: 1, cardId: 'card-bulbasaur' }]);
    expect(database.prepare('SELECT pokedex_number FROM catalogue_cards').get()).toEqual({
      pokedex_number: null,
    });
    expect(
      database.prepare('SELECT pokedex_number, card_id FROM species_representatives').get(),
    ).toEqual({ pokedex_number: 1, card_id: 'card-bulbasaur' });
  });

  it('leaves representative state unchanged when any source is invalid', async () => {
    const { database, db } = setup();
    await expect(
      setNationalRepresentativesFromSources(db, 'owner', [
        { number: 1, name: 'Bulbasaur', sourceId: 'set-1' },
        { number: 2, name: 'Ivysaur', sourceId: 'missing' },
      ]),
    ).rejects.toMatchObject({ code: 'national_representatives_incomplete' });
    expect(database.prepare('SELECT * FROM species_representatives').all()).toEqual([]);
  });
});
