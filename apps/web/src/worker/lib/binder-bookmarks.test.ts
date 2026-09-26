import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { applyAllMigrations, sqliteD1 } from './d1-test-helper';
import {
  createBinder,
  getBinderBookmarks,
  setBinderBookmark,
  removeBinderBookmark,
  reserveBinderPage,
  reorderBinderPages,
  resizeBinderCapacity,
  deleteBinderPage,
  cloneBinderVersion,
  getBinderVersion,
} from './binders';
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
async function setup(capacity = 8) {
  const database = new DatabaseSync(':memory:');
  databases.push(database);
  database.exec('PRAGMA foreign_keys = ON');
  applyAllMigrations(database);
  database.exec(
    "INSERT INTO users (id,label,created_at) VALUES ('owner','Owner',1),('other','Other',1)",
  );
  const db = sqliteD1(database);
  const binder = await createBinder(
    db,
    'owner',
    'Bookmarks',
    { kind: '2x2', rows: 2, columns: 2 },
    capacity,
  );
  return { database, db, binder };
}
describe('binder bookmarks', () => {
  it('upserts and deletes annotations without changing revision, including archived versions', async () => {
    const { database, db, binder } = await setup();
    database
      .prepare("UPDATE binder_versions SET status='archived' WHERE id=?")
      .run(binder.version.id);
    const input = { pageId: binder.pages[0]!.id, row: 0, column: 0, name: 'Bulbasaur' };
    const first = await setBinderBookmark(db, 'owner', binder.version.id, input);
    const renamed = await setBinderBookmark(db, 'owner', binder.version.id, {
      ...input,
      name: 'Kanto',
    });
    expect(renamed.id).toBe(first.id);
    expect(await getBinderBookmarks(db, 'owner', binder.version.id)).toEqual([
      { ...first, name: 'Kanto' },
    ]);
    expect((await getBinderVersion(db, 'owner', binder.version.id)).version.revision).toBe(
      binder.version.revision,
    );
    await removeBinderBookmark(db, 'owner', binder.version.id, first.id);
    await removeBinderBookmark(db, 'owner', binder.version.id, first.id);
    expect(await getBinderBookmarks(db, 'owner', binder.version.id)).toEqual([]);
  });
  it('generates reserved page bookmarks and renames labels without reflowing slots', async () => {
    const { database, db, binder } = await setup();
    const reserved = await reserveBinderPage(
      db,
      'owner',
      binder.version.id,
      0,
      true,
      'Kanto Art',
      binder.version.revision,
    );
    const before = database
      .prepare('SELECT * FROM binder_slots ORDER BY binder_page_id,row_index,column_index')
      .all();
    await reserveBinderPage(
      db,
      'owner',
      binder.version.id,
      0,
      true,
      'Johto Art',
      reserved.version.revision,
    );
    expect(
      database
        .prepare('SELECT * FROM binder_slots ORDER BY binder_page_id,row_index,column_index')
        .all(),
    ).toEqual(before);
    const marks = await getBinderBookmarks(db, 'owner', binder.version.id);
    expect(marks).toEqual([
      expect.objectContaining({
        kind: 'reserved-page',
        name: 'Johto Art',
        at: { page: 0, row: 0, column: 0 },
      }),
    ]);
    await expect(
      removeBinderBookmark(db, 'owner', binder.version.id, marks[0]!.id),
    ).rejects.toMatchObject({ code: 'binder_bookmark_reserved_page' });
  });
  it('uses only the automatic bookmark while a page is reserved', async () => {
    const { db, binder } = await setup();
    const input = { pageId: binder.pages[0]!.id, row: 0, column: 0, name: 'Pocket' };
    await setBinderBookmark(db, 'owner', binder.version.id, input);
    const reserved = await reserveBinderPage(
      db,
      'owner',
      binder.version.id,
      0,
      true,
      'Art',
      binder.version.revision,
    );
    await expect(setBinderBookmark(db, 'owner', binder.version.id, input)).rejects.toMatchObject({
      code: 'binder_bookmark_reserved_page',
    });
    expect(
      (await getBinderBookmarks(db, 'owner', binder.version.id)).map((mark) => mark.kind),
    ).toEqual(['reserved-page']);
    await reserveBinderPage(
      db,
      'owner',
      binder.version.id,
      0,
      false,
      null,
      reserved.version.revision,
    );
    expect(
      (await getBinderBookmarks(db, 'owner', binder.version.id)).map((mark) => mark.name),
    ).toEqual(['Pocket']);
  });

  it.each(['reserve', 'trim'] as const)(
    'rejects a concurrent %s without a generic SQL error',
    async (change) => {
      const { database, db, binder } = await setup();
      const pageId = binder.pages[0]!.id;
      const racingDb = {
        ...db,
        prepare(query: string) {
          const statement = db.prepare(query);
          if (!query.startsWith('SELECT id, position, kind FROM binder_pages')) return statement;
          return {
            bind(...values: unknown[]) {
              const bound = statement.bind(...values);
              return {
                async first<T>() {
                  const row = await bound.first<T>();
                  if (change === 'reserve')
                    database
                      .prepare("UPDATE binder_pages SET kind='reserved' WHERE id=?")
                      .run(pageId);
                  else
                    database
                      .prepare(
                        'DELETE FROM binder_slots WHERE binder_page_id=? AND row_index=0 AND column_index=0',
                      )
                      .run(pageId);
                  return row;
                },
              } as D1PreparedStatement;
            },
          } as D1PreparedStatement;
        },
      } as D1Database;
      await expect(
        setBinderBookmark(racingDb, 'owner', binder.version.id, {
          pageId,
          row: 0,
          column: 0,
          name: 'Racing',
        }),
      ).rejects.toMatchObject({
        code: change === 'reserve' ? 'binder_bookmark_reserved_page' : 'binder_slot_not_found',
      });
      expect(database.prepare('SELECT COUNT(*) AS count FROM binder_bookmarks').get()).toEqual({
        count: 0,
      });
    },
  );

  it('keeps pocket anchors on reordered pages and clones them to new page identities', async () => {
    const { db, binder } = await setup();
    const pages = (await getBinderVersion(db, 'owner', binder.version.id, 0, 2)).pages;
    await setBinderBookmark(db, 'owner', binder.version.id, {
      pageId: pages[0]!.id,
      row: 1,
      column: 1,
      name: 'Start',
    });
    const moved = await reorderBinderPages(
      db,
      'owner',
      binder.version.id,
      [pages[1]!.id, pages[0]!.id],
      binder.version.revision,
    );
    const marks = await getBinderBookmarks(db, 'owner', binder.version.id);
    expect(marks[0]?.at).toEqual({ page: 1, row: 1, column: 1 });
    const clone = await cloneBinderVersion(db, 'owner', binder.version.id, moved.version.revision);
    const copied = await getBinderBookmarks(db, 'owner', clone.version.id);
    expect(copied[0]).toMatchObject({ name: 'Start', at: { page: 1, row: 1, column: 1 } });
    expect(copied[0]?.id).not.toBe(marks[0]?.id);
    expect(copied[0]?.pageId).not.toBe(marks[0]?.pageId);
  });
  it('removes bookmarks when their pocket is trimmed or page deleted', async () => {
    const { db, binder } = await setup();
    const pages = (await getBinderVersion(db, 'owner', binder.version.id, 0, 2)).pages;
    await setBinderBookmark(db, 'owner', binder.version.id, {
      pageId: pages[1]!.id,
      row: 1,
      column: 1,
      name: 'Trim',
    });
    await setBinderBookmark(db, 'owner', binder.version.id, {
      pageId: pages[1]!.id,
      row: 0,
      column: 0,
      name: 'Page',
    });
    const resized = await resizeBinderCapacity(
      db,
      'owner',
      binder.version.id,
      5,
      binder.version.revision,
    );
    expect((await getBinderBookmarks(db, 'owner', binder.version.id)).map((x) => x.name)).toEqual([
      'Page',
    ]);
    await expect(
      setBinderBookmark(db, 'owner', binder.version.id, {
        pageId: pages[1]!.id,
        row: 1,
        column: 1,
        name: 'Outside',
      }),
    ).rejects.toMatchObject({ code: 'binder_slot_out_of_bounds' });
    await deleteBinderPage(db, 'owner', binder.version.id, pages[1]!.id, resized.version.revision);
    expect(await getBinderBookmarks(db, 'owner', binder.version.id)).toEqual([]);
  });
  it('rejects other owners and page IDs from another version', async () => {
    const { db, binder } = await setup();
    const input = { pageId: binder.pages[0]!.id, row: 0, column: 0, name: 'Private' };
    await expect(setBinderBookmark(db, 'other', binder.version.id, input)).rejects.toMatchObject({
      code: 'binder_version_not_found',
    });
    await expect(getBinderBookmarks(db, 'other', binder.version.id)).rejects.toMatchObject({
      code: 'binder_version_not_found',
    });
    const other = await createBinder(db, 'owner', 'Other', { kind: '2x2', rows: 2, columns: 2 }, 4);
    await expect(setBinderBookmark(db, 'owner', other.version.id, input)).rejects.toMatchObject({
      code: 'binder_page_not_found',
    });
  });
  it('lists a 118-page binder without one SQL binding per page', async () => {
    const { db, binder } = await setup(472);
    const last = (await getBinderVersion(db, 'owner', binder.version.id, 117, 1)).pages[0]!;
    await setBinderBookmark(db, 'owner', binder.version.id, {
      pageId: last.id,
      row: 1,
      column: 1,
      name: 'Last',
    });
    expect(await getBinderBookmarks(db, 'owner', binder.version.id)).toEqual([
      expect.objectContaining({ name: 'Last', at: { page: 117, row: 1, column: 1 } }),
    ]);
  });
});
