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

it('includes partner Pokémon printings without mixing up Mew and Mewtwo or exposing private cards', async () => {
  const raw = new DatabaseSync(':memory:');
  databases.push(raw);
  applyAllMigrations(raw);
  raw.exec(`INSERT INTO users(id,label,created_at) VALUES('owner','Owner',1),('other','Other',1);
    INSERT INTO catalogue_cards(id,name,language,category,set_id,set_name,number,pokedex_number,owner_id,created_at,updated_at) VALUES
    ('mimikyu','Mimikyu ex','en','pokemon','test','Test','1',778,NULL,1,1),
    ('fan-mimikyu','Mimikyu ex (Unofficial fan art)','en','pokemon','test','Test','8',NULL,NULL,1,1),
    ('gengar-mimikyu','Gengar & Mimikyu-GX','en','pokemon','test','Test','2',94,NULL,1,1),
    ('mew','Mew','en','pokemon','test','Test','3',151,NULL,1,1),
    ('mewtwo','Mewtwo','en','pokemon','test','Test','4',150,NULL,1,1),
    ('mewtwo-mew','Mewtwo & Mew-GX','en','pokemon','test','Test','5',150,NULL,1,1),
    ('mewtwo-darkrai','Mewtwo & Darkrai','en','pokemon','test','Test','6',150,NULL,1,1),
    ('private-mew','Pikachu & Mew','en','pokemon','test','Test','7',25,'other',1,1),
    ('private-fan-mimikyu','Mimikyu ex (Private art)','en','pokemon','test','Test','9',NULL,'other',1,1),
    ('custom-pair','Gengar & Mimikyu-GX (Unofficial fan art)','en','pokemon','test','Test','10',NULL,NULL,1,1),
    ('custom-porygon','Porygon ex','en','pokemon','test','Test','11',NULL,NULL,1,1),
    ('custom-porygon-z','Porygon-Z ex','en','pokemon','test','Test','12',NULL,NULL,1,1),
    ('custom-female','Nidoran♀','en','pokemon','test','Test','13',NULL,NULL,1,1),
    ('custom-male','Nidoran♂','en','pokemon','test','Test','14',NULL,NULL,1,1);
    INSERT INTO catalogue_search(card_id,name,set_name,number,species,rarity,artist)
      SELECT id,name,set_name,number,name,'','' FROM catalogue_cards;`);
  const db = sqliteD1(raw);
  expect(
    (await searchCards(db, 'owner', { limit: 50, offset: 0, pokedexNumber: 778 })).cards
      .map((c) => c.id)
      .sort(),
  ).toEqual(['custom-pair', 'fan-mimikyu', 'gengar-mimikyu', 'mimikyu']);
  expect(
    (await searchCards(db, 'owner', { limit: 50, offset: 0, pokedexNumber: 151 })).cards
      .map((c) => c.id)
      .sort(),
  ).toEqual(['mew', 'mewtwo-mew']);
  expect(
    (await searchCards(db, 'owner', { limit: 50, offset: 0, pokedexNumber: 94 })).cards
      .map((c) => c.id)
      .sort(),
  ).toEqual(['custom-pair', 'gengar-mimikyu']);
  expect(
    (await searchCards(db, 'owner', { limit: 50, offset: 0, pokedexNumber: 137 })).cards.map(
      (c) => c.id,
    ),
  ).toEqual(['custom-porygon']);
  expect(
    (await searchCards(db, 'owner', { limit: 50, offset: 0, pokedexNumber: 29 })).cards.map(
      (c) => c.id,
    ),
  ).toEqual(['custom-female']);
  expect(
    (await searchCards(db, 'owner', { limit: 50, offset: 0, pokedexNumber: 32 })).cards.map(
      (c) => c.id,
    ),
  ).toEqual(['custom-male']);
});
