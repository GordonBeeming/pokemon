import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { insertBlankBinderPages } from './binders';
import { applyAllMigrations, sqliteD1 } from './d1-test-helper';

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

/**
 * An active 2x2 binder with three pages: a Squirtle target on page 0, a reserved
 * "Johto" page 1 with a bookmark on it, and a Pikachu target on page 2.
 */
function setup(): { raw: DatabaseSync; db: D1Database } {
  const raw = new DatabaseSync(':memory:');
  databases.push(raw);
  applyAllMigrations(raw);
  raw.exec(`
    INSERT INTO users (id, label, created_at) VALUES ('owner', 'Owner', 1), ('other', 'Other', 1);
    INSERT INTO catalogue_cards
      (id, name, language, category, set_id, set_name, number, number_sort, pokedex_number, created_at, updated_at)
    VALUES ('squirtle', 'Squirtle', 'en', 'pokemon', 'base', 'Base', '63', 63, 7, 1, 1);
    INSERT INTO binders (id, owner_id, name, created_at, updated_at) VALUES ('binder', 'owner', 'National', 1, 1);
    INSERT INTO binder_versions
      (id, binder_id, version_number, status, layout_kind, rows, columns, capacity, created_at, revision)
    VALUES ('version', 'binder', 1, 'active', '2x2', 2, 2, 12, 1, 3);
    UPDATE binders SET active_version_id = 'version' WHERE id = 'binder';
    INSERT INTO binder_pages (id, binder_version_id, position, kind, label)
    VALUES ('p0', 'version', 0, 'slots', NULL), ('p1', 'version', 1, 'reserved', 'Johto'),
      ('p2', 'version', 2, 'slots', NULL);
    INSERT INTO binder_slots (binder_page_id, row_index, column_index, card_id, pokemon_number, entry_kind)
    VALUES
      ('p0', 0, 0, 'squirtle', NULL, 'exact-card'), ('p0', 0, 1, NULL, NULL, 'empty'),
      ('p0', 1, 0, NULL, NULL, 'empty'), ('p0', 1, 1, NULL, NULL, 'empty'),
      ('p1', 0, 0, NULL, NULL, 'empty'), ('p1', 0, 1, NULL, NULL, 'empty'),
      ('p1', 1, 0, NULL, NULL, 'empty'), ('p1', 1, 1, NULL, NULL, 'empty'),
      ('p2', 0, 0, NULL, 25, 'pokemon'), ('p2', 0, 1, NULL, NULL, 'empty'),
      ('p2', 1, 0, NULL, NULL, 'empty'), ('p2', 1, 1, NULL, NULL, 'empty');
    INSERT INTO binder_bookmarks (id, binder_page_id, row_index, column_index, name, created_at)
    VALUES ('bookmark', 'p2', 0, 0, 'Pikachu', 1);
  `);
  return { raw, db: sqliteD1(raw) };
}

function layout(raw: DatabaseSync): unknown {
  return raw
    .prepare(
      `SELECT page.position, page.id LIKE 'page_%' AS is_new, page.kind, page.label,
         (SELECT COUNT(*) FROM binder_slots slot WHERE slot.binder_page_id = page.id) AS slots,
         (SELECT COUNT(*) FROM binder_slots slot WHERE slot.binder_page_id = page.id
           AND slot.entry_kind <> 'empty') AS filled
       FROM binder_pages page WHERE page.binder_version_id = 'version' ORDER BY page.position`,
    )
    .all();
}

describe('insertBlankBinderPages', () => {
  it('slides blank pages in before a reserved page; later pages, labels and bookmarks move back whole', async () => {
    const { raw, db } = setup();
    await insertBlankBinderPages(db, 'owner', 'version', 1, 2, 3);
    expect(layout(raw)).toEqual([
      { position: 0, is_new: 0, kind: 'slots', label: null, slots: 4, filled: 1 },
      { position: 1, is_new: 1, kind: 'slots', label: null, slots: 4, filled: 0 },
      { position: 2, is_new: 1, kind: 'slots', label: null, slots: 4, filled: 0 },
      { position: 3, is_new: 0, kind: 'reserved', label: 'Johto', slots: 4, filled: 0 },
      { position: 4, is_new: 0, kind: 'slots', label: null, slots: 4, filled: 1 },
    ]);
    expect(
      raw
        .prepare(
          `SELECT page.position FROM binder_bookmarks bookmark
           JOIN binder_pages page ON page.id = bookmark.binder_page_id`,
        )
        .get(),
    ).toEqual({ position: 4 });
    expect(
      raw.prepare(`SELECT capacity, revision FROM binder_versions WHERE id = 'version'`).get(),
    ).toEqual({ capacity: 20, revision: 4 });
  });

  it('can add pages at the very end', async () => {
    const { raw, db } = setup();
    await insertBlankBinderPages(db, 'owner', 'version', 3, 1, 3);
    expect((layout(raw) as unknown[]).length).toBe(4);
  });

  it('refuses a stale revision, an out-of-range position, and another owner, changing nothing', async () => {
    const { raw, db } = setup();
    const before = layout(raw);
    await expect(insertBlankBinderPages(db, 'owner', 'version', 1, 1, 2)).rejects.toMatchObject({
      code: 'binder_revision_conflict',
    });
    await expect(insertBlankBinderPages(db, 'owner', 'version', 9, 1, 3)).rejects.toMatchObject({
      code: 'binder_page_not_found',
    });
    await expect(insertBlankBinderPages(db, 'other', 'version', 1, 1, 3)).rejects.toMatchObject({
      code: 'binder_version_not_found',
    });
    expect(layout(raw)).toEqual(before);
  });
});
