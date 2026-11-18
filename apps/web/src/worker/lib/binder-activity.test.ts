import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { binderActivityQuerySchema } from '@pokedex/shared';
import { applyAllMigrations, sqliteD1 } from './d1-test-helper';
import {
  createBinder,
  insertBinderEntries,
  setBinderEntryAssignment,
  setBinderSlot,
  setBinderBookmark,
  getBinderVersion,
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
  const first = (await createBinderCheckpoint(db, 'owner', id)).checkpointId;
  await setBinderSlot(db, 'owner', binder.version.id, 0, 0, 1, 'chikorita', 2, {
    action: 'existing',
  });
  const second = (await createBinderCheckpoint(db, 'owner', id)).checkpointId;
  await createBinderCheckpoint(db, 'owner', id);
  const latest = await read();
  expect(latest.selectedBatch).toBe(first);
  expect(latest.events.map((e) => e.cardId)).toEqual(['chikorita']);
  expect((await read({ batch: second ?? '' })).events).toEqual([]);
  expect((await read({ batch: 'beginning' })).events.map((e) => e.cardId)).toEqual(['squirtle']);
  await expect(read({ batch: 'missing' })).rejects.toMatchObject({ code: 'invalid_filter' });
});
it('filters by bookmark boundaries regardless of a card region, with chronological, binder and Pokédex sorts', async () => {
  const { db, binder, read } = await setup();
  const firstPage = binder.pages[0];
  const secondPage = (await getBinderVersion(db, 'owner', binder.version.id, 0, 2)).pages[1];
  if (!firstPage || !secondPage) throw new Error('Missing pages');
  await setBinderBookmark(db, 'owner', binder.version.id, {
    pageId: firstPage.id,
    row: 0,
    column: 0,
    name: 'Johto',
  });
  await setBinderBookmark(db, 'owner', binder.version.id, {
    pageId: secondPage.id,
    row: 0,
    column: 0,
    name: 'Kanto Art',
  });
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
    (await read({ sort: 'pokedex', sections: JSON.stringify(['Johto', 'Kanto Art']) })).events.map(
      (e) => e.cardId,
    ),
  ).toEqual(['squirtle', 'chikorita', 'treecko']);
  expect(
    (await read({ q: 'Neo', sections: JSON.stringify(['Kanto Art']), kind: 'added' })).events.map(
      (e) => e.cardId,
    ),
  ).toEqual(['chikorita']);
  expect((await read({ sections: JSON.stringify(['Johto']) })).events.map((e) => e.cardId)).toEqual(
    ['treecko', 'squirtle'],
  );
  expect((await read()).sections.map((s) => s.name)).toEqual(['Johto', 'Kanto Art']);
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
  expect((await read({ q: 'Squirtle' })).events).toHaveLength(1);
  await createBinderCheckpoint(db, 'owner', binder.version.binderId);
  expect((await read()).selectedBatch).toBe('beginning');
  expect((await read()).total).toBe(511);
});

it('invalidates in-flight backups when a checkpoint changes', async () => {
  const { database, db, binder } = await setup();
  await setBinderSlot(
    db,
    'owner',
    binder.version.id,
    0,
    0,
    0,
    'squirtle',
    binder.version.revision,
    { action: 'existing' },
  );
  const before = database.prepare("SELECT backup_epoch FROM users WHERE id='owner'").get();
  await createBinderCheckpoint(db, 'owner', binder.version.binderId);
  const after = database.prepare("SELECT backup_epoch FROM users WHERE id='owner'").get();
  expect(after?.backup_epoch).toBe(Number(before?.backup_epoch) + 1);
});

it('does not capture initial or repeated empty checkpoints, including concurrent requests', async () => {
  const { db, database, binder, read } = await setup();
  const id = binder.version.binderId;
  expect(await createBinderCheckpoint(db, 'owner', id)).toEqual({
    checkpointId: null,
    created: false,
  });
  expect(database.prepare('SELECT COUNT(*) AS count FROM binder_checkpoints').get()).toEqual({
    count: 0,
  });
  await setBinderSlot(
    db,
    'owner',
    binder.version.id,
    0,
    0,
    0,
    'squirtle',
    binder.version.revision,
    { action: 'existing' },
  );
  expect((await read()).pendingChanges).toBe(1);
  const results = await Promise.all([
    createBinderCheckpoint(db, 'owner', id),
    createBinderCheckpoint(db, 'owner', id),
  ]);
  expect(results.filter((r) => r.created)).toHaveLength(1);
  expect(results[0]?.checkpointId).toBe(results[1]?.checkpointId);
  expect(database.prepare('SELECT COUNT(*) AS count FROM binder_checkpoints').get()).toEqual({
    count: 1,
  });
  const before = database.prepare("SELECT backup_epoch FROM users WHERE id='owner'").get();
  expect((await createBinderCheckpoint(db, 'owner', id)).created).toBe(false);
  expect(database.prepare("SELECT backup_epoch FROM users WHERE id='owner'").get()).toEqual(before);
  expect((await read()).pendingChanges).toBe(0);
});
it('hides redundant old empty checkpoints without deleting history', async () => {
  const { db, database, binder, read } = await setup();
  const id = binder.version.binderId;
  database.prepare('INSERT INTO binder_checkpoints VALUES(?,?,0,1)').run('empty-a', id);
  database.prepare('INSERT INTO binder_checkpoints VALUES(?,?,0,2)').run('empty-b', id);
  expect((await read()).batches).toEqual([{ id: 'beginning', createdAt: null, count: 0 }]);
  expect((await read({ batch: 'empty-a' })).selectedBatch).toBe('beginning');
  expect(database.prepare('SELECT COUNT(*) AS count FROM binder_checkpoints').get()).toEqual({
    count: 2,
  });
  expect((await createBinderCheckpoint(db, 'owner', id)).created).toBe(false);
});

it('uses exact pocket boundaries and page bookmarks for trainer and energy cards', async () => {
  const { database, db, binder, read } = await setup();
  const pages = (await getBinderVersion(db, 'owner', binder.version.id, 0, 2)).pages;
  const first = pages[0];
  const second = pages[1];
  if (!first || !second) throw new Error('Missing pages');
  await setBinderBookmark(db, 'owner', binder.version.id, {
    pageId: first.id,
    row: 0,
    column: 1,
    name: 'Foils',
  });
  await setBinderBookmark(db, 'owner', binder.version.id, {
    pageId: first.id,
    row: 1,
    column: 0,
    name: 'Cover, trainers',
  });
  database.prepare('UPDATE binder_pages SET label=? WHERE id=?').run('Energy', second.id);
  database.exec(`INSERT INTO catalogue_cards(id,name,language,category,set_id,set_name,number,created_at,updated_at)
 VALUES('trainer','Brock','en','trainer','base','Base','15',1,1),('energy','Grass Energy','en','energy','base','Base','99',1,1);`);
  const event = database.prepare(
    `INSERT INTO binder_activity(binder_id,version_id,version_number,kind,card_id,page,row_index,column_index,created_at) VALUES(?,?,1,'added',?,?,?,?,1)`,
  );
  event.run(binder.version.binderId, binder.version.id, 'squirtle', 0, 0, 0);
  event.run(binder.version.binderId, binder.version.id, 'chikorita', 0, 0, 1);
  event.run(binder.version.binderId, binder.version.id, 'trainer', 0, 1, 0);
  event.run(binder.version.binderId, binder.version.id, 'energy', 1, 0, 0);
  expect((await read({ sections: JSON.stringify(['Foils']) })).events.map((e) => e.cardId)).toEqual(
    ['chikorita'],
  );
  expect(
    (await read({ sections: JSON.stringify(['Cover, trainers', 'Energy']) })).events.map(
      (e) => e.cardId,
    ),
  ).toEqual(['energy', 'trainer']);
  expect((await read()).events.find((e) => e.cardId === 'squirtle')?.sectionName).toBeNull();
  expect((await read()).sections.map((s) => s.name)).toEqual([
    'Foils',
    'Cover, trainers',
    'Energy',
    'Unbookmarked',
  ]);
  expect(
    (await read({ sections: JSON.stringify(['unbookmarked']) })).events.map((e) => e.cardId),
  ).toEqual(['squirtle']);
});

it('uses the current binder bookmarks when a recorded draft version was discarded', async () => {
  const { database, db, binder, read } = await setup();
  const page = binder.pages[0];
  if (!page) throw new Error('Missing page');
  await setBinderBookmark(db, 'owner', binder.version.id, {
    pageId: page.id,
    row: 0,
    column: 0,
    name: 'Trainer covers',
  });
  database
    .prepare(
      `INSERT INTO binder_versions(id,binder_id,version_number,status,layout_kind,rows,columns,revision,capacity,created_at) VALUES('discarded',?,2,'draft','2x2',2,2,1,4,1)`,
    )
    .run(binder.version.binderId);
  database
    .prepare(
      `INSERT INTO binder_activity(binder_id,version_id,version_number,kind,card_id,page,row_index,column_index,created_at) VALUES(?,'discarded',2,'added','squirtle',0,0,0,1)`,
    )
    .run(binder.version.binderId);
  database.prepare("DELETE FROM binder_versions WHERE id='discarded'").run();
  const result = await read({ sections: JSON.stringify(['bookmark:Trainer covers']) });
  expect(result.events.map((e) => e.sectionName)).toEqual(['Trainer covers']);
});

it('filters a long bookmarked history with bounded result pages', async () => {
  const { database, db } = await setup();
  const large = await createBinder(
    db,
    'owner',
    'Large',
    { kind: '3x3', rows: 3, columns: 3 },
    1350,
  );
  const pages = database
    .prepare('SELECT id,position FROM binder_pages WHERE binder_version_id=? ORDER BY position')
    .all(large.version.id);
  const mark = database.prepare(
    'INSERT INTO binder_bookmarks(id,binder_page_id,row_index,column_index,name,created_at) VALUES(?,?,0,0,?,1)',
  );
  database.exec('BEGIN');
  for (let i = 0; i < 100; i++) {
    const page = pages[i];
    if (!page || typeof page.id !== 'string') throw new Error('Missing page');
    mark.run('mark-' + i, page.id, 'Section ' + i);
  }
  const event = database.prepare(
    `INSERT INTO binder_activity(binder_id,version_id,version_number,kind,card_id,page,row_index,column_index,created_at) VALUES(?,?,1,'added','squirtle',?,0,0,1)`,
  );
  let expected = 0;
  for (let i = 0; i < 10000; i++) {
    const page = i % 150;
    event.run(large.version.binderId, large.version.id, page);
    if (page >= 99) expected++;
  }
  database.exec('COMMIT');
  const result = await getBinderActivity(
    db,
    'owner',
    large.version.binderId,
    binderActivityQuerySchema.parse({ sections: JSON.stringify(['bookmark:Section 99']) }),
  );
  expect(result.total).toBe(expected);
  expect(result.events).toHaveLength(500);
  expect(result.sections).toHaveLength(100);
});

it('returns the same standard card metadata and ownership as catalogue resolution', async () => {
  const { database, db, binder, read } = await setup();
  database.exec(`UPDATE catalogue_cards SET types='["Water"]',rarity='Common' WHERE id='squirtle';
    INSERT INTO catalogue_sets(set_id,language,set_name,updated_at,abbreviation,abbreviation_source) VALUES('base','en','Base',1,'BS','tcgdex');
    INSERT INTO card_current_prices(card_id,source,native_amount_micros,native_currency,source_captured_at,fx_date,amount_aud_micros,updated_at) VALUES('squirtle','tcgplayer',2000000,'USD',1,'2026-11-18',3500000,1);`);
  await setBinderSlot(db, 'owner', binder.version.id, 0, 0, 0, 'squirtle');
  await setBinderEntryAssignment(
    db,
    'owner',
    binder.version.id,
    { page: 0, row: 0, column: 0 },
    'squirtle',
    2,
  );
  const activity = await read();
  expect(activity.events[0]).toMatchObject({
    page: 0,
    row: 0,
    column: 0,
    card: {
      id: 'squirtle',
      frameType: 'water',
      setCode: 'BS',
      rarityKey: 'C',
      pokedexNumber: 7,
      collection: { quantity: 5 },
      price: { amountAud: 3.5 },
    },
  });
});

it('resolves more than 200 distinct activity cards without dropping history', async () => {
  const { database, binder, read } = await setup();
  const card = database.prepare(
    `INSERT INTO catalogue_cards(id,name,language,category,set_id,set_name,number,created_at,updated_at) VALUES(?,?,'en','trainer','base','Base',?,1,1)`,
  );
  const event = database.prepare(
    `INSERT INTO binder_activity(binder_id,version_id,version_number,kind,card_id,page,row_index,column_index,created_at) VALUES(?,?,1,'added',?,0,0,0,1)`,
  );
  for (let i = 0; i < 205; i++) {
    card.run(`trainer-${i}`, `Trainer ${i}`, String(i));
    event.run(binder.version.binderId, binder.version.id, `trainer-${i}`);
  }
  const result = await read();
  expect(result.events).toHaveLength(205);
  expect(
    result.events.every((e) => e.card?.id === e.cardId && e.card.frameType === 'trainer'),
  ).toBe(true);
});
