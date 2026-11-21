import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { customCardBody } from '../routes/api/contracts';
import { createCustomCard } from './catalogue';
import { createBinder, insertBinderEntries, placeCard } from './binders';
import { applyAllMigrations, sqliteD1 } from './d1-test-helper';

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const raw of databases.splice(0)) raw.close();
});

it.each([undefined, 7])(
  'places a custom Squirtle into its species target (explicit dex: %s)',
  async (pokedexNumber) => {
    const raw = new DatabaseSync(':memory:');
    databases.push(raw);
    applyAllMigrations(raw);
    raw.exec("INSERT INTO users(id,label,created_at) VALUES('owner','Owner',1)");
    const db = sqliteD1(raw);
    const cardId = await createCustomCard(db, 'owner', {
      name: 'Squirtle (Unofficial fan art)',
      language: 'en',
      category: 'pokemon',
      setId: 'unofficial-fan-art-055',
      setName: 'Unofficial fan art',
      number: '025/055',
      species: 'Squirtle',
      ...(pokedexNumber ? { pokedexNumber } : {}),
    });
    const created = await createBinder(db, 'owner', 'Squirtles', {
      kind: '3x3',
      rows: 3,
      columns: 3,
    });
    const target = await insertBinderEntries(
      db,
      'owner',
      created.version.id,
      { page: 0, row: 2, column: 2 },
      [{ kind: 'pokemon', pokemonNumber: 7, startsNewPage: false }],
      created.version.revision,
    );
    const pageId = target.pages[0]?.id;
    if (!pageId) throw new Error('Missing page');
    const placed = await placeCard(
      db,
      'owner',
      cardId,
      created.version.binderId,
      `${pageId}:2:2`,
      true,
      target.version.revision,
    );
    expect(placed.pages[0]?.slots.find((s) => s.row === 2 && s.column === 2)).toMatchObject({
      pokemonNumber: 7,
      assignedCardId: cardId,
    });
    expect(
      raw.prepare('SELECT pokedex_number FROM catalogue_cards WHERE id=?').get(cardId),
    ).toMatchObject({ pokedex_number: 7 });
  },
);

it('backfills only unambiguous legacy species without changing ownership or explicit numbers', () => {
  const raw = new DatabaseSync(':memory:');
  databases.push(raw);
  applyAllMigrations(raw);
  raw.exec("INSERT INTO users(id,label,created_at) VALUES('owner','Owner',1)");
  const insert = raw.prepare(`INSERT INTO catalogue_cards
    (id,name,language,category,set_id,set_name,number,species,pokedex_number,is_custom,owner_id,created_at,updated_at)
    VALUES (?1,?2,'en',?3,'test','Test',?1,?4,?5,?6,?7,1,1)`);
  insert.run('official', 'Squirtle', 'pokemon', 'Squirtle', 7, 0, null);
  insert.run('official-alt', 'Squirtle', 'pokemon', 'Squirtle', 7, 0, null);
  insert.run('legacy', 'Squirtle fan art', 'pokemon', 'Squirtle', null, 1, 'owner');
  insert.run('global', 'Squirtle fan art', 'pokemon', ' squirtle ', null, 1, null);
  insert.run('explicit', 'Squirtle fan art', 'pokemon', 'Squirtle', 25, 1, 'owner');
  insert.run('no-species', 'Squirtle (Unofficial fan art)', 'pokemon', null, null, 1, 'owner');
  insert.run(
    'bad-species',
    'Squirtle (Unofficial fan art)',
    'pokemon',
    'Unknown',
    null,
    1,
    'owner',
  );
  insert.run('ambiguous-a', 'Ambiguous', 'pokemon', null, 7, 0, null);
  insert.run('ambiguous-b', 'Ambiguous', 'pokemon', null, 25, 0, null);
  insert.run('ambiguous', 'Ambiguous (Unofficial fan art)', 'pokemon', null, null, 1, 'owner');
  insert.run('unknown', 'Mystery', 'pokemon', 'SquirtleX', null, 1, 'owner');
  insert.run('trainer', 'Squirtle trainer', 'trainer', 'Squirtle', null, 1, 'owner');
  const migration = readFileSync(
    new URL('../../../migrations/034_custom_card_pokedex.sql', import.meta.url),
    'utf8',
  );
  raw.exec(migration);
  raw.exec(migration);
  expect(
    raw
      .prepare(
        'SELECT id,pokedex_number,owner_id FROM catalogue_cards WHERE is_custom=1 ORDER BY id',
      )
      .all(),
  ).toEqual([
    { id: 'ambiguous', pokedex_number: null, owner_id: 'owner' },
    { id: 'bad-species', pokedex_number: 7, owner_id: 'owner' },
    { id: 'explicit', pokedex_number: 25, owner_id: 'owner' },
    { id: 'global', pokedex_number: 7, owner_id: null },
    { id: 'legacy', pokedex_number: 7, owner_id: 'owner' },
    { id: 'no-species', pokedex_number: 7, owner_id: 'owner' },
    { id: 'trainer', pokedex_number: null, owner_id: 'owner' },
    { id: 'unknown', pokedex_number: null, owner_id: 'owner' },
  ]);
});

it.each([
  { category: 'pokemon' as const, name: 'Squirtle (Unofficial fan art)', expected: 7 },
  { category: 'pokemon' as const, name: 'Mystery creature', expected: null },
  { category: 'trainer' as const, name: 'Squirtle trainer', expected: null },
])('infers only recognizable Pokemon names: $name', async ({ category, name, expected }) => {
  const raw = new DatabaseSync(':memory:');
  databases.push(raw);
  applyAllMigrations(raw);
  raw.exec("INSERT INTO users(id,label,created_at) VALUES('owner','Owner',1)");
  const id = await createCustomCard(sqliteD1(raw), 'owner', {
    name,
    category,
    language: 'en',
    setId: 'custom',
    setName: 'Custom',
    number: '1',
  });
  expect(
    raw.prepare('SELECT pokedex_number FROM catalogue_cards WHERE id=?').get(id),
  ).toMatchObject({ pokedex_number: expected });
});

it('rejects invalid explicit dex numbers at the API and domain boundaries', async () => {
  const raw = new DatabaseSync(':memory:');
  databases.push(raw);
  applyAllMigrations(raw);
  raw.exec("INSERT INTO users(id,label,created_at) VALUES('owner','Owner',1)");
  for (const pokedexNumber of [0, 1026, 1.5]) {
    const input = {
      name: 'Squirtle',
      category: 'pokemon' as const,
      language: 'en' as const,
      setId: 'custom',
      setName: 'Custom',
      number: '1',
      pokedexNumber,
    };
    expect(customCardBody.safeParse(input).success).toBe(false);
    await expect(createCustomCard(sqliteD1(raw), 'owner', input)).rejects.toMatchObject({
      code: 'invalid_pokedex_number',
    });
  }
  expect(raw.prepare('SELECT COUNT(*) AS n FROM catalogue_cards').get()).toMatchObject({ n: 0 });
});

it('falls back to the card name when species text is not recognized', async () => {
  const raw = new DatabaseSync(':memory:');
  databases.push(raw);
  applyAllMigrations(raw);
  raw.exec("INSERT INTO users(id,label,created_at) VALUES('owner','Owner',1)");
  const id = await createCustomCard(sqliteD1(raw), 'owner', {
    name: 'Squirtle (Unofficial fan art)',
    species: 'Unknown',
    category: 'pokemon',
    language: 'en',
    setId: 'custom',
    setName: 'Custom',
    number: '1',
  });
  expect(
    raw.prepare('SELECT pokedex_number FROM catalogue_cards WHERE id=?').get(id),
  ).toMatchObject({ pokedex_number: 7 });
});
