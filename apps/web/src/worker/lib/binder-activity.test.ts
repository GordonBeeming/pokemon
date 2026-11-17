import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { binderActivityQuerySchema } from '@pokedex/shared';
import { applyAllMigrations, sqliteD1 } from './d1-test-helper';
import {
  createBinder,
  insertBinderEntries,
  setBinderEntryAssignment,
  setBinderSlot,
  swapBinderSlots,
} from './binders';
import { createBinderCheckpoint, getBinderActivity } from './binder-activity';
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
async function setup() {
  const database = new DatabaseSync(':memory:');
  databases.push(database);
  database.exec('PRAGMA foreign_keys = ON');
  applyAllMigrations(database);
  database.exec(`INSERT INTO users(id,label,created_at) VALUES ('owner','Owner',1),('other','Other',1);
    INSERT INTO catalogue_cards(id,name,language,category,set_id,set_name,number,pokedex_number,created_at,updated_at) VALUES
    ('squirtle','Squirtle','en','pokemon','base','Base','7',7,1,1),
    ('chikorita','Chikorita','en','pokemon','neo','Neo','152',152,1,1),
    ('treecko','Treecko','en','pokemon','ruby','Ruby','252',252,1,1);
    INSERT INTO collection_cards(owner_id,card_id,quantity,revision,updated_at) VALUES
    ('owner','squirtle',5,1,1),('owner','chikorita',5,1,1),('owner','treecko',5,1,1);`);
  const db = sqliteD1(database);
  const binder = await createBinder(
    db,
    'owner',
    'Activity',
    { kind: '2x2', rows: 2, columns: 2 },
    8,
  );
  const read = (query: Record<string, string> = {}) =>
    getBinderActivity(db, 'owner', binder.version.binderId, binderActivityQuerySchema.parse(query));
  return { database, db, binder, read };
}
it('records placed copies, replacements and removals, ignoring targets and unchanged assignments', async () => {
  const { db, binder, read, database } = await setup();
  await setBinderSlot(db, 'owner', binder.version.id, 0, 0, 0, 'squirtle');
  expect((await read()).total).toBe(0);
  await setBinderEntryAssignment(
    db,
    'owner',
    binder.version.id,
    { page: 0, row: 0, column: 0 },
    'squirtle',
    2,
  );
  await setBinderEntryAssignment(
    db,
    'owner',
    binder.version.id,
    { page: 0, row: 0, column: 0 },
    'squirtle',
    3,
  );
  await setBinderSlot(db, 'owner', binder.version.id, 0, 0, 0, 'chikorita', 4, {
    action: 'existing',
  });
  await setBinderEntryAssignment(
    db,
    'owner',
    binder.version.id,
    { page: 0, row: 0, column: 0 },
    null,
    5,
  );
  expect((await read({ sort: 'oldest' })).events.map((e) => [e.kind, e.cardId])).toEqual([
    ['added', 'squirtle'],
    ['removed', 'squirtle'],
    ['added', 'chikorita'],
    ['removed', 'chikorita'],
  ]);
  expect(database.prepare('SELECT COUNT(*) AS count FROM binder_activity_snapshot').get()).toEqual({
    count: 0,
  });
});
it('uses event boundaries when checkpoints share a timestamp, falls back past empty batches and permits selecting empty batches', async () => {
  const { db, binder, read } = await setup();
  const id = binder.version.binderId;
  await setBinderSlot(db, 'owner', binder.version.id, 0, 0, 0, 'squirtle', 1, {
    action: 'existing',
  });
  const first = await createBinderCheckpoint(db, 'owner', id);
  await setBinderSlot(db, 'owner', binder.version.id, 0, 0, 1, 'chikorita', 2, {
    action: 'existing',
  });
  const second = await createBinderCheckpoint(db, 'owner', id);
  await createBinderCheckpoint(db, 'owner', id);
  const latest = await read();
  expect(latest.selectedBatch).toBe(first);
  expect(latest.events.map((e) => e.cardId)).toEqual(['chikorita']);
  expect((await read({ batch: second })).events).toEqual([]);
  expect((await read({ batch: 'beginning' })).events.map((e) => e.cardId)).toEqual(['squirtle']);
  await expect(read({ batch: 'missing' })).rejects.toMatchObject({ code: 'invalid_filter' });
});
it('filters multiple regions and search before applying the limit, with chronological, binder and Pokédex sorts', async () => {
  const { db, binder, read } = await setup();
  await setBinderSlot(db, 'owner', binder.version.id, 1, 0, 0, 'chikorita', 1, {
    action: 'existing',
  });
  await setBinderSlot(db, 'owner', binder.version.id, 0, 0, 1, 'squirtle', 2, {
    action: 'existing',
  });
  await setBinderSlot(db, 'owner', binder.version.id, 0, 0, 0, 'treecko', 3, {
    action: 'existing',
  });
  expect((await read()).events.map((e) => e.cardId)).toEqual(['treecko', 'squirtle', 'chikorita']);
  expect((await read({ sort: 'oldest' })).events.map((e) => e.cardId)).toEqual([
    'chikorita',
    'squirtle',
    'treecko',
  ]);
  expect((await read({ sort: 'binder' })).events.map((e) => e.cardId)).toEqual([
    'treecko',
    'squirtle',
    'chikorita',
  ]);
  expect(
    (await read({ sort: 'pokedex', regions: 'Kanto,Johto' })).events.map((e) => e.cardId),
  ).toEqual(['squirtle', 'chikorita']);
  expect(
    (await read({ q: 'Neo', regions: 'Johto', kind: 'added' })).events.map((e) => e.cardId),
  ).toEqual(['chikorita']);
  expect((await read({ kind: 'removed' })).total).toBe(0);
});
it('rolls back failed mutations and prevents access across owners or binders', async () => {
  const { db, binder, read, database } = await setup();
  await expect(
    setBinderSlot(db, 'owner', binder.version.id, 0, 0, 0, 'squirtle', 10, { action: 'existing' }),
  ).rejects.toMatchObject({ code: 'binder_revision_conflict' });
  database.exec("UPDATE collection_cards SET quantity = 0 WHERE card_id = 'squirtle'");
  await expect(
    setBinderSlot(db, 'owner', binder.version.id, 0, 0, 0, 'squirtle', 1, { action: 'existing' }),
  ).rejects.toMatchObject({ code: 'binder_assignment_quantity_exceeded' });
  expect((await read()).total).toBe(0);
  expect(database.prepare('SELECT COUNT(*) AS count FROM binder_activity_snapshot').get()).toEqual({
    count: 0,
  });
  await expect(
    getBinderActivity(db, 'other', binder.version.binderId, binderActivityQuerySchema.parse({})),
  ).rejects.toMatchObject({ code: 'binder_not_found' });
  await expect(createBinderCheckpoint(db, 'other', binder.version.binderId)).rejects.toMatchObject({
    code: 'binder_not_found',
  });
});
it('records final pocket changes after swaps and reflows, without intermediate writes', async () => {
  const { db, binder, read } = await setup();
  await setBinderSlot(db, 'owner', binder.version.id, 0, 0, 0, 'squirtle', 1, {
    action: 'existing',
  });
  await swapBinderSlots(
    db,
    'owner',
    binder.version.id,
    { page: 0, row: 0, column: 0 },
    { page: 0, row: 0, column: 1 },
    2,
  );
  const changes = (await read({ sort: 'oldest' })).events;
  expect(changes.map((e) => [e.kind, e.column])).toEqual([
    ['added', 0],
    ['removed', 0],
    ['added', 1],
  ]);
  await insertBinderEntries(
    db,
    'owner',
    binder.version.id,
    { page: 0, row: 0, column: 0 },
    [{ kind: 'reserved', label: 'Divider' }],
    3,
  );
  expect((await read()).events.filter((e) => e.kind === 'added')).toHaveLength(2);
});
it('caps each filtered view at 500 and retains earlier checkpoint history', async () => {
  const { db, binder, read, database } = await setup();
  const insert = database.prepare(
    `INSERT INTO binder_activity(binder_id,version_id,version_number,kind,card_id,page,row_index,column_index,created_at) VALUES (?, ?, 1,'added',?,0,0,0,1)`,
  );
  for (let i = 0; i < 510; i++) insert.run(binder.version.binderId, binder.version.id, 'treecko');
  insert.run(binder.version.binderId, binder.version.id, 'squirtle');
  expect((await read()).events).toHaveLength(500);
  expect((await read()).total).toBe(511);
  expect((await read({ regions: 'Kanto' })).events).toHaveLength(1);
  await createBinderCheckpoint(db, 'owner', binder.version.binderId);
  expect((await read()).selectedBatch).toBe('beginning');
  expect((await read()).total).toBe(511);
});

it('invalidates in-flight backups when a checkpoint changes', async () => {
  const { database, db, binder } = await setup();
  const before = database.prepare("SELECT backup_epoch FROM users WHERE id='owner'").get();
  await createBinderCheckpoint(db, 'owner', binder.version.binderId);
  const after = database.prepare("SELECT backup_epoch FROM users WHERE id='owner'").get();
  expect(after?.backup_epoch).toBe(Number(before?.backup_epoch) + 1);
});
