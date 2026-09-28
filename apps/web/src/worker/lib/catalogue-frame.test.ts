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
    INSERT INTO catalogue_sets(set_id,language,set_name,updated_at,abbreviation,abbreviation_source)
    VALUES ('base','en','Base',1,'BS','tcgdex');
    INSERT INTO catalogue_cards
      (id,name,language,category,set_id,set_name,number,types,rarity,created_at,updated_at)
    VALUES
      ('card-1','Bulbasaur','en','pokemon','base','Base','1','["Grass"]','Rare Holo',1,1),
      ('card-2','Professor’s Research','en','trainer','base','Base','2',NULL,'Uncommon',1,1),
      ('card-3','Mystery Card','en','pokemon','base','Base','3',NULL,'Nonsense',1,1);
    INSERT INTO card_sources(provider,source_id,card_id,language,source_updated_at,checksum,active,imported_at)
    VALUES
      ('tcgdex','base-1','card-1','en',1,'checksum',1,1),
      ('tcgdex','base-2','card-2','en',1,'checksum',1,1),
      ('tcgdex','base-3','card-3','en',1,'checksum',1,1);`);
  return sqliteD1(db);
}

describe('catalogue frame metadata', () => {
  it('computes frameType, setCode and rarityKey on search results', async () => {
    const db = setup();
    const page = await searchCards(db, 'owner', { limit: 10, offset: 0 });
    const byId = (id: string) => page.cards.find((card) => card.id === id);
    expect(byId('card-1')).toMatchObject({ frameType: 'grass', setCode: 'BS', rarityKey: 'HV' });
    expect(byId('card-2')).toMatchObject({ frameType: 'trainer', setCode: 'BS', rarityKey: 'U' });
    expect(byId('card-3')).toMatchObject({ frameType: null, setCode: 'BS', rarityKey: null });
  });

  it('computes the same fields on card detail', async () => {
    const db = setup();
    const detail = await getCardDetail(db, 'owner', 'card-1');
    expect(detail).toMatchObject({ frameType: 'grass', setCode: 'BS', rarityKey: 'HV' });
  });

  it('falls back to the set id when the set has no code yet', async () => {
    const db = setup();
    await db
      .prepare(
        `INSERT INTO catalogue_cards
          (id,name,language,category,set_id,set_name,number,rarity,created_at,updated_at)
         VALUES ('card-4','Ancient Mew','en','pokemon','np','Nintendo Promos','1','Promo',1,1)`,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO card_sources(provider,source_id,card_id,language,source_updated_at,checksum,active,imported_at)
         VALUES ('tcgdex','np-1','card-4','en',1,'checksum',1,1)`,
      )
      .run();
    const detail = await getCardDetail(db, 'owner', 'card-4');
    expect(detail).toMatchObject({ setCode: 'NP' });
  });
});
