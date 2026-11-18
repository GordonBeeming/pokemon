import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { TRAINER_CHARACTERS, normalizedTrainerName } from '@pokedex/shared';
import { applyAllMigrations, sqliteD1 } from './d1-test-helper';
import { listTrainerDex } from './trainer-dex';
import { searchCards } from './catalogue';
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function setup() {
  const raw = new DatabaseSync(':memory:');
  databases.push(raw);
  applyAllMigrations(raw);
  raw.exec(`
 INSERT INTO users(id,label,created_at) VALUES('a','A',1),('b','B',1);
 INSERT INTO catalogue_cards(id,name,language,category,set_id,set_name,number,is_active,owner_id,created_at,updated_at) VALUES
 ('brock','Brock','en','trainer','base','Base','15',1,NULL,1,1),('grit','Brock’s Grit','en','trainer','evo','Evolutions','74',1,NULL,1,1),
 ('vulpix','Brock''s Vulpix','en','pokemon','gym','Gym','1',1,NULL,1,1),('private','Brock','en','trainer','custom','Custom','1',1,'b',1,1),
 ('tag','Red & Blue','en','trainer','cosmic','Cosmic','1',1,NULL,1,1),('n','N','en','trainer','nv','Noble','1',1,NULL,1,1),
 ('nest','Nest Ball','en','trainer','base','Base','2',1,NULL,1,1),('sada','Professor''s Research','en','trainer','sv01','Scarlet','189',1,NULL,1,1),
 ('turo','Professor''s Research','en','trainer','sv01','Violet','190',1,NULL,1,1),('cyrus','Boss''s Orders','en','trainer','swsh9','Brilliant','132',1,NULL,1,1);
 INSERT INTO card_sources(provider,source_id,card_id,language,source_updated_at,checksum,active,imported_at) VALUES
 ('tcgdex','sv01-189','sada','en',1,'a',1,1),('tcgdex','sv01-190','turo','en',1,'b',1,1),('tcgdex','swsh9-132','cyrus','en',1,'c',1,1);
 INSERT INTO collection_cards(owner_id,card_id,quantity,revision,updated_at) VALUES('a','grit',1,1,1);`);
  return { raw, db: sqliteD1(raw) };
}
it('covers unique characters and regions with explicit alternate-title identities', () => {
  expect(new Set(TRAINER_CHARACTERS.map((t) => t.key)).size).toBe(TRAINER_CHARACTERS.length);
  expect(TRAINER_CHARACTERS.find((t) => t.key === 'brock')?.regions).toContain('Kanto');
  expect(TRAINER_CHARACTERS.find((t) => t.key === 'cynthia')?.regions).toContain('Sinnoh');
  expect(TRAINER_CHARACTERS.find((t) => t.key === 'irida')?.regions).toContain('Hisui');
  expect(normalizedTrainerName('Lt. Surge’s Strategy')).toBe("lt surge's strategy");
});
it('counts trainer printings and excludes their Pokemon, private cards and unrelated short-name matches', async () => {
  const { db } = setup();
  const { trainers } = await listTrainerDex(db, 'a');
  const brock = trainers.find((t) => t.key === 'brock');
  expect(brock).toMatchObject({ cardCount: 2, ownedCount: 1, representative: { id: 'grit' } });
  expect(trainers.find((t) => t.key === 'red')?.cardCount).toBe(1);
  expect(trainers.find((t) => t.key === 'blue')?.cardCount).toBe(1);
  expect(trainers.find((t) => t.key === 'n')?.cardCount).toBe(1);
});
it('opens exactly the same variants in Catalogue, including generic professor and boss titles', async () => {
  const { db } = setup();
  for (const [key, expected] of [
    ['brock', ['brock', 'grit']],
    ['red', ['tag']],
    ['blue', ['tag']],
    ['professorsada', ['sada']],
    ['professorturo', ['turo']],
    ['cyrus', ['cyrus']],
  ] as const) {
    const result = await searchCards(db, 'a', {
      character: key,
      language: 'en',
      limit: 100,
      offset: 0,
    });
    expect(result.cards.map((c) => c.id).sort()).toEqual([...expected].sort());
  }
  await expect(
    searchCards(db, 'a', { character: 'not-a-character', limit: 100, offset: 0 }),
  ).rejects.toMatchObject({ code: 'invalid_filter' });
});

it('matches the directory counts for every character and both people on a TAG TEAM', async () => {
  const { raw, db } = setup();
  raw.exec(`INSERT INTO catalogue_cards(id,name,language,category,set_id,set_name,number,created_at,updated_at) VALUES
 ('duo','Jessie & James','en','trainer','hidden','Hidden Fates','1',1,1),('foreign-language','Brock','fr','trainer','gym','Gym','15',1,1);`);
  const dex = await listTrainerDex(db, 'a');
  for (const trainer of dex.trainers) {
    const gallery = await searchCards(db, 'a', { character: trainer.key, limit: 100, offset: 0 });
    expect(gallery.total).toBe(trainer.cardCount);
  }
  expect(dex.trainers.find((t) => t.key === 'jessie')?.cardCount).toBe(1);
  expect(dex.trainers.find((t) => t.key === 'james')?.cardCount).toBe(1);
  expect((await listTrainerDex(db, 'b')).trainers.find((t) => t.key === 'brock')?.cardCount).toBe(
    3,
  );
});
