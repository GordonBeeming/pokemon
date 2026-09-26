import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchCards } from './catalogue';
import { applyAllMigrations, sqliteD1 } from './d1-test-helper';
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function setup(): D1Database {
  const database = new DatabaseSync(':memory:');
  databases.push(database);
  applyAllMigrations(database);
  database.exec("INSERT INTO users (id,label,created_at) VALUES ('owner','Owner',1)");
  const numbers = [
    '23',
    '023',
    '023/132',
    '23/132',
    '230',
    '1/23',
    'SV23',
    '111',
    '0111/132',
    '1110',
    '1/111',
    '0',
    '000',
    '0/132',
    '',
  ];
  for (const [index, number] of numbers.entries()) {
    const id = `card-${index}`;
    database
      .prepare(
        `INSERT INTO catalogue_cards (id,name,language,category,set_id,set_name,number,number_sort,pokedex_number,created_at,updated_at)
      VALUES (?1,'Squirtle','en','pokemon',?2,?2,?3,?4,7,1,1)`,
      )
      .run(id, index === 3 ? 'Other' : 'Base', number, index);
    database
      .prepare(
        `INSERT INTO catalogue_search (card_id,name,set_name,number,species,rarity,artist)
      VALUES (?1,'Squirtle','Base',?2,'Squirtle','Common','Artist')`,
      )
      .run(id, number);
  }
  database.exec(
    "INSERT INTO collection_cards (owner_id,card_id,quantity,revision,updated_at) VALUES ('owner','card-2',1,1,1)",
  );
  return sqliteD1(database);
}
describe('exact collector-number search', () => {
  it('uses the normalized-number index for the actual catalogue query', async () => {
    const db = setup();
    const prepare = vi.spyOn(db, 'prepare');
    await searchCards(db, 'owner', { query: '23', limit: 24, offset: 0 });
    const sql = prepare.mock.calls.find(
      ([query]) => query.includes('ORDER BY') && query.includes('ltrim('),
    )?.[0];
    const database = databases.at(-1);
    if (!sql || !database) throw new Error('Missing search query or database');
    const plan = database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('owner', '23', 25, 0);
    expect(
      plan.some((row) => String(row.detail).includes('idx_catalogue_cards_collector_number')),
    ).toBe(true);
  });
  it.each(['23', '023', '00023', ' #023 '])(
    'ignores leading zeros for %s while keeping owned cards first',
    async (query) => {
      const result = await searchCards(setup(), 'owner', { query, limit: 24, offset: 0 });
      expect(result.cards.map((card) => card.number)).toEqual(['023/132', '23', '023', '23/132']);
      expect(result.total).toBe(4);
    },
  );
  it('matches the numerator exactly rather than a prefix or set total', async () => {
    const result = await searchCards(setup(), 'owner', { query: '111', limit: 24, offset: 0 });
    expect(result.cards.map((card) => card.number)).toEqual(['111', '0111/132']);
  });
  it('handles zero without matching an empty card number', async () => {
    const result = await searchCards(setup(), 'owner', { query: '000', limit: 24, offset: 0 });
    expect(result.cards.map((card) => card.number)).toEqual(['0', '000', '0/132']);
  });
  it('preserves the search filters and cursor across number pages', async () => {
    const db = setup();
    const filters = {
      query: '23',
      setId: 'Base',
      pokedexNumber: 7,
      language: 'en' as const,
      limit: 1,
      offset: 0,
    };
    const first = await searchCards(db, 'owner', filters);
    const second = await searchCards(db, 'owner', {
      ...filters,
      query: '023',
      cursor: first.cursor,
    });
    expect(first.total).toBe(3);
    expect(first.cards.map((card) => card.number)).toEqual(['023/132']);
    expect(second.cards.map((card) => card.number)).toEqual(['23']);
    await expect(
      searchCards(db, 'owner', { ...filters, query: '111', cursor: first.cursor }),
    ).rejects.toMatchObject({ code: 'invalid_catalogue_cursor' });
    const owned = await searchCards(db, 'owner', { ...filters, limit: 24, owned: true });
    expect(owned.cards.map((card) => card.number)).toEqual(['023/132']);
  });
  it('keeps text-prefix and mixed text searches working', async () => {
    const db = setup();
    const text = await searchCards(db, 'owner', { query: 'Squir', limit: 24, offset: 0 });
    expect(text.total).toBe(15);
    const mixed = await searchCards(db, 'owner', { query: 'Squirtle 111', limit: 24, offset: 0 });
    expect(mixed.cards.map((card) => card.number)).toEqual(['111', '1110', '1/111']);
  });
});
