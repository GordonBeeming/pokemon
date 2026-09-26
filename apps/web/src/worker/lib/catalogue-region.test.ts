import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { getCardDetail, searchCards } from './catalogue';
import { applyAllMigrations, sqliteD1 } from './d1-test-helper';
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function setup(): D1Database {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  applyAllMigrations(db);
  db.exec(`INSERT INTO users(id,label,created_at) VALUES('owner','Owner',1);
    INSERT INTO catalogue_cards(id,name,language,category,set_id,set_name,number,number_sort,pokedex_number,created_at,updated_at)
    VALUES ('card-1','Pikachu','en','pokemon','base','Base','1',1,25,1,1),
           ('card-2','Unknown species','en','pokemon','base','Base','2',2,9999,1,1);
    INSERT INTO card_sources(provider,source_id,card_id,language,source_updated_at,checksum,active,imported_at)
    VALUES ('tcgdex','base-1','card-1','en',1,'checksum',1,1),('tcgdex','base-2','card-2','en',1,'checksum',1,1);`);
  return sqliteD1(db);
}
describe('catalogue region metadata', () => {
  it('exposes bounded Pokemon numbers for opt-in search and detail requests', async () => {
    const db = setup();
    const page = await searchCards(db, 'owner', {
      limit: 10,
      offset: 0,
      includePokemonNumber: true,
    });
    expect(page.cards.map((card) => card.pokedexNumber)).toEqual([25, null]);
    expect(await getCardDetail(db, 'owner', 'card-1', true)).toMatchObject({ pokedexNumber: 25 });
    expect(await getCardDetail(db, 'owner', 'card-2', true)).toMatchObject({ pokedexNumber: null });
  });
  it('preserves the legacy response shape for clients that do not request the field', async () => {
    const db = setup();
    const page = await searchCards(db, 'owner', { limit: 10, offset: 0 });
    expect(page.cards.every((card) => !Object.hasOwn(card, 'pokedexNumber'))).toBe(true);
    expect(await getCardDetail(db, 'owner', 'card-1')).not.toHaveProperty('pokedexNumber');
  });
});
