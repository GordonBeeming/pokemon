import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { cardIdSchema, type BinderPasteRequest } from '@pokedex/shared';
import { applyAllMigrations, sqliteD1 } from './d1-test-helper';
import {
  createBinder,
  getBinderVersion,
  pasteBinderCards,
  previewBinderPaste,
  reserveBinderPage,
  setBinderSlot,
  setBinderEntryAssignment,
} from './binders';
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});
async function setup(capacity = 12) {
  const database = new DatabaseSync(':memory:');
  databases.push(database);
  database.exec('PRAGMA foreign_keys=ON');
  applyAllMigrations(database);
  database.exec(`INSERT INTO users(id,label,created_at) VALUES('owner','Owner',1),('other','Other',1);
    INSERT INTO catalogue_cards(id,name,language,category,set_id,set_name,number,pokedex_number,created_at,updated_at)
    VALUES('a','A','en','pokemon','set','Set','1',1,1,1),('b','B','en','pokemon','set','Set','2',2,1,1),('c','C','en','pokemon','set','Set','3',3,1,1);
    INSERT INTO collection_cards(owner_id,card_id,quantity,revision,updated_at) VALUES('owner','a',1,1,1);`);
  const db = sqliteD1(database);
  const binder = await createBinder(
    db,
    'owner',
    'Paste',
    { kind: '2x2', rows: 2, columns: 2 },
    capacity,
  );
  const request: BinderPasteRequest = {
    at: { page: 0, row: 0, column: 0 },
    cardIds: ['b', 'c'].map((id) => cardIdSchema.parse(id)),
    mode: 'replace',
    expectedRevision: binder.version.revision,
    confirmReplace: false,
  };
  return { db, database, binder, request };
}
it('previews without writing and fills consecutive blanks across pages without shifting neighbours', async () => {
  const { db, binder, request } = await setup();
  let current = await setBinderSlot(
    db,
    'owner',
    binder.version.id,
    1,
    1,
    0,
    'a',
    request.expectedRevision,
  );
  const input = {
    ...request,
    expectedRevision: current.version.revision,
    at: { page: 0, row: 1, column: 1 },
  };
  expect(await previewBinderPaste(db, 'owner', binder.version.id, input)).toMatchObject({
    count: 2,
    replacedTargets: 0,
    unassignedCopies: 0,
    end: { page: 1, row: 0, column: 0 },
  });
  expect((await getBinderVersion(db, 'owner', binder.version.id)).version.revision).toBe(
    current.version.revision,
  );
  current = await pasteBinderCards(db, 'owner', binder.version.id, input);
  const slots = (await getBinderVersion(db, 'owner', binder.version.id, 0, 3)).pages.flatMap(
    (page) => page.slots,
  );
  expect(slots.map((slot) => slot.cardId)).toEqual([
    null,
    null,
    null,
    'b',
    'c',
    null,
    'a',
    null,
    null,
    null,
    null,
    null,
  ]);
  expect(current.version.revision).toBe(input.expectedRevision + 1);
});
it('requires confirmation to replace targets and releases assignments without reducing owned quantities', async () => {
  const { db, database, binder, request } = await setup();
  let result = await setBinderSlot(
    db,
    'owner',
    binder.version.id,
    0,
    0,
    0,
    'a',
    request.expectedRevision,
  );
  result = await setBinderEntryAssignment(
    db,
    'owner',
    binder.version.id,
    request.at,
    'a',
    result.version.revision,
  );
  const input = { ...request, expectedRevision: result.version.revision };
  expect(await previewBinderPaste(db, 'owner', binder.version.id, input)).toMatchObject({
    replacedTargets: 1,
    unassignedCopies: 1,
  });
  await expect(pasteBinderCards(db, 'owner', binder.version.id, input)).rejects.toMatchObject({
    code: 'binder_paste_confirmation_required',
  });
  await pasteBinderCards(db, 'owner', binder.version.id, { ...input, confirmReplace: true });
  const slot = (await getBinderVersion(db, 'owner', binder.version.id)).pages[0]?.slots[0];
  expect(slot).toMatchObject({ cardId: 'b', assignedCardId: null });
  expect(database.prepare("SELECT quantity FROM collection_cards WHERE card_id='a'").get()).toEqual(
    { quantity: 1 },
  );
});
it('inserts at a pocket and shifts existing targets together with physical assignments', async () => {
  const { db, binder, request } = await setup();
  let result = await setBinderSlot(
    db,
    'owner',
    binder.version.id,
    0,
    0,
    0,
    'a',
    request.expectedRevision,
  );
  result = await setBinderEntryAssignment(
    db,
    'owner',
    binder.version.id,
    request.at,
    'a',
    result.version.revision,
  );
  const input = { ...request, mode: 'insert' as const, expectedRevision: result.version.revision };
  expect(await previewBinderPaste(db, 'owner', binder.version.id, input)).toMatchObject({
    shiftedTargets: 1,
    replacedTargets: 0,
  });
  await pasteBinderCards(db, 'owner', binder.version.id, input);
  const slots = (await getBinderVersion(db, 'owner', binder.version.id)).pages[0]?.slots;
  expect(slots?.slice(0, 3).map((slot) => slot.cardId)).toEqual(['b', 'c', 'a']);
  expect(slots?.[2]?.assignedCardId).toBe('a');
});
it('supports reserved pages but never spills a replacement into another section', async () => {
  const { db, binder, request } = await setup();
  const result = await reserveBinderPage(
    db,
    'owner',
    binder.version.id,
    1,
    true,
    'Reserved',
    request.expectedRevision,
  );
  const input = { ...request, expectedRevision: result.version.revision };
  await expect(
    pasteBinderCards(db, 'owner', binder.version.id, {
      ...input,
      at: { page: 0, row: 1, column: 1 },
    }),
  ).rejects.toMatchObject({ code: 'binder_paste_no_space' });
  await expect(
    pasteBinderCards(db, 'owner', binder.version.id, {
      ...input,
      at: { page: 1, row: 1, column: 1 },
    }),
  ).rejects.toMatchObject({ code: 'binder_paste_no_space' });
  await pasteBinderCards(db, 'owner', binder.version.id, {
    ...input,
    at: { page: 1, row: 1, column: 1 },
    cardIds: [cardIdSchema.parse('c')],
  });
  const page = (await getBinderVersion(db, 'owner', binder.version.id, 1)).pages[0];
  expect(page).toMatchObject({ kind: 'reserved', label: 'Reserved' });
  expect(page?.slots[3]?.cardId).toBe('c');
});
it('rejects stale revisions, missing cards, wrong owners and overflow without partial writes', async () => {
  const { db, binder, request } = await setup(4);
  await expect(pasteBinderCards(db, 'other', binder.version.id, request)).rejects.toMatchObject({
    code: 'binder_version_not_found',
  });
  await expect(
    pasteBinderCards(db, 'owner', binder.version.id, { ...request, expectedRevision: 99 }),
  ).rejects.toMatchObject({ code: 'binder_revision_conflict' });
  await expect(
    pasteBinderCards(db, 'owner', binder.version.id, {
      ...request,
      cardIds: [cardIdSchema.parse('missing')],
    }),
  ).rejects.toMatchObject({ code: 'card_not_found' });
  await expect(
    pasteBinderCards(db, 'owner', binder.version.id, {
      ...request,
      mode: 'insert',
      cardIds: Array.from({ length: 5 }, () => cardIdSchema.parse('b')),
    }),
  ).rejects.toMatchObject({ code: 'binder_capacity_exceeded' });
  const unchanged = await getBinderVersion(db, 'owner', binder.version.id);
  expect(unchanged.version.revision).toBe(request.expectedRevision);
  expect(unchanged.pages[0]?.slots.every((slot) => slot.cardId === null)).toBe(true);
});
