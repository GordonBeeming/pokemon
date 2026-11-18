import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { cardIdSchema, wantedQuerySchema } from '@pokedex/shared';
import { applyAllMigrations, sqliteD1 } from './d1-test-helper';
import { createBinder, insertBinderEntries, setBinderSlot } from './binders';
import { setWanted, wantedScopes, listWanted } from './wanted';
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
async function setup() {
  const database = new DatabaseSync(':memory:');
  databases.push(database);
  database.exec('PRAGMA foreign_keys=ON');
  applyAllMigrations(database);
  database.exec(`INSERT INTO users(id,label,created_at) VALUES('a','A',1),('b','B',1);
 INSERT INTO catalogue_cards(id,name,language,category,set_id,set_name,number,pokedex_number,owner_id,created_at,updated_at) VALUES
 ('squirtle','Squirtle','en','pokemon','base','Base','63',7,NULL,1,1),('chikorita','Chikorita','en','pokemon','neo','Neo','54',152,NULL,1,1),('private','Private','en','pokemon','custom','Custom','1',1,'b',1,1);
 INSERT INTO collection_cards(owner_id,card_id,quantity,revision,updated_at) VALUES('a','squirtle',3,1,1);`);
  const db = sqliteD1(database);
  const binder = await createBinder(db, 'a', 'National', { kind: '2x2', rows: 2, columns: 2 }, 12);
  const other = await createBinder(db, 'b', 'Other', { kind: '2x2', rows: 2, columns: 2 }, 4);
  const list = (query: Record<string, string> = {}) =>
    listWanted(db, 'a', wantedQuerySchema.parse(query));
  return { database, db, binder, other, list };
}
it('keeps explicit general and per-binder wants separate, idempotent and independent of ownership', async () => {
  const { db, binder, list, database } = await setup();
  await setWanted(db, 'a', 'squirtle', null, true);
  await setWanted(db, 'a', 'squirtle', null, true);
  await setWanted(db, 'a', 'squirtle', binder.version.binderId, true);
  expect((await list()).total).toBe(2);
  expect((await list({ scope: 'general' })).entries[0]?.ownedQuantity).toBe(3);
  await setBinderSlot(db, 'a', binder.version.id, 0, 0, 0, 'squirtle', binder.version.revision, {
    action: 'existing',
  });
  expect((await list()).total).toBe(2);
  expect(await wantedScopes(db, 'a', 'squirtle')).toHaveLength(2);
  await setWanted(db, 'a', 'squirtle', null, false);
  expect((await list()).entries[0]?.binderId).toBe(binder.version.binderId);
  database.prepare('DELETE FROM binders WHERE id=?').run(binder.version.binderId);
  expect((await list()).total).toBe(0);
});
it('only includes unfilled targets when requested, groups duplicate pockets, and deduplicates manual binder wants', async () => {
  const { db, binder, list } = await setup();
  await insertBinderEntries(
    db,
    'a',
    binder.version.id,
    { page: 0, row: 0, column: 0 },
    [
      { kind: 'exact-card', cardId: cardIdSchema.parse('squirtle'), startsNewPage: false },
      { kind: 'exact-card', cardId: cardIdSchema.parse('squirtle'), startsNewPage: false },
      { kind: 'pokemon', pokemonNumber: 152, startsNewPage: false },
      { kind: 'reserved', label: 'Divider' },
    ],
    binder.version.revision,
  );
  expect((await list()).total).toBe(0);
  const auto = await list({ scope: binder.version.binderId, includeUnfilled: 'true' });
  expect(auto.total).toBe(2);
  expect(auto.entries.find((e) => e.cardId === 'squirtle')?.unfilled).toBe(2);
  expect(auto.entries.find((e) => e.targetKind === 'pokemon')?.name).toBe('Chikorita');
  await setWanted(db, 'a', 'squirtle', binder.version.binderId, true);
  const combined = await list({ scope: binder.version.binderId, includeUnfilled: 'true' });
  expect(combined.total).toBe(2);
  expect(combined.entries.find((e) => e.cardId === 'squirtle')).toMatchObject({
    manual: true,
    unfilled: 2,
  });
  expect((await list({ scope: 'general', includeUnfilled: 'true' })).total).toBe(0);
});
it('isolates owners, private cards and binders on reads and writes', async () => {
  const { db, other, list } = await setup();
  await setWanted(db, 'b', 'private', null, true);
  await setWanted(db, 'b', 'chikorita', other.version.binderId, true);
  expect((await list()).total).toBe(0);
  await expect(setWanted(db, 'a', 'private', null, true)).rejects.toMatchObject({
    code: 'card_not_found',
  });
  await expect(wantedScopes(db, 'a', 'private')).rejects.toMatchObject({ code: 'card_not_found' });
  await expect(setWanted(db, 'a', 'squirtle', other.version.binderId, true)).rejects.toMatchObject({
    code: 'binder_not_found',
  });
  await expect(list({ scope: other.version.binderId })).rejects.toMatchObject({
    code: 'binder_not_found',
  });
});
it('supports searching, stable sorting and pagination without losing later wants', async () => {
  const { db, binder, list } = await setup();
  await setWanted(db, 'a', 'squirtle', null, true);
  await setWanted(db, 'a', 'chikorita', binder.version.binderId, true);
  expect((await list({ q: 'Neo' })).entries.map((e) => e.cardId)).toEqual(['chikorita']);
  expect((await list({ sort: 'pokedex' })).entries.map((e) => e.cardId)).toEqual([
    'squirtle',
    'chikorita',
  ]);
  expect((await list({ offset: '1' })).entries).toHaveLength(1);
});

it('provides the standard catalogue metadata for wanted printings without assigning or adding copies', async () => {
  const { db, database, binder, list } = await setup();
  database.exec(`UPDATE catalogue_cards SET types='["Water"]',rarity='Common' WHERE id='squirtle';
 INSERT INTO catalogue_sets(set_id,language,set_name,abbreviation,abbreviation_source,updated_at) VALUES('base','en','Base','BS','tcgdex',1);
 INSERT INTO card_current_prices(card_id,source,native_amount_micros,native_currency,source_captured_at,amount_aud_micros,updated_at) VALUES('squirtle','tcgplayer',1000000,'USD',1,1500000,1);`);
  await setWanted(db, 'a', 'squirtle', binder.version.binderId, true);
  const wanted = await list();
  expect(wanted.entries[0]?.card).toMatchObject({
    id: 'squirtle',
    setCode: 'BS',
    frameType: 'water',
    rarityKey: 'C',
    pokedexNumber: 7,
    collection: { quantity: 3 },
    price: { amountAud: 1.5 },
  });
  expect(
    database
      .prepare('SELECT COUNT(*) AS n FROM binder_slots WHERE assigned_card_id IS NOT NULL')
      .get(),
  ).toEqual({ n: 0 });
  expect(
    database
      .prepare("SELECT quantity FROM collection_cards WHERE owner_id='a' AND card_id='squirtle'")
      .get(),
  ).toEqual({ quantity: 3 });
});

it('filters placed wants against their own binder and General wants against any active owned binder', async () => {
  const { db, database, binder, list } = await setup();
  const second = await createBinder(db, 'a', 'Second', { kind: '2x2', rows: 2, columns: 2 }, 4);
  await setWanted(db, 'a', 'squirtle', binder.version.binderId, true);
  await setWanted(db, 'a', 'squirtle', second.version.binderId, true);
  await setWanted(db, 'a', 'squirtle', null, true);
  // Owned copies alone must not count as placements.
  expect((await list({ placement: 'placed' })).total).toBe(0);
  await setBinderSlot(db, 'a', second.version.id, 0, 0, 0, 'squirtle', second.version.revision, {
    action: 'existing',
  });
  const placed = await list({ placement: 'placed' });
  expect(placed.total).toBe(2);
  expect(placed.entries.map((e) => e.scope).sort()).toEqual(
    ['general', second.version.binderId].sort(),
  );
  expect(placed.entries.every((e) => e.placedCount === 1)).toBe(true);
  const unplaced = await list({ placement: 'not-placed' });
  expect(unplaced.total).toBe(1);
  expect(unplaced.entries[0]?.binderId).toBe(binder.version.binderId);
  expect((await list({ scope: binder.version.binderId, placement: 'placed' })).total).toBe(0);
  // Placing never deletes a manual want; the user reviews/removes it on Wanted.
  expect((await list()).total).toBe(3);
  database
    .prepare('UPDATE binders SET active_version_id=NULL WHERE id=?')
    .run(second.version.binderId);
  expect((await list({ placement: 'placed' })).total).toBe(0);
});
