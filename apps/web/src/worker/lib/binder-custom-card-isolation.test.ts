import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { cardIdSchema } from '@pokedex/shared';
import {
  addCardsToBinderVersion,
  createBinder,
  insertBinderEntries,
  listBinders,
  pasteBinderCards,
  setBinderEntryAssignment,
  setBinderSlots,
} from './binders';
import { applyAllMigrations, sqliteD1 } from './d1-test-helper';

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

const OTHER_CUSTOM = 'other-custom';

function setup(): D1Database {
  const raw = new DatabaseSync(':memory:');
  databases.push(raw);
  raw.exec('PRAGMA foreign_keys = ON');
  applyAllMigrations(raw);
  raw.exec(`
    INSERT INTO users(id,label,created_at) VALUES('owner','Owner',1),('other','Other',1);
    INSERT INTO catalogue_cards
      (id,name,language,category,set_id,set_name,number,is_custom,owner_id,created_at,updated_at)
    VALUES ('${OTHER_CUSTOM}','Other''s Custom Card','en','special','custom','Custom','1',1,'other',1,1);
  `);
  return sqliteD1(raw);
}

// A binder-write path that let a caller reference another owner's custom
// card as an exact-card target would leak that card's name/set/number
// through every subsequent binder read (dashboard, candidates, search), so
// each entry point that can introduce a new card reference gets its own
// isolation test here.
describe("binder writes refuse another owner's custom card as a target", () => {
  it('setBinderEntryAssignment (and so placeCard) refuses it via requireCard', async () => {
    const db = setup();
    const created = await createBinder(db, 'owner', 'Binder', { kind: '2x2', rows: 2, columns: 2 });
    const [binder] = await listBinders(db, 'owner');
    if (!binder?.activeVersionId) throw new Error('missing_version');
    await expect(
      setBinderEntryAssignment(
        db,
        'owner',
        binder.activeVersionId,
        { page: 0, row: 0, column: 0 },
        OTHER_CUSTOM,
        created.version.revision,
      ),
    ).rejects.toMatchObject({ code: 'card_not_found' });
  });

  it('insertBinderEntries refuses an exact-card entry naming it', async () => {
    const db = setup();
    const created = await createBinder(db, 'owner', 'Binder', { kind: '2x2', rows: 2, columns: 2 });
    const [binder] = await listBinders(db, 'owner');
    if (!binder?.activeVersionId) throw new Error('missing_version');
    await expect(
      insertBinderEntries(
        db,
        'owner',
        binder.activeVersionId,
        { page: 0, row: 0, column: 0 },
        [{ kind: 'exact-card', cardId: cardIdSchema.parse(OTHER_CUSTOM), startsNewPage: false }],
        created.version.revision,
      ),
    ).rejects.toMatchObject({ code: 'binder_arrangement_card_missing' });
    const slot = await db
      .prepare(
        `SELECT entry_kind FROM binder_slots slot
         JOIN binder_pages page ON page.id = slot.binder_page_id
         WHERE page.binder_version_id = ?1 AND slot.row_index = 0 AND slot.column_index = 0`,
      )
      .bind(binder.activeVersionId)
      .first<{ entry_kind: string }>();
    expect(slot?.entry_kind).toBe('empty');
  });

  it('setBinderSlots refuses assigning it', async () => {
    const db = setup();
    const created = await createBinder(db, 'owner', 'Binder', { kind: '2x2', rows: 2, columns: 2 });
    const [binder] = await listBinders(db, 'owner');
    if (!binder?.activeVersionId) throw new Error('missing_version');
    await expect(
      setBinderSlots(
        db,
        'owner',
        binder.activeVersionId,
        [{ page: 0, row: 0, column: 0, cardId: OTHER_CUSTOM }],
        created.version.revision,
      ),
    ).rejects.toMatchObject({ code: 'binder_arrangement_card_missing' });
  });

  it('addCardsToBinderVersion refuses appending it', async () => {
    const db = setup();
    const created = await createBinder(db, 'owner', 'Binder', { kind: '2x2', rows: 2, columns: 2 });
    const [binder] = await listBinders(db, 'owner');
    if (!binder?.activeVersionId) throw new Error('missing_version');
    await expect(
      addCardsToBinderVersion(
        db,
        'owner',
        binder.activeVersionId,
        [OTHER_CUSTOM],
        created.version.revision,
      ),
    ).rejects.toMatchObject({ code: 'binder_arrangement_card_missing' });
  });

  it('pasteBinderCards refuses pasting it', async () => {
    const db = setup();
    const created = await createBinder(db, 'owner', 'Binder', { kind: '2x2', rows: 2, columns: 2 });
    const [binder] = await listBinders(db, 'owner');
    if (!binder?.activeVersionId) throw new Error('missing_version');
    await expect(
      pasteBinderCards(db, 'owner', binder.activeVersionId, {
        at: { page: 0, row: 0, column: 0 },
        cardIds: [cardIdSchema.parse(OTHER_CUSTOM)],
        mode: 'insert',
        confirmReplace: false,
        expectedRevision: created.version.revision,
      }),
    ).rejects.toMatchObject({ code: 'card_not_found' });
  });
});
