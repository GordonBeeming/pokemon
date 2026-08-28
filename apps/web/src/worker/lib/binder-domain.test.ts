import { describe, expect, it } from 'vitest';
import { cardIdSchema } from '@pokedex/shared';
import { DatabaseSync } from 'node:sqlite';
import {
  BinderDomainError,
  activateBinderVersion,
  addCardsToBinderVersion,
  arrangeBinderVersion,
  cloneBinderVersion,
  compactRemoveBinderEntry,
  createBinder,
  getBinderVersion,
  getBinderVersionShortages,
  getBinderAssignmentCandidates,
  insertBinderEntries,
  insertFullPokedex,
  moveBinderEntryByOffset,
  reflowBinderEntries,
  reserveBinderPage,
  resizeBinderCapacity,
  setBinderEntryAssignment,
  swapBinderSlots,
} from './binders';
import { setCollectionState } from './collection';
import { applyAllMigrations, sqliteD1 } from './d1-test-helper';

function setup() {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  applyAllMigrations(database);
  database.exec(`
    INSERT INTO users (id, label, created_at) VALUES ('owner', 'Owner', 1);
    INSERT INTO catalogue_cards
      (id,name,language,category,set_id,set_name,number,pokedex_number,created_at,updated_at)
    VALUES
      ('bulba','Bulbasaur','en','pokemon','base','Base','1',1,1,1),
      ('ivy','Ivysaur','en','pokemon','base','Base','2',2,1,1),
      ('trainer','Professor','en','trainer','base','Base','3',NULL,1,1);
    INSERT INTO collection_cards (owner_id,card_id,quantity,notes,revision,updated_at)
    VALUES ('owner','bulba',2,NULL,1,1), ('owner','ivy',1,NULL,1,1);
  `);
  return { database, db: sqliteD1(database) };
}

describe('binder row-major reflow', () => {
  it('generates page-break padding without losing an assigned printing', () => {
    const assignedCardId = cardIdSchema.parse('base1-001');
    const slots = reflowBinderEntries(8, 4, [
      { entry: { kind: 'pokemon', pokemonNumber: 1, startsNewPage: false } },
      {
        entry: { kind: 'exact-card', cardId: assignedCardId, startsNewPage: true },
        assignedCardId,
      },
    ]);
    expect(slots.slice(0, 5)).toEqual([
      { entry: { kind: 'pokemon', pokemonNumber: 1, startsNewPage: false } },
      null,
      null,
      null,
      {
        entry: { kind: 'exact-card', cardId: assignedCardId, startsNewPage: true },
        assignedCardId,
      },
    ]);
  });

  it('returns structured capacity details instead of growing', () => {
    try {
      reflowBinderEntries(
        4,
        4,
        Array.from({ length: 5 }, (_unused, index) => ({
          entry: { kind: 'pokemon' as const, pokemonNumber: index + 1, startsNewPage: false },
        })),
      );
      throw new Error('expected capacity failure');
    } catch (error) {
      expect(error).toBeInstanceOf(BinderDomainError);
      expect(error).toMatchObject({
        code: 'binder_capacity_exceeded',
        details: {
          currentCapacity: 4,
          requiredCapacity: 5,
          additionalPockets: 1,
          pageIncrement: 4,
        },
      });
    }
  });
});

describe('binder D1 domain', () => {
  it('backfills legacy projections and enforces storage combinations', () => {
    const { database } = setup();
    database.exec(`
      INSERT INTO binders (id,owner_id,name,created_at,updated_at)
      VALUES ('legacy-binder','owner','Legacy',1,1);
      INSERT INTO binder_versions
        (id,binder_id,version_number,status,layout_kind,rows,columns,created_at,revision)
      VALUES ('legacy-version','legacy-binder',1,'active','2x2',2,2,1,1);
      INSERT INTO binder_pages (id,binder_version_id,position)
      VALUES ('legacy-page','legacy-version',0);
      INSERT INTO binder_slots (binder_page_id,row_index,column_index,card_id)
      VALUES ('legacy-page',0,0,'bulba');
    `);
    expect(
      database.prepare("SELECT capacity FROM binder_versions WHERE id = 'legacy-version'").get(),
    ).toEqual({ capacity: 4 });
    expect(
      database
        .prepare(
          "SELECT entry_kind, card_id, assigned_card_id FROM binder_slots WHERE binder_page_id = 'legacy-page'",
        )
        .get(),
    ).toEqual({ entry_kind: 'exact-card', card_id: 'bulba', assigned_card_id: null });
    expect(() =>
      database.exec(
        "UPDATE binder_slots SET entry_kind='pokemon', card_id=NULL, pokemon_number=2, assigned_card_id='bulba' WHERE binder_page_id='legacy-page'",
      ),
    ).toThrow('binder_assignment_incompatible');
  });

  it('creates, grows, rejects occupied shrink, and safely shrinks whole pages', async () => {
    const { database, db } = setup();
    const created = await createBinder(
      db,
      'owner',
      'National',
      { kind: '2x2', rows: 2, columns: 2 },
      8,
    );
    expect(created.version).toMatchObject({ capacity: 8, pageCount: 2 });
    const grown = await resizeBinderCapacity(
      db,
      'owner',
      created.version.id,
      12,
      created.version.revision,
    );
    const inserted = await insertBinderEntries(
      db,
      'owner',
      created.version.id,
      { page: 0, row: 0, column: 0 },
      Array.from({ length: 9 }, () => ({
        kind: 'pokemon' as const,
        pokemonNumber: 1,
        startsNewPage: false,
      })),
      grown.version.revision,
    );
    await expect(
      resizeBinderCapacity(db, 'owner', created.version.id, 8, inserted.version.revision),
    ).rejects.toMatchObject({ code: 'binder_shrink_occupied' });
    const removed = await compactRemoveBinderEntry(
      db,
      'owner',
      created.version.id,
      { page: 0, row: 0, column: 0 },
      inserted.version.revision,
    );
    const shrunk = await resizeBinderCapacity(
      db,
      'owner',
      created.version.id,
      8,
      removed.version.revision,
    );
    expect(shrunk.version).toMatchObject({ capacity: 8, pageCount: 2 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM binder_slots').get()).toEqual({
      count: 8,
    });
  });

  it('reflows insert, physical offset moves, remove, and a reserved middle page', async () => {
    const { db } = setup();
    const created = await createBinder(
      db,
      'owner',
      'Plan',
      { kind: '2x2', rows: 2, columns: 2 },
      12,
    );
    const inserted = await insertBinderEntries(
      db,
      'owner',
      created.version.id,
      { page: 0, row: 0, column: 0 },
      [
        { kind: 'exact-card', cardId: cardIdSchema.parse('bulba'), startsNewPage: false },
        { kind: 'pokemon', pokemonNumber: 2, startsNewPage: false },
      ],
      created.version.revision,
    );
    const assigned = await setBinderEntryAssignment(
      db,
      'owner',
      created.version.id,
      { page: 0, row: 0, column: 0 },
      'bulba',
      inserted.version.revision,
    );
    const movedForward = await moveBinderEntryByOffset(
      db,
      'owner',
      created.version.id,
      { page: 0, row: 0, column: 0 },
      5,
      assigned.version.revision,
    );
    const forwardPages = await getBinderVersion(db, 'owner', created.version.id, 0, 2);
    expect(forwardPages.pages[0]?.slots[0]).toMatchObject({
      entryKind: 'pokemon',
      pokemonNumber: 2,
    });
    expect(forwardPages.pages[1]?.slots[1]).toMatchObject({
      entryKind: 'exact-card',
      cardId: 'bulba',
      assignedCardId: 'bulba',
    });
    const movedBackward = await moveBinderEntryByOffset(
      db,
      'owner',
      created.version.id,
      { page: 1, row: 0, column: 1 },
      -3,
      movedForward.version.revision,
    );
    const backwardPages = await getBinderVersion(db, 'owner', created.version.id, 0, 2);
    expect(backwardPages.pages[0]?.slots[2]).toMatchObject({
      entryKind: 'exact-card',
      cardId: 'bulba',
      assignedCardId: 'bulba',
    });
    expect(backwardPages.pages[1]?.slots[1]).toMatchObject({ entryKind: 'empty' });
    const reserved = await reserveBinderPage(
      db,
      'owner',
      created.version.id,
      1,
      true,
      'Trades',
      movedBackward.version.revision,
    );
    const pages = await getBinderVersion(db, 'owner', created.version.id, 0, 3);
    expect(pages.pages[1]).toMatchObject({ kind: 'reserved', label: 'Trades' });
    expect(pages.pages[1]?.slots.every((slot) => slot.entryKind === 'empty')).toBe(true);
    const restored = await reserveBinderPage(
      db,
      'owner',
      created.version.id,
      1,
      false,
      null,
      reserved.version.revision,
    );
    const removed = await compactRemoveBinderEntry(
      db,
      'owner',
      created.version.id,
      { page: 0, row: 0, column: 0 },
      restored.version.revision,
    );
    expect(removed.version.revision).toBe(restored.version.revision + 1);
  });

  it('moves through a full binder without losing a target or assignment', async () => {
    const { database, db } = setup();
    database.exec(`
      INSERT INTO catalogue_cards
        (id,name,language,category,set_id,set_name,number,pokedex_number,created_at,updated_at)
      VALUES
        ('extra-0','Extra 0','en','pokemon','extra','Extra','0',10,1,1),
        ('extra-1','Extra 1','en','pokemon','extra','Extra','1',11,1,1),
        ('extra-2','Extra 2','en','pokemon','extra','Extra','2',12,1,1),
        ('extra-3','Extra 3','en','pokemon','extra','Extra','3',13,1,1),
        ('extra-4','Extra 4','en','pokemon','extra','Extra','4',14,1,1);
    `);
    const cardIds = [
      'ivy',
      'trainer',
      'extra-0',
      'bulba',
      'extra-1',
      'extra-2',
      'extra-3',
      'extra-4',
    ];
    const created = await createBinder(
      db,
      'owner',
      'Full move',
      { kind: '2x2', rows: 2, columns: 2 },
      8,
    );
    const inserted = await insertBinderEntries(
      db,
      'owner',
      created.version.id,
      { page: 0, row: 0, column: 0 },
      cardIds.map((cardId) => ({
        kind: 'exact-card' as const,
        cardId: cardIdSchema.parse(cardId),
        startsNewPage: false,
      })),
      created.version.revision,
    );
    const assigned = await setBinderEntryAssignment(
      db,
      'owner',
      created.version.id,
      { page: 0, row: 1, column: 1 },
      'bulba',
      inserted.version.revision,
    );
    const readPayloads = () =>
      database
        .prepare(
          `SELECT slot.card_id, slot.assigned_card_id
           FROM binder_slots slot JOIN binder_pages page ON page.id = slot.binder_page_id
           WHERE page.binder_version_id = ?1
           ORDER BY page.position, slot.row_index, slot.column_index`,
        )
        .all(created.version.id) as Array<{ card_id: string; assigned_card_id: string | null }>;
    const assertComplete = () => {
      const payloads = readPayloads();
      expect(payloads.map((row) => row.card_id).sort()).toEqual([...cardIds].sort());
      expect(payloads.filter((row) => row.assigned_card_id === 'bulba')).toHaveLength(1);
      expect(payloads).toHaveLength(8);
    };
    const forward = await moveBinderEntryByOffset(
      db,
      'owner',
      created.version.id,
      { page: 0, row: 1, column: 1 },
      3,
      assigned.version.revision,
    );
    assertComplete();
    const backward = await moveBinderEntryByOffset(
      db,
      'owner',
      created.version.id,
      { page: 1, row: 1, column: 0 },
      -3,
      forward.version.revision,
    );
    assertComplete();
    expect(backward.version.capacity).toBe(8);
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM binder_slots slot
           JOIN binder_pages page ON page.id = slot.binder_page_id
           WHERE page.binder_version_id = ?1`,
        )
        .get(created.version.id),
    ).toEqual({ count: 8 });
  });

  it('arranges exact and Pokemon targets while anchoring reservations and assignments', async () => {
    const { db } = setup();
    const created = await createBinder(
      db,
      'owner',
      'Arrange',
      { kind: '2x2', rows: 2, columns: 2 },
      12,
    );
    const inserted = await insertBinderEntries(
      db,
      'owner',
      created.version.id,
      { page: 0, row: 0, column: 0 },
      [
        { kind: 'exact-card', cardId: cardIdSchema.parse('ivy'), startsNewPage: false },
        { kind: 'reserved', label: 'Trade' },
        { kind: 'pokemon', pokemonNumber: 1, startsNewPage: true },
      ],
      created.version.revision,
    );
    const assigned = await setBinderEntryAssignment(
      db,
      'owner',
      created.version.id,
      { page: 0, row: 0, column: 0 },
      'ivy',
      inserted.version.revision,
    );
    const reservedPage = await reserveBinderPage(
      db,
      'owner',
      created.version.id,
      2,
      true,
      'Archive',
      assigned.version.revision,
    );
    await arrangeBinderVersion(
      db,
      'owner',
      created.version.id,
      'pokedex-number',
      reservedPage.version.revision,
    );
    const pages = await getBinderVersion(db, 'owner', created.version.id, 0, 3);
    expect(pages.pages[0]?.slots[0]).toMatchObject({
      entryKind: 'pokemon',
      pokemonNumber: 1,
      startsNewPage: true,
    });
    expect(pages.pages[0]?.slots[1]).toMatchObject({ entryKind: 'reserved', label: 'Trade' });
    expect(pages.pages[0]?.slots[2]).toMatchObject({
      entryKind: 'exact-card',
      cardId: 'ivy',
      assignedCardId: 'ivy',
    });
    expect(pages.pages[2]).toMatchObject({ kind: 'reserved', label: 'Archive' });
  });

  it('swaps complete entry payloads across pages and rejects whole reserved pages', async () => {
    const { db } = setup();
    const created = await createBinder(
      db,
      'owner',
      'Swap',
      { kind: '2x2', rows: 2, columns: 2 },
      12,
    );
    const inserted = await insertBinderEntries(
      db,
      'owner',
      created.version.id,
      { page: 0, row: 0, column: 0 },
      [
        { kind: 'exact-card', cardId: cardIdSchema.parse('bulba'), startsNewPage: false },
        { kind: 'reserved', label: 'Trade' },
        { kind: 'pokemon', pokemonNumber: 2, startsNewPage: true },
      ],
      created.version.revision,
    );
    const exactAssigned = await setBinderEntryAssignment(
      db,
      'owner',
      created.version.id,
      { page: 0, row: 0, column: 0 },
      'bulba',
      inserted.version.revision,
    );
    const pokemonAssigned = await setBinderEntryAssignment(
      db,
      'owner',
      created.version.id,
      { page: 1, row: 0, column: 0 },
      'ivy',
      exactAssigned.version.revision,
    );
    const swapped = await swapBinderSlots(
      db,
      'owner',
      created.version.id,
      { page: 0, row: 0, column: 0 },
      { page: 1, row: 0, column: 0 },
      pokemonAssigned.version.revision,
    );
    const pages = await getBinderVersion(db, 'owner', created.version.id, 0, 3);
    expect(pages.pages[0]?.slots[0]).toMatchObject({
      entryKind: 'pokemon',
      pokemonNumber: 2,
      assignedCardId: 'ivy',
      startsNewPage: true,
    });
    expect(pages.pages[0]?.slots[1]).toMatchObject({ entryKind: 'reserved', label: 'Trade' });
    expect(pages.pages[1]?.slots[0]).toMatchObject({
      entryKind: 'exact-card',
      cardId: 'bulba',
      assignedCardId: 'bulba',
    });
    const reserved = await reserveBinderPage(
      db,
      'owner',
      created.version.id,
      2,
      true,
      null,
      swapped.version.revision,
    );
    await expect(
      swapBinderSlots(
        db,
        'owner',
        created.version.id,
        { page: 0, row: 0, column: 0 },
        { page: 2, row: 0, column: 0 },
        reserved.version.revision,
      ),
    ).rejects.toMatchObject({ code: 'binder_reserved_page_not_empty' });
  });

  it('keeps an occupied-to-empty swap at the requested physical destination', async () => {
    const { db } = setup();
    const created = await createBinder(
      db,
      'owner',
      'Sparse swap',
      { kind: '2x2', rows: 2, columns: 2 },
      8,
    );
    const inserted = await insertBinderEntries(
      db,
      'owner',
      created.version.id,
      { page: 0, row: 0, column: 0 },
      [{ kind: 'exact-card', cardId: cardIdSchema.parse('bulba'), startsNewPage: false }],
      created.version.revision,
    );
    const assigned = await setBinderEntryAssignment(
      db,
      'owner',
      created.version.id,
      { page: 0, row: 0, column: 0 },
      'bulba',
      inserted.version.revision,
    );
    await swapBinderSlots(
      db,
      'owner',
      created.version.id,
      { page: 0, row: 0, column: 0 },
      { page: 1, row: 0, column: 1 },
      assigned.version.revision,
    );
    const pages = await getBinderVersion(db, 'owner', created.version.id, 0, 2);
    expect(pages.pages[0]?.slots[0]).toMatchObject({
      entryKind: 'empty',
      cardId: null,
      assignedCardId: null,
    });
    expect(pages.pages[1]?.slots[1]).toMatchObject({
      entryKind: 'exact-card',
      cardId: 'bulba',
      assignedCardId: 'bulba',
      startsNewPage: false,
    });
  });

  it('bulk append uses only true empty pockets on regular pages', async () => {
    const { db } = setup();
    const created = await createBinder(
      db,
      'owner',
      'Bulk',
      { kind: '2x2', rows: 2, columns: 2 },
      8,
    );
    const inserted = await insertBinderEntries(
      db,
      'owner',
      created.version.id,
      { page: 0, row: 0, column: 0 },
      [
        { kind: 'pokemon', pokemonNumber: 1, startsNewPage: false },
        { kind: 'reserved', label: 'Keep' },
      ],
      created.version.revision,
    );
    const reserved = await reserveBinderPage(
      db,
      'owner',
      created.version.id,
      1,
      true,
      null,
      inserted.version.revision,
    );
    const appended = await addCardsToBinderVersion(
      db,
      'owner',
      created.version.id,
      ['trainer'],
      reserved.version.revision,
    );
    const pages = await getBinderVersion(db, 'owner', created.version.id, 0, 2);
    expect(pages.pages[0]?.slots.slice(0, 3).map((slot) => slot.entryKind)).toEqual([
      'pokemon',
      'reserved',
      'exact-card',
    ]);
    expect(pages.pages[1]?.kind).toBe('reserved');
    await expect(
      addCardsToBinderVersion(
        db,
        'owner',
        created.version.id,
        ['bulba', 'ivy'],
        appended.binder.version.revision,
      ),
    ).rejects.toMatchObject({ code: 'binder_capacity_exceeded' });
  });

  it('subtracts assignments elsewhere from shortages, readiness, and candidates', async () => {
    const { db } = setup();
    const first = await createBinder(
      db,
      'owner',
      'Assigned',
      { kind: '2x2', rows: 2, columns: 2 },
      4,
    );
    const firstTarget = await insertBinderEntries(
      db,
      'owner',
      first.version.id,
      { page: 0, row: 0, column: 0 },
      [{ kind: 'exact-card', cardId: cardIdSchema.parse('ivy'), startsNewPage: false }],
      first.version.revision,
    );
    await setBinderEntryAssignment(
      db,
      'owner',
      first.version.id,
      { page: 0, row: 0, column: 0 },
      'ivy',
      firstTarget.version.revision,
    );
    const second = await createBinder(
      db,
      'owner',
      'Waiting',
      { kind: '2x2', rows: 2, columns: 2 },
      4,
    );
    const secondTarget = await insertBinderEntries(
      db,
      'owner',
      second.version.id,
      { page: 0, row: 0, column: 0 },
      [
        { kind: 'exact-card', cardId: cardIdSchema.parse('ivy'), startsNewPage: false },
        { kind: 'pokemon', pokemonNumber: 2, startsNewPage: false },
      ],
      second.version.revision,
    );
    const shortages = await getBinderVersionShortages(db, 'owner', second.version.id);
    expect(shortages.readyToPlace.exactTargets).toBe(0);
    expect(shortages.readyToPlace.pokemonTargets).toBe(0);
    expect(shortages.shortages).toEqual([
      {
        cardId: 'ivy',
        required: 1,
        owned: 1,
        assigned: 1,
        available: 0,
        missing: 1,
      },
    ]);
    expect(shortages.pokemonShortages).toEqual([
      {
        pokemonNumber: 2,
        required: 1,
        owned: 1,
        assigned: 1,
        available: 0,
        missing: 1,
      },
    ]);
    const candidates = await getBinderAssignmentCandidates(db, 'owner', second.version.id, {
      page: 0,
      row: 0,
      column: 0,
    });
    expect(candidates.candidates).toEqual([
      expect.objectContaining({ cardId: 'ivy', owned: 1, assigned: 1, available: 0 }),
    ]);
    const pokemonCandidates = await getBinderAssignmentCandidates(db, 'owner', second.version.id, {
      page: 0,
      row: 0,
      column: 1,
    });
    expect(pokemonCandidates.candidates).toEqual([
      expect.objectContaining({ cardId: 'ivy', owned: 1, assigned: 1, available: 0 }),
    ]);
    expect(secondTarget.version.revision).toBe(2);
  });

  it('rechecks draft assignment conflicts atomically at activation', async () => {
    const { database, db } = setup();
    const first = await createBinder(db, 'owner', 'First', { kind: '2x2', rows: 2, columns: 2 }, 4);
    const firstTarget = await insertBinderEntries(
      db,
      'owner',
      first.version.id,
      { page: 0, row: 0, column: 0 },
      [{ kind: 'exact-card', cardId: cardIdSchema.parse('bulba'), startsNewPage: false }],
      first.version.revision,
    );
    const firstAssigned = await setBinderEntryAssignment(
      db,
      'owner',
      first.version.id,
      { page: 0, row: 0, column: 0 },
      'bulba',
      firstTarget.version.revision,
    );
    const draft = await cloneBinderVersion(
      db,
      'owner',
      first.version.id,
      firstAssigned.version.revision,
    );
    const draftTarget = await insertBinderEntries(
      db,
      'owner',
      draft.version.id,
      { page: 0, row: 0, column: 1 },
      [{ kind: 'exact-card', cardId: cardIdSchema.parse('bulba'), startsNewPage: false }],
      draft.version.revision,
    );
    const draftAssigned = await setBinderEntryAssignment(
      db,
      'owner',
      draft.version.id,
      { page: 0, row: 0, column: 1 },
      'bulba',
      draftTarget.version.revision,
    );
    const second = await createBinder(
      db,
      'owner',
      'Second',
      { kind: '2x2', rows: 2, columns: 2 },
      4,
    );
    const secondTarget = await insertBinderEntries(
      db,
      'owner',
      second.version.id,
      { page: 0, row: 0, column: 0 },
      [{ kind: 'exact-card', cardId: cardIdSchema.parse('bulba'), startsNewPage: false }],
      second.version.revision,
    );
    await setBinderEntryAssignment(
      db,
      'owner',
      second.version.id,
      { page: 0, row: 0, column: 0 },
      'bulba',
      secondTarget.version.revision,
    );
    await expect(
      activateBinderVersion(db, 'owner', draft.version.id, draftAssigned.version.revision),
    ).rejects.toMatchObject({ code: 'binder_assignment_quantity_exceeded' });
    expect(
      database.prepare('SELECT status FROM binder_versions WHERE id = ?1').get(first.version.id),
    ).toEqual({ status: 'active' });
    expect(
      database.prepare('SELECT status FROM binder_versions WHERE id = ?1').get(draft.version.id),
    ).toEqual({ status: 'draft' });
  });

  it('enforces assignment compatibility and the active collection floor', async () => {
    const { db } = setup();
    const created = await createBinder(
      db,
      'owner',
      'Owned',
      { kind: '2x2', rows: 2, columns: 2 },
      4,
    );
    const inserted = await insertBinderEntries(
      db,
      'owner',
      created.version.id,
      { page: 0, row: 0, column: 0 },
      [
        { kind: 'exact-card', cardId: cardIdSchema.parse('bulba'), startsNewPage: false },
        { kind: 'pokemon', pokemonNumber: 2, startsNewPage: false },
      ],
      created.version.revision,
    );
    await expect(
      setBinderEntryAssignment(
        db,
        'owner',
        created.version.id,
        { page: 0, row: 0, column: 1 },
        'bulba',
        inserted.version.revision,
      ),
    ).rejects.toThrow('binder_assignment_incompatible');
    const assigned = await setBinderEntryAssignment(
      db,
      'owner',
      created.version.id,
      { page: 0, row: 0, column: 0 },
      'bulba',
      inserted.version.revision,
    );
    await expect(
      setCollectionState(db, 'owner', {
        cardId: 'bulba',
        mutationId: '00000000-0000-4000-8000-000000000001',
        expectedRevision: 1,
        quantity: 0,
        notes: null,
      }),
    ).rejects.toMatchObject({
      code: 'collection_quantity_below_active_assignments',
      details: {
        activeAssignments: [
          {
            binderId: created.version.binderId,
            versionId: created.version.id,
            page: 0,
            row: 0,
            column: 0,
          },
        ],
      },
    });
    expect(assigned.version.revision).toBe(inserted.version.revision + 1);
  });

  it('rolls back a full Pokedex insert when fixed capacity is too small', async () => {
    const { database, db } = setup();
    const created = await createBinder(
      db,
      'owner',
      'Small',
      { kind: '2x2', rows: 2, columns: 2 },
      8,
    );
    await expect(
      insertFullPokedex(
        db,
        'owner',
        created.version.id,
        { page: 0, row: 0, column: 0 },
        true,
        created.version.revision,
      ),
    ).rejects.toMatchObject({ code: 'binder_capacity_exceeded' });
    expect(
      database
        .prepare('SELECT revision, capacity FROM binder_versions WHERE id = ?1')
        .get(created.version.id),
    ).toEqual({ revision: 1, capacity: 8 });
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM binder_slots WHERE entry_kind <> 'empty'")
        .get(),
    ).toEqual({ count: 0 });
  });

  it('starts Kanto on the next page and keeps an undersized region insert atomic', async () => {
    const { database, db } = setup();
    const layout = { kind: '3x3' as const, rows: 3 as const, columns: 3 as const };
    const large = await createBinder(db, 'owner', 'Regional', layout, 1206);
    const largeFillers = await insertBinderEntries(
      db,
      'owner',
      large.version.id,
      { page: 0, row: 0, column: 0 },
      [
        { kind: 'exact-card', cardId: cardIdSchema.parse('bulba'), startsNewPage: false },
        { kind: 'exact-card', cardId: cardIdSchema.parse('ivy'), startsNewPage: false },
      ],
      large.version.revision,
    );
    await insertFullPokedex(
      db,
      'owner',
      large.version.id,
      { page: 0, row: 0, column: 2 },
      true,
      largeFillers.version.revision,
    );
    const firstTwoPages = await getBinderVersion(db, 'owner', large.version.id, 0, 2);
    expect(firstTwoPages.pages[0]?.slots.slice(0, 2).map((slot) => slot.cardId)).toEqual([
      'bulba',
      'ivy',
    ]);
    expect(firstTwoPages.pages[0]?.slots.slice(2).every((slot) => slot.entryKind === 'empty')).toBe(
      true,
    );
    expect(firstTwoPages.pages[1]?.slots[0]).toMatchObject({
      entryKind: 'pokemon',
      pokemonNumber: 1,
      startsNewPage: true,
    });

    const small = await createBinder(db, 'owner', 'Regional small', layout, 1026);
    const smallFillers = await insertBinderEntries(
      db,
      'owner',
      small.version.id,
      { page: 0, row: 0, column: 0 },
      [
        { kind: 'exact-card', cardId: cardIdSchema.parse('bulba'), startsNewPage: false },
        { kind: 'exact-card', cardId: cardIdSchema.parse('ivy'), startsNewPage: false },
      ],
      small.version.revision,
    );
    await expect(
      insertFullPokedex(
        db,
        'owner',
        small.version.id,
        { page: 0, row: 0, column: 2 },
        true,
        smallFillers.version.revision,
      ),
    ).rejects.toMatchObject({ code: 'binder_capacity_exceeded' });
    expect(
      database.prepare('SELECT revision FROM binder_versions WHERE id = ?1').get(small.version.id),
    ).toEqual({ revision: smallFillers.version.revision });
    expect(
      database
        .prepare(
          `SELECT entry_kind, card_id FROM binder_slots slot
           JOIN binder_pages page ON page.id = slot.binder_page_id
           WHERE page.binder_version_id = ?1 AND slot.entry_kind <> 'empty'
           ORDER BY page.position, slot.row_index, slot.column_index`,
        )
        .all(small.version.id),
    ).toEqual([
      { entry_kind: 'exact-card', card_id: 'bulba' },
      { entry_kind: 'exact-card', card_id: 'ivy' },
    ]);
  }, 15_000);
});
