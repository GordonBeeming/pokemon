import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { searchCards } from './catalogue';
import { createBinder, insertBinderEntries, placeCard, searchBinderSpaces } from './binders';
import { applyAllMigrations, sqliteD1 } from './d1-test-helper';
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const raw of databases.splice(0)) raw.close();
});
function setup() {
  const raw = new DatabaseSync(':memory:');
  databases.push(raw);
  applyAllMigrations(raw);
  raw.exec(`INSERT INTO users(id,label,created_at) VALUES('owner','Owner',1),('other','Other',1);
 INSERT INTO catalogue_cards(id,name,language,category,set_id,set_name,number,pokedex_number,is_custom,owner_id,created_at,updated_at) VALUES
 ('female','Nidoran♀','en','pokemon','jungle','Jungle','57',29,0,NULL,1,1),
 ('male','Nidoran ♂','en','pokemon','base','Base','55',32,0,NULL,1,1),
 ('legacy-male','Nidoran ♂ (Fan art)','en','pokemon','custom','Custom','1',NULL,1,'owner',1,1),
 ('private-male','Nidoran♂','en','pokemon','private','Private','1',32,1,'other',1,1);
 INSERT INTO catalogue_search(card_id,name,set_name,number,species,rarity,artist) SELECT id,name,set_name,number,name,'','' FROM catalogue_cards;
 INSERT INTO card_sources(provider,source_id,card_id,language,source_updated_at,checksum,active,imported_at)
 SELECT 'tcgdex',id,id,'en',1,'checksum',1,1 FROM catalogue_cards WHERE is_custom=0;`);
  return { raw, db: sqliteD1(raw) };
}
it.each(['Nidoran♂', 'Nidoran ♂', 'Nidoran male', 'Nidoran (Male)'])(
  'keeps male search %s separate from female cards',
  async (query) => {
    const { db } = setup();
    expect(
      (await searchCards(db, 'owner', { query, limit: 100, offset: 0 })).cards
        .map((c) => c.id)
        .sort(),
    ).toEqual(['legacy-male', 'male']);
  },
);
it.each(['Nidoran♀', 'Nidoran ♀', 'Nidoran female', 'Nidoran (Female)'])(
  'keeps female search %s separate from male cards',
  async (query) => {
    const { db } = setup();
    expect(
      (await searchCards(db, 'owner', { query, limit: 100, offset: 0 })).cards.map((c) => c.id),
    ).toEqual(['female']);
  },
);
it('keeps an unspecified Nidoran search inclusive and conflicting species filters empty', async () => {
  const { db } = setup();
  expect((await searchCards(db, 'owner', { query: 'Nidoran', limit: 100, offset: 0 })).total).toBe(
    3,
  );
  expect(
    (
      await searchCards(db, 'owner', {
        query: 'Nidoran♂',
        pokedexNumber: 29,
        limit: 100,
        offset: 0,
      })
    ).cards,
  ).toEqual([]);
});
it('finds the intended binder slot by gender words and refuses the other gender without adding a copy', async () => {
  const { db, raw } = setup();
  const b = await createBinder(db, 'owner', 'National', { kind: '2x2', rows: 2, columns: 2 });
  const v = await insertBinderEntries(
    db,
    'owner',
    b.version.id,
    { page: 0, row: 0, column: 0 },
    [
      { kind: 'pokemon', pokemonNumber: 29, startsNewPage: false },
      { kind: 'pokemon', pokemonNumber: 32, startsNewPage: false },
    ],
    b.version.revision,
  );
  expect(
    (await searchBinderSpaces(db, 'owner', v.version.id, { q: 'Nidoran male' })).matches.map(
      (s) => s.pokemonNumber,
    ),
  ).toEqual([32]);
  expect(
    (await searchBinderSpaces(db, 'owner', v.version.id, { q: 'Nidoran female' })).matches.map(
      (s) => s.pokemonNumber,
    ),
  ).toEqual([29]);
  const page = v.pages[0];
  if (!page) throw Error('Missing page');
  await expect(
    placeCard(
      db,
      'owner',
      'female',
      b.version.binderId,
      `${page.id}:0:1`,
      true,
      v.version.revision,
    ),
  ).rejects.toMatchObject({ code: 'binder_assignment_incompatible' });
  expect(
    raw.prepare('SELECT quantity FROM collection_cards WHERE card_id=?').get('female'),
  ).toBeUndefined();
  const placed = await placeCard(
    db,
    'owner',
    'male',
    b.version.binderId,
    `${page.id}:0:1`,
    true,
    v.version.revision,
  );
  expect(placed.pages[0]?.slots.find((s) => s.column === 1 && s.row === 0)).toMatchObject({
    pokemonNumber: 32,
    assignedCardId: 'male',
  });
});
