import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cloneBinderVersion,
  createBinder,
  discardBinderDraftVersion,
  setBinderBookmark,
} from './binders';
import { applyAllMigrations, sqliteD1 } from './d1-test-helper';

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function setup(): D1Database {
  const raw = new DatabaseSync(':memory:');
  databases.push(raw);
  raw.exec('PRAGMA foreign_keys = ON');
  applyAllMigrations(raw);
  raw.exec("INSERT INTO users(id,label,created_at) VALUES('owner','Owner',1),('other','Other',1);");
  return sqliteD1(raw);
}

// The other half of clone -> edit -> activate/discard (ws-screens-b's draft
// workflow): a clone is a real draft version with its own pages/slots, so
// discarding it must delete that whole tree via the same FK cascade
// deleteBinder already relies on, and never touch the active version.
describe('discardBinderDraftVersion', () => {
  it('deletes the draft version, its pages, slots, and bookmarks, leaving the active version intact', async () => {
    const db = setup();
    const created = await createBinder(db, 'owner', 'Binder', { kind: '2x2', rows: 2, columns: 2 });
    const draft = await cloneBinderVersion(
      db,
      'owner',
      created.version.id,
      created.version.revision,
    );
    const draftPageId = draft.pages[0]?.id;
    if (!draftPageId) throw new Error('missing draft page');
    await setBinderBookmark(db, 'owner', draft.version.id, {
      pageId: draftPageId,
      row: 0,
      column: 0,
      name: 'Draft mark',
    });

    await discardBinderDraftVersion(db, 'owner', draft.version.id, draft.version.revision);

    const version = await db
      .prepare('SELECT id FROM binder_versions WHERE id = ?1')
      .bind(draft.version.id)
      .first();
    expect(version).toBeNull();
    const pages = await db
      .prepare('SELECT COUNT(*) AS count FROM binder_pages WHERE binder_version_id = ?1')
      .bind(draft.version.id)
      .first<{ count: number }>();
    expect(pages?.count).toBe(0);
    const bookmarks = await db
      .prepare('SELECT COUNT(*) AS count FROM binder_bookmarks WHERE binder_page_id = ?1')
      .bind(draftPageId)
      .first<{ count: number }>();
    expect(bookmarks?.count).toBe(0);

    const activeVersion = await db
      .prepare('SELECT status FROM binder_versions WHERE id = ?1')
      .bind(created.version.id)
      .first<{ status: string }>();
    expect(activeVersion?.status).toBe('active');
  });

  it('refuses to discard the active version (409), leaving its row byte-identical', async () => {
    const db = setup();
    const created = await createBinder(db, 'owner', 'Binder', { kind: '2x2', rows: 2, columns: 2 });
    const before = await db
      .prepare('SELECT * FROM binder_versions WHERE id = ?1')
      .bind(created.version.id)
      .first();
    // binder_version_not_draft maps to 409 in routes/api/errors.ts's binderStatuses.
    await expect(
      discardBinderDraftVersion(db, 'owner', created.version.id, created.version.revision),
    ).rejects.toMatchObject({ code: 'binder_version_not_draft' });
    const after = await db
      .prepare('SELECT * FROM binder_versions WHERE id = ?1')
      .bind(created.version.id)
      .first();
    expect(after).toEqual(before);
  });

  it("404s (never a bare error) on another owner's draft, and does not delete it", async () => {
    const db = setup();
    const created = await createBinder(db, 'owner', 'Binder', { kind: '2x2', rows: 2, columns: 2 });
    const draft = await cloneBinderVersion(
      db,
      'owner',
      created.version.id,
      created.version.revision,
    );
    await expect(
      discardBinderDraftVersion(db, 'other', draft.version.id, draft.version.revision),
    ).rejects.toMatchObject({ code: 'binder_version_not_found' });
    const stillThere = await db
      .prepare('SELECT id FROM binder_versions WHERE id = ?1')
      .bind(draft.version.id)
      .first();
    expect(stillThere).not.toBeNull();
  });

  it('rejects a stale revision without deleting anything', async () => {
    const db = setup();
    const created = await createBinder(db, 'owner', 'Binder', { kind: '2x2', rows: 2, columns: 2 });
    const draft = await cloneBinderVersion(
      db,
      'owner',
      created.version.id,
      created.version.revision,
    );
    await expect(
      discardBinderDraftVersion(db, 'owner', draft.version.id, draft.version.revision + 1),
    ).rejects.toMatchObject({ code: 'binder_revision_conflict' });
    const stillThere = await db
      .prepare('SELECT id FROM binder_versions WHERE id = ?1')
      .bind(draft.version.id)
      .first();
    expect(stillThere).not.toBeNull();
  });
});
