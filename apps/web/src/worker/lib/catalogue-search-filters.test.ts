import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { searchCards, type CatalogueFilters } from './catalogue';
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
    INSERT INTO catalogue_sets(set_id,language,set_name,updated_at) VALUES
      ('set-a','en','Set A',1),('set-b','en','Set B',1);
    INSERT INTO catalogue_cards
      (id,name,language,category,set_id,set_name,number,types,subtype,rarity,artist,pokedex_number,is_active,created_at,updated_at)
    VALUES
      ('grass-mon','Bulbasaur','en','pokemon','set-a','Set A','1','["Grass"]',NULL,'Common','Ken Sugimori',1,1,1,1),
      ('fire-mon','Charmander','en','pokemon','set-b','Set B','2','["Fire"]',NULL,'Rare','Ken Sugimori',4,1,1,1),
      ('kanto-other','Squirtle','en','pokemon','set-a','Set A','3',NULL,NULL,'Common','Mitsuhiro Arita',7,1,1,1),
      ('johto-mon','Chikorita','en','pokemon','set-a','Set A','4',NULL,NULL,'Common',NULL,152,1,1,1),
      ('trainer-card','Bill','en','trainer','set-a','Set A','5',NULL,NULL,'Uncommon',NULL,NULL,1,1,1),
      ('basic-energy-typed','Water Energy','en','energy','set-a','Set A','6','["Water"]','Normal','None',NULL,NULL,1,1,1),
      ('basic-energy-named','Fire Energy','en','energy','set-b','Set B','7',NULL,'Normal','None',NULL,NULL,1,1,1),
      ('special-energy','Rainbow Energy','en','energy','set-a','Set A','8',NULL,'Special','Rare',NULL,NULL,1,1,1),
      ('inactive-grass','Hidden Grass Mon','en','pokemon','set-a','Set A','9','["Grass"]',NULL,'Common','Ken Sugimori',3,0,1,1);
    INSERT INTO card_sources(provider,source_id,card_id,language,source_updated_at,checksum,active,imported_at)
    SELECT 'tcgdex', id, id, 'en', 1, 'checksum', 1, 1 FROM catalogue_cards;`);
  return sqliteD1(db);
}

async function ids(
  db: D1Database,
  filters: Omit<CatalogueFilters, 'limit' | 'offset'>,
): Promise<string[]> {
  const page = await searchCards(db, 'owner', { ...filters, limit: 50, offset: 0 });
  return page.cards.map((card) => card.id).sort();
}

describe('catalogue search filters', () => {
  it('filters by frame type, matching pokemon via the types column', async () => {
    const db = setup();
    expect(await ids(db, { frameTypes: ['grass'] })).toEqual(['grass-mon']);
  });

  it('filters by frame type across multiple requested types (OR)', async () => {
    const db = setup();
    // basic-energy-named ("Fire Energy", no types column) legitimately frames as
    // fire via the name-parsing fallback, so it belongs in the fire/grass union too.
    expect(await ids(db, { frameTypes: ['grass', 'fire'] })).toEqual([
      'basic-energy-named',
      'fire-mon',
      'grass-mon',
    ]);
  });

  it('matches trainer cards for the trainer frame type', async () => {
    const db = setup();
    expect(await ids(db, { frameTypes: ['trainer'] })).toEqual(['trainer-card']);
  });

  it('matches basic energy via the types column and via name parsing', async () => {
    const db = setup();
    expect(await ids(db, { frameTypes: ['water'] })).toEqual(['basic-energy-typed']);
    expect(await ids(db, { frameTypes: ['fire'] })).toEqual(['basic-energy-named', 'fire-mon']);
  });

  it('matches special energy cards regardless of type', async () => {
    const db = setup();
    expect(await ids(db, { frameTypes: ['special-energy'] })).toEqual(['special-energy']);
  });

  it('never returns an inactive (Pocket) card for a frame type filter', async () => {
    const db = setup();
    expect(await ids(db, { frameTypes: ['grass'] })).not.toContain('inactive-grass');
  });

  it('filters by rarity key across its raw aliases', async () => {
    const db = setup();
    expect(await ids(db, { rarityKeys: ['C'] })).toEqual(['grass-mon', 'johto-mon', 'kanto-other']);
  });

  it('filters by region using the National Pokedex range', async () => {
    const db = setup();
    expect(await ids(db, { region: 'Kanto' })).toEqual(['fire-mon', 'grass-mon', 'kanto-other']);
    expect(await ids(db, { region: 'Johto' })).toEqual(['johto-mon']);
  });

  it('filters by a repeatable set list', async () => {
    const db = setup();
    expect(await ids(db, { setIds: ['set-b'] })).toEqual(['basic-energy-named', 'fire-mon']);
  });

  it('filters by an exact artist match, never a partial one', async () => {
    const db = setup();
    expect(await ids(db, { artist: 'Ken Sugimori' })).toEqual(['fire-mon', 'grass-mon']);
    expect(await ids(db, { artist: 'Ken' })).toEqual([]);
  });

  it('narrows by printed card number alongside other filters, ignoring leading zeros', async () => {
    const db = setup();
    expect(await ids(db, { setIds: ['set-a'], cardNumber: '003' })).toEqual(['kanto-other']);
    expect(await ids(db, { setIds: ['set-a'], cardNumber: '#3' })).toEqual(['kanto-other']);
    expect(await ids(db, { setIds: ['set-b'], cardNumber: '3' })).toEqual([]);
    expect(await ids(db, { cardNumber: '2' })).toEqual(['fire-mon']);
  });

  it('combines frame type and rarity filters', async () => {
    const db = setup();
    expect(await ids(db, { frameTypes: ['grass'], rarityKeys: ['C'] })).toEqual(['grass-mon']);
    expect(await ids(db, { frameTypes: ['grass'], rarityKeys: ['R'] })).toEqual([]);
  });
});
