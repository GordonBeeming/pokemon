import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { applyAllMigrations, sqliteD1 } from './d1-test-helper';
import {
  importCatalogueLanguage,
  searchCards,
  listSetFacets,
  type ImportedCard,
} from './catalogue';

it('uses a single set date for every printing and preserves it through species refreshes', async () => {
  const database = new DatabaseSync(':memory:');
  try {
    applyAllMigrations(database);
    database.exec("INSERT INTO users(id,label,created_at) VALUES('owner','Owner',1)");
    const db = sqliteD1(database);
    const card = (
      sourceId: string,
      setId: string,
      setName: string,
      number: string,
      date: string | null,
      language: 'en' | 'ja' = 'en',
    ): ImportedCard => ({
      sourceId,
      setId,
      setName,
      number,
      releaseDate: date,
      language,
      name: 'Squirtle',
      category: 'pokemon',
      pokedexNumber: 7,
      sourceUpdatedAt: 1,
      checksum: 'a'.repeat(64),
    });
    const base = card('base1-63', 'base1', 'Base Set', '63', '1999-01-09');
    const modern = card('sv03.5-007', 'sv03.5', '151', '007', '2023-09-22');
    await importCatalogueLanguage(db, {
      provider: 'tcgdex',
      language: 'en',
      cards: [base, modern],
    });
    await importCatalogueLanguage(db, {
      provider: 'tcgdex',
      language: 'en',
      cards: [
        { ...base, releaseDate: null, checksum: 'b'.repeat(64) },
        { ...modern, releaseDate: null, checksum: 'b'.repeat(64) },
        card('sv03.5-170', 'sv03.5', '151', '170', null),
      ],
    });
    const result = await searchCards(db, 'owner', {
      pokedexNumber: 7,
      sort: 'release',
      language: 'en',
      limit: 50,
      offset: 0,
    });
    expect(result.cards.map((c) => [c.setName, c.number])).toEqual([
      ['Base Set', '63'],
      ['151', '007'],
      ['151', '170'],
    ]);
    expect(database.prepare('SELECT COUNT(*) AS count FROM catalogue_sets').get()).toEqual({
      count: 2,
    });
    expect(
      database
        .prepare('SELECT COUNT(*) AS count FROM catalogue_cards WHERE release_date IS NOT NULL')
        .get(),
    ).toEqual({ count: 0 });
    expect((await listSetFacets(db, 'owner')).map((s) => s.setId)).toEqual(['base1', 'sv03.5']);
    await importCatalogueLanguage(db, {
      provider: 'tcgdex',
      language: 'ja',
      cards: [card('base1-63', 'base1', 'Base Set', '63', '1996-10-20', 'ja')],
    });
    expect(
      database
        .prepare("SELECT release_date FROM catalogue_sets WHERE set_id='base1' ORDER BY language")
        .all(),
    ).toEqual([{ release_date: '1999-01-09' }, { release_date: '1996-10-20' }]);
    await importCatalogueLanguage(db, {
      provider: 'tcgdex',
      language: 'en',
      cards: [{ ...base, releaseDate: '2001-01-01' }],
    });
    expect(
      database
        .prepare("SELECT release_date FROM catalogue_sets WHERE set_id='base1' AND language='en'")
        .get(),
    ).toEqual({ release_date: '1999-01-09' });
    await importCatalogueLanguage(db, {
      provider: 'tcgdex',
      language: 'en',
      complete: true,
      cards: [
        { ...base, releaseDate: '1999-01-10' },
        modern,
        card('sv03.5-170', 'sv03.5', '151', '170', '2023-09-22'),
      ],
    });
    expect(
      database
        .prepare("SELECT release_date FROM catalogue_sets WHERE set_id='base1' AND language='en'")
        .get(),
    ).toEqual({ release_date: '1999-01-10' });
  } finally {
    database.close();
  }
});

it('migrates one known date per set even when the Squirtle row has no date', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE users(backup_epoch INTEGER);CREATE TABLE catalogue_cards(set_id TEXT,language TEXT,set_name TEXT,release_date TEXT,updated_at INTEGER);
      INSERT INTO catalogue_cards VALUES('base1','en','Base Set',NULL,1),('base1','en','Base Set','1999-01-09',1),('sv03.5','en','151',NULL,1),('sv03.5','en','151','2023-09-22',1);`);
    db.exec(
      readFileSync(new URL('../../../migrations/018_catalogue_sets.sql', import.meta.url), 'utf8'),
    );
    expect(
      db.prepare('SELECT set_id,release_date FROM catalogue_sets ORDER BY release_date').all(),
    ).toEqual([
      { set_id: 'base1', release_date: '1999-01-09' },
      { set_id: 'sv03.5', release_date: '2023-09-22' },
    ]);
    expect(
      db
        .prepare('SELECT COUNT(*) AS count FROM catalogue_cards WHERE release_date IS NOT NULL')
        .get(),
    ).toEqual({ count: 0 });
  } finally {
    db.close();
  }
});
