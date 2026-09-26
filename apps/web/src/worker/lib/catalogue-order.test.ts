import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
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
  database.exec(
    `INSERT INTO users (id,label,created_at) VALUES ('owner','Owner',1), ('other','Other',1);`,
  );
  for (let index = 1; index <= 35; index++) {
    database
      .prepare(
        `INSERT INTO catalogue_cards (id,name,language,category,set_id,set_name,number,number_sort,pokedex_number,created_at,updated_at)
      VALUES (?1,'Squirtle','en','pokemon','base','Base',?2,?3,7,1,1)`,
      )
      .run(`card-${index}`, String(index), index);
  }
  database.exec(`INSERT INTO collection_cards (owner_id,card_id,quantity,revision,updated_at) VALUES
    ('owner','card-30',1,1,1), ('owner','card-35',2,1,1), ('owner','card-1',0,1,1), ('other','card-34',1,1,1);`);
  return sqliteD1(database);
}
describe('catalogue ownership ordering', () => {
  it.each([{}, { pokedexNumber: 7 }])(
    'shows owned cards first across cursor pages for %j',
    async (filters) => {
      const db = setup();
      const first = await searchCards(db, 'owner', { ...filters, limit: 24, offset: 0 });
      expect(first.cards.slice(0, 3).map((card) => card.id)).toEqual([
        'card-30',
        'card-35',
        'card-1',
      ]);
      const next = await searchCards(db, 'owner', {
        ...filters,
        limit: 24,
        offset: 0,
        cursor: first.cursor,
      });
      const ids = [...first.cards, ...next.cards].map((card) => card.id);
      expect(ids).toHaveLength(35);
      expect(new Set(ids).size).toBe(35);
      expect(next.cursor).toBeNull();
      const offset = await searchCards(db, 'owner', { ...filters, limit: 24, offset: 24 });
      expect(offset.cards.map((card) => card.id)).toEqual(next.cards.map((card) => card.id));
    },
  );
  it('crosses from owned to unowned when the page ends on the last owned card', async () => {
    const db = setup();
    const first = await searchCards(db, 'owner', { limit: 2, offset: 0 });
    const next = await searchCards(db, 'owner', { limit: 2, offset: 0, cursor: first.cursor });
    expect(next.cards.map((card) => card.id)).toEqual(['card-1', 'card-2']);
  });
  it('preserves numbered set checklists and their pagination', async () => {
    const db = setup();
    const first = await searchCards(db, 'owner', { setId: 'base', limit: 24, offset: 0 });
    const next = await searchCards(db, 'owner', {
      setId: 'base',
      limit: 24,
      offset: 0,
      cursor: first.cursor,
    });
    expect([...first.cards, ...next.cards].map((card) => card.id)).toEqual(
      Array.from({ length: 35 }, (_, i) => `card-${i + 1}`),
    );
  });
});
