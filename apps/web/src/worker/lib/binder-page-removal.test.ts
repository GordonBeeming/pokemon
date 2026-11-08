import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { applyAllMigrations, sqliteD1 } from './d1-test-helper';
import {
  createBinder,
  deleteBinderPage,
  fillBinderPage,
  getBinderVersion,
  setBinderEntryAssignment,
  setBinderBookmark,
} from './binders';

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
async function setup(capacity = 25) {
  const raw = new DatabaseSync(':memory:');
  databases.push(raw);
  applyAllMigrations(raw);
  raw.exec(`INSERT INTO users(id,label,created_at) VALUES('owner','Owner',1),('other','Other',1);
    INSERT INTO catalogue_cards(id,name,language,category,set_id,set_name,number,pokedex_number,created_at,updated_at)
      VALUES('pikachu','Pikachu','en','pokemon','m26','McDonalds 2026','1',25,1,1);
    INSERT INTO catalogue_sets(set_id,language,set_name,updated_at) VALUES('m26','en','McDonalds 2026',1);
    INSERT INTO collection_cards(owner_id,card_id,quantity,updated_at) VALUES('owner','pikachu',1,1);`);
  const db = sqliteD1(raw);
  const created = await createBinder(
    db,
    'owner',
    'Removal',
    { kind: '3x3', rows: 3, columns: 3 },
    capacity,
  );
  const filled = await fillBinderPage(
    db,
    'owner',
    created.version.id,
    0,
    { kind: 'set', setId: 'm26', setLanguage: 'en', startsNewPage: false },
    created.version.revision,
    1,
  );
  return { db, raw, versionId: created.version.id, filled };
}

describe('remove pages and placeholders', () => {
  it('clears unfilled placeholders while keeping placed cards, page capacity and later pages', async () => {
    const { db, raw, versionId, filled } = await setup();
    const assigned = await setBinderEntryAssignment(
      db,
      'owner',
      versionId,
      { page: 0, row: 0, column: 0 },
      'pikachu',
      filled.version.revision,
    );
    const before = await getBinderVersion(db, 'owner', versionId, 0, 3);
    const page = before.pages[0];
    if (!page) throw new Error('missing page');
    raw
      .prepare(
        "UPDATE binder_slots SET set_id=NULL,set_language=NULL,label='Hold' WHERE binder_page_id=? AND row_index=0 AND column_index=1",
      )
      .run(page.id);
    const result = await deleteBinderPage(
      db,
      'owner',
      versionId,
      page.id,
      assigned.version.revision,
      'clear-placeholders',
    );
    expect(result.version).toMatchObject({ capacity: 25, pageCount: 3 });
    expect(result.pages[0]?.slots[0]).toMatchObject({
      entryKind: 'set',
      assignedCardId: 'pikachu',
      setId: 'm26',
    });
    expect(
      result.pages[0]?.slots
        .slice(2)
        .every((s) => s.entryKind === 'empty' && !s.setId && !s.assignedCardId),
    ).toBe(true);
    expect(result.pages[0]?.slots[1]).toMatchObject({ entryKind: 'reserved', label: 'Hold' });
    expect((await getBinderVersion(db, 'owner', versionId, 1, 2)).pages).toEqual(
      before.pages.slice(1),
    );
    expect(raw.prepare('SELECT quantity FROM collection_cards').get()).toEqual({ quantity: 1 });
  });

  it('explicitly deletes an occupied page, releasing placements and preserving later page IDs and bookmarks', async () => {
    const { db, raw, versionId, filled } = await setup();
    await setBinderEntryAssignment(
      db,
      'owner',
      versionId,
      { page: 0, row: 0, column: 0 },
      'pikachu',
      filled.version.revision,
    );
    const before = await getBinderVersion(db, 'owner', versionId, 0, 3);
    const later = before.pages[1];
    if (!later) throw new Error('missing later page');
    await setBinderBookmark(db, 'owner', versionId, {
      pageId: later.id,
      row: 0,
      column: 0,
      name: 'Keep',
    });
    const page = before.pages[0];
    if (!page) throw new Error('missing page');
    const result = await deleteBinderPage(
      db,
      'owner',
      versionId,
      page.id,
      before.version.revision,
      'delete-page',
    );
    expect(result.version).toMatchObject({ capacity: 16, pageCount: 2 });
    const after = await getBinderVersion(db, 'owner', versionId, 0, 3);
    expect(after.pages.map((p) => p.id)).toEqual(before.pages.slice(1).map((p) => p.id));
    expect(after.pages.map((p) => p.slots.length)).toEqual([9, 7]);
    expect(
      raw
        .prepare('SELECT COUNT(*) AS n FROM binder_slots WHERE assigned_card_id IS NOT NULL')
        .get(),
    ).toEqual({ n: 0 });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM binder_bookmarks').get()).toEqual({ n: 1 });
    expect(raw.prepare('SELECT quantity FROM collection_cards').get()).toEqual({ quantity: 1 });
  });

  it('keeps the old occupied-page guard unless deletion was explicit, and rejects stale writes', async () => {
    const { db, versionId, filled } = await setup();
    const page = filled.pages[0];
    if (!page) throw new Error('missing page');
    await expect(
      deleteBinderPage(db, 'owner', versionId, page.id, filled.version.revision),
    ).rejects.toBeDefined();
    await expect(
      deleteBinderPage(db, 'owner', versionId, page.id, filled.version.revision - 1, 'delete-page'),
    ).rejects.toMatchObject({ code: 'binder_revision_conflict' });
    await expect(
      deleteBinderPage(db, 'other', versionId, page.id, filled.version.revision, 'delete-page'),
    ).rejects.toMatchObject({ code: 'binder_version_not_found' });
    expect((await getBinderVersion(db, 'owner', versionId, 0, 3)).version).toMatchObject({
      capacity: 25,
      pageCount: 3,
    });
  });

  it('allows clearing placeholders on the last page but never deletes the last page', async () => {
    const { db, versionId, filled } = await setup(9);
    const page = filled.pages[0];
    if (!page) throw new Error('missing page');
    await expect(
      deleteBinderPage(db, 'owner', versionId, page.id, filled.version.revision, 'delete-page'),
    ).rejects.toMatchObject({ code: 'binder_last_page' });
    const result = await deleteBinderPage(
      db,
      'owner',
      versionId,
      page.id,
      filled.version.revision,
      'clear-placeholders',
    );
    expect(result.version).toMatchObject({ capacity: 9, pageCount: 1 });
    expect(result.pages[0]?.slots.every((s) => s.entryKind === 'empty')).toBe(true);
  });
});
