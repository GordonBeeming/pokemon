import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { cardIdSchema } from '@pokedex/shared';
import { applyAllMigrations, sqliteD1 } from './d1-test-helper';
import {
  createBinder,
  reserveBinderPage,
  insertBinderEntries,
  getBinderVersion,
  swapBinderSlots,
  setBinderEntryAssignment,
  getBinderAssignmentCandidates,
  arrangeBinderVersion,
  searchBinderSpaces,
  getBinderPlannerSummary,
  getBinderBookmarks,
  setBinderBookmark,
  compactRemoveBinderEntry,
  moveBinderEntryByOffset,
  setBinderSlot,
  resizeBinderCapacity,
} from './binders';

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});
async function setup() {
  const database = new DatabaseSync(':memory:');
  databases.push(database);
  database.exec('PRAGMA foreign_keys=ON');
  applyAllMigrations(database);
  database.exec(`
    INSERT INTO users(id,label,created_at) VALUES('owner','Owner',1),('other','Other',1);
    INSERT INTO catalogue_cards(id,name,language,category,set_id,set_name,number,pokedex_number,created_at,updated_at)
      VALUES('victini','Victini','en','pokemon','set','Set','1',494,1,1),('bulba','Bulbasaur','en','pokemon','set','Set','2',1,1,1);
    INSERT INTO collection_cards(owner_id,card_id,quantity,notes,revision,updated_at)
      VALUES('owner','victini',1,NULL,1,1),('owner','bulba',1,NULL,1,1);
  `);
  const db = sqliteD1(database);
  const created = await createBinder(
    db,
    'owner',
    'Manual pages',
    { kind: '3x3', rows: 3, columns: 3 },
    27,
  );
  const id = created.version.id;
  let result = await reserveBinderPage(db, 'owner', id, 1, true, 'Unova', created.version.revision);
  result = await insertBinderEntries(
    db,
    'owner',
    id,
    { page: 0, row: 0, column: 0 },
    [{ kind: 'pokemon', pokemonNumber: 494, startsNewPage: true }],
    result.version.revision,
  );
  result = await insertBinderEntries(
    db,
    'owner',
    id,
    { page: 2, row: 0, column: 0 },
    [{ kind: 'exact-card', cardId: cardIdSchema.parse('bulba'), startsNewPage: false }],
    result.version.revision,
  );
  const state = () => getBinderVersion(db, 'owner', id, 0, 3);
  return { database, db, id, revision: result.version.revision, state };
}
const source = { page: 0, row: 0, column: 0 };
const last = { page: 1, row: 2, column: 2 };

describe('manual reserved-page placement', () => {
  it('places Victini in the last reserved pocket, assigns a copy, and preserves it during automatic layout', async () => {
    const { db, id, revision, state } = await setup();
    let result = await swapBinderSlots(db, 'owner', id, source, last, revision);
    let pages = (await state()).pages;
    expect(pages[0]?.slots[0]?.entryKind).toBe('empty');
    expect(pages[1]).toMatchObject({ kind: 'reserved', label: 'Unova' });
    expect(pages[1]?.slots[8]).toMatchObject({
      entryKind: 'pokemon',
      pokemonNumber: 494,
      startsNewPage: true,
    });
    expect(
      (await getBinderAssignmentCandidates(db, 'owner', id, last)).candidates.map(
        (card) => card.cardId,
      ),
    ).toContain('victini');
    result = await setBinderEntryAssignment(
      db,
      'owner',
      id,
      last,
      'victini',
      result.version.revision,
    );
    result = await arrangeBinderVersion(db, 'owner', id, 'pokedex-number', result.version.revision);
    result = await insertBinderEntries(
      db,
      'owner',
      id,
      source,
      [{ kind: 'pokemon', pokemonNumber: 494, startsNewPage: false }],
      result.version.revision,
    );
    await expect(
      setBinderEntryAssignment(db, 'owner', id, source, 'victini', result.version.revision),
    ).rejects.toMatchObject({ code: 'binder_assignment_quantity_exceeded' });
    result = await reserveBinderPage(
      db,
      'owner',
      id,
      1,
      true,
      'Unova specials',
      result.version.revision,
    );
    pages = (await state()).pages;
    expect(pages[1]).toMatchObject({ kind: 'reserved', label: 'Unova specials' });
    expect(pages[1]?.slots[8]).toMatchObject({
      entryKind: 'pokemon',
      pokemonNumber: 494,
      assignedCardId: 'victini',
      startsNewPage: true,
    });
    expect(await getBinderPlannerSummary(db, 'owner', id)).toMatchObject({
      targets: 3,
      placed: 1,
      available: 16,
    });
    expect((await searchBinderSpaces(db, 'owner', id, { q: 'Victini' })).matches).toContainEqual(
      expect.objectContaining({ ...last, placed: true }),
    );
    const reserved = pages[1];
    if (!reserved) throw new Error('Missing reserved page');
    await setBinderBookmark(db, 'owner', id, {
      pageId: reserved.id,
      row: 2,
      column: 2,
      name: 'Victini',
    });
    expect((await getBinderBookmarks(db, 'owner', id)).map((mark) => mark.name)).toEqual([
      'Unova specials',
      'Victini',
    ]);
    await expect(
      swapBinderSlots(db, 'other', id, source, last, result.version.revision),
    ).rejects.toMatchObject({ code: 'binder_version_not_found' });
    await expect(swapBinderSlots(db, 'owner', id, source, last, revision)).rejects.toMatchObject({
      code: 'binder_revision_conflict',
    });
  });

  it('bounds insert, close-gap, and offset moves to the reserved page and rolls back overflow', async () => {
    const { db, id, revision, state } = await setup();
    let result = await swapBinderSlots(db, 'owner', id, source, last, revision);
    const first = { page: 1, row: 0, column: 0 };
    result = await insertBinderEntries(
      db,
      'owner',
      id,
      first,
      [{ kind: 'pokemon', pokemonNumber: 1, startsNewPage: false }],
      result.version.revision,
    );
    expect((await state()).pages[1]?.slots[8]?.pokemonNumber).toBe(494);
    result = await compactRemoveBinderEntry(db, 'owner', id, first, result.version.revision);
    expect((await state()).pages[1]?.slots[7]?.pokemonNumber).toBe(494);
    result = await moveBinderEntryByOffset(
      db,
      'owner',
      id,
      { page: 1, row: 2, column: 1 },
      1,
      result.version.revision,
    );
    expect(result.anchor).toEqual(last);
    const before = await state();
    await expect(
      moveBinderEntryByOffset(db, 'owner', id, last, 1, result.version.revision),
    ).rejects.toMatchObject({ code: 'reserved_page_full' });
    await expect(
      insertBinderEntries(
        db,
        'owner',
        id,
        last,
        [{ kind: 'pokemon', pokemonNumber: 2, startsNewPage: false }],
        result.version.revision,
      ),
    ).rejects.toMatchObject({ code: 'reserved_page_full' });
    expect(await state()).toEqual(before);
    expect(before.pages[1]?.slots[8]).toMatchObject({ pokemonNumber: 494, startsNewPage: true });
  });

  it('swaps complete physical-copy payloads back out and keeps ownership quantities intact', async () => {
    const { db, id, revision, state } = await setup();
    let result = await setBinderEntryAssignment(db, 'owner', id, source, 'victini', revision);
    result = await setBinderSlot(db, 'owner', id, 1, 2, 2, 'bulba', result.version.revision, {
      action: 'existing',
    });
    result = await swapBinderSlots(db, 'owner', id, source, last, result.version.revision);
    expect((await state()).pages[0]?.slots[0]).toMatchObject({
      cardId: 'bulba',
      assignedCardId: 'bulba',
      entryKind: 'exact-card',
    });
    expect((await state()).pages[1]?.slots[8]).toMatchObject({
      pokemonNumber: 494,
      assignedCardId: 'victini',
      entryKind: 'pokemon',
      startsNewPage: true,
    });
    await swapBinderSlots(
      db,
      'owner',
      id,
      last,
      { page: 0, row: 0, column: 1 },
      result.version.revision,
    );
    expect((await state()).pages[0]?.slots[1]).toMatchObject({
      pokemonNumber: 494,
      assignedCardId: 'victini',
    });
    expect((await state()).pages[1]?.slots[8]?.entryKind).toBe('empty');
  });

  it('respects the physical limit on a partial reserved final page', async () => {
    const { db, id, revision } = await setup();
    let result = await setBinderSlot(db, 'owner', id, 2, 0, 0, null, revision);
    result = await resizeBinderCapacity(db, 'owner', id, 20, result.version.revision);
    result = await reserveBinderPage(db, 'owner', id, 2, true, 'Partial', result.version.revision);
    await expect(
      swapBinderSlots(
        db,
        'owner',
        id,
        source,
        { page: 2, row: 0, column: 2 },
        result.version.revision,
      ),
    ).rejects.toMatchObject({ code: 'binder_slot_out_of_bounds' });
    await swapBinderSlots(
      db,
      'owner',
      id,
      source,
      { page: 2, row: 0, column: 1 },
      result.version.revision,
    );
    expect((await getBinderVersion(db, 'owner', id, 2, 1)).pages[0]?.slots[1]?.pokemonNumber).toBe(
      494,
    );
  });
});
