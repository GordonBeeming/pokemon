import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createBinder,
  getCardBinderMatches,
  insertBinderEntries,
  listBinders,
  listInactiveBinderTargets,
  placeCard,
} from './binders';
import { applyAllMigrations, sqliteD1 } from './d1-test-helper';
import { setCollectionState } from './collection';
import { cardIdSchema } from '@pokedex/shared';

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function setup(): D1Database {
  const raw = new DatabaseSync(':memory:');
  databases.push(raw);
  applyAllMigrations(raw);
  raw.exec(`
    INSERT INTO users(id,label,created_at) VALUES('owner','Owner',1);
    INSERT INTO catalogue_cards
      (id,name,language,category,set_id,set_name,number,pokedex_number,is_active,created_at,updated_at)
    VALUES
      ('squirtle-1','Squirtle','en','pokemon','base','Base','1',7,1,1,1),
      ('squirtle-2','Squirtle','en','pokemon','jungle','Jungle','2',7,1,1,1),
      ('pocket-mon','Hidden Mon','en','pokemon','A3a','Extradimensional Crisis','1',150,0,1,1);
  `);
  return sqliteD1(raw);
}

describe('getCardBinderMatches', () => {
  it('reports an exact-card target as open until assigned, then as placed (never both)', async () => {
    const db = setup();
    const created = await createBinder(db, 'owner', 'Binder', { kind: '2x2', rows: 2, columns: 2 });
    const [binder] = await listBinders(db, 'owner');
    if (!binder?.activeVersionId) throw new Error('missing_version');
    const inserted = await insertBinderEntries(
      db,
      'owner',
      binder.activeVersionId,
      { page: 0, row: 0, column: 0 },
      [{ kind: 'exact-card', cardId: cardIdSchema.parse('squirtle-1'), startsNewPage: false }],
      created.version.revision,
    );
    let matches = await getCardBinderMatches(db, 'owner', 'squirtle-1');
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      binderId: binder.id,
      exactTargets: [expect.objectContaining({ row: 0, col: 0 })],
      placed: [],
    });
    expect(matches[0]?.nextTarget).toMatchObject({ row: 0, col: 0 });

    const pageId = await firstPageId(db, binder.activeVersionId);
    await setCollectionState(db, 'owner', {
      cardId: 'squirtle-1',
      mutationId: crypto.randomUUID(),
      expectedRevision: 0,
      quantity: 1,
      notes: null,
    });
    await placeCard(
      db,
      'owner',
      'squirtle-1',
      binder.id,
      `${pageId}:0:0`,
      false,
      inserted.version.revision,
    );
    matches = await getCardBinderMatches(db, 'owner', 'squirtle-1');
    expect(matches[0]?.exactTargets).toEqual([]);
    expect(matches[0]?.placed).toEqual([expect.objectContaining({ row: 0, col: 0 })]);
  });

  it('reports an unfilled pokemon target as an open target, not placed, and points nextTarget/endDestination correctly', async () => {
    const db = setup();
    const created = await createBinder(db, 'owner', 'Binder', { kind: '2x2', rows: 2, columns: 2 });
    const [binder] = await listBinders(db, 'owner');
    if (!binder?.activeVersionId) throw new Error('missing_version');
    await insertBinderEntries(
      db,
      'owner',
      binder.activeVersionId,
      { page: 0, row: 0, column: 0 },
      [{ kind: 'pokemon', pokemonNumber: 7, startsNewPage: false }],
      created.version.revision,
    );
    const matches = await getCardBinderMatches(db, 'owner', 'squirtle-1');
    expect(matches[0]?.pokemonTargets).toEqual([expect.objectContaining({ row: 0, col: 0 })]);
    expect(matches[0]?.placed).toHaveLength(0);
    // nextTarget is this open pokemon target; endDestination is the next empty
    // pocket after it (the pokemon-kind slot itself counts as "used" for the
    // append calculation even though it's unfilled).
    expect(matches[0]?.nextTarget).toMatchObject({ row: 0, col: 0 });
    expect(matches[0]?.endDestination).toMatchObject({ row: 0, col: 1 });
  });

  it('returns only an endDestination when nothing matches this card at all', async () => {
    const db = setup();
    await createBinder(db, 'owner', 'Binder', { kind: '2x2', rows: 2, columns: 2 });
    const [binder] = await listBinders(db, 'owner');
    if (!binder?.activeVersionId) throw new Error('missing_version');
    const matches = await getCardBinderMatches(db, 'owner', 'squirtle-1');
    expect(matches[0]).toMatchObject({
      exactTargets: [],
      pokemonTargets: [],
      placed: [],
      nextTarget: null,
    });
    expect(matches[0]?.endDestination).toMatchObject({ row: 0, col: 0 });
  });

  it('reports no endDestination once the binder is full', async () => {
    const db = setup();
    const created = await createBinder(db, 'owner', 'Binder', { kind: '2x2', rows: 2, columns: 2 });
    const [binder] = await listBinders(db, 'owner');
    if (!binder?.activeVersionId) throw new Error('missing_version');
    await insertBinderEntries(
      db,
      'owner',
      binder.activeVersionId,
      { page: 0, row: 0, column: 0 },
      [
        { kind: 'exact-card', cardId: cardIdSchema.parse('squirtle-2'), startsNewPage: false },
        { kind: 'exact-card', cardId: cardIdSchema.parse('squirtle-2'), startsNewPage: false },
        { kind: 'exact-card', cardId: cardIdSchema.parse('squirtle-2'), startsNewPage: false },
        { kind: 'exact-card', cardId: cardIdSchema.parse('squirtle-2'), startsNewPage: false },
      ],
      created.version.revision,
    );
    const matches = await getCardBinderMatches(db, 'owner', 'squirtle-1');
    expect(matches[0]?.endDestination).toBeNull();
  });

  it('reports a pokemon target as placed once this exact printing is assigned', async () => {
    const db = setup();
    const created = await createBinder(db, 'owner', 'Binder', { kind: '2x2', rows: 2, columns: 2 });
    const [binder] = await listBinders(db, 'owner');
    if (!binder?.activeVersionId) throw new Error('missing_version');
    await insertBinderEntries(
      db,
      'owner',
      binder.activeVersionId,
      { page: 0, row: 0, column: 0 },
      [{ kind: 'pokemon', pokemonNumber: 7, startsNewPage: false }],
      created.version.revision,
    );
    const pageId = await firstPageId(db, binder.activeVersionId);
    await placeCard(
      db,
      'owner',
      'squirtle-1',
      binder.id,
      `${pageId}:0:0`,
      true,
      created.version.revision + 1,
    );
    const matches = await getCardBinderMatches(db, 'owner', 'squirtle-1');
    expect(matches[0]?.placed).toEqual([expect.objectContaining({ row: 0, col: 0 })]);
  });
});

async function firstPageId(db: D1Database, versionId: string): Promise<string> {
  const row = await db
    .prepare('SELECT id FROM binder_pages WHERE binder_version_id = ?1 ORDER BY position LIMIT 1')
    .bind(versionId)
    .first<{ id: string }>();
  if (!row) throw new Error('page_not_found');
  return row.id;
}

describe('placeCard', () => {
  it('places via the assignment path so an any-printing target keeps its target', async () => {
    const db = setup();
    const created = await createBinder(db, 'owner', 'Binder', { kind: '2x2', rows: 2, columns: 2 });
    const [binder] = await listBinders(db, 'owner');
    if (!binder?.activeVersionId) throw new Error('missing_version');
    await insertBinderEntries(
      db,
      'owner',
      binder.activeVersionId,
      { page: 0, row: 0, column: 0 },
      [{ kind: 'pokemon', pokemonNumber: 7, startsNewPage: false }],
      created.version.revision,
    );
    const pageId = await firstPageId(db, binder.activeVersionId);
    await setCollectionState(db, 'owner', {
      cardId: 'squirtle-1',
      mutationId: crypto.randomUUID(),
      expectedRevision: 0,
      quantity: 1,
      notes: null,
    });
    await placeCard(
      db,
      'owner',
      'squirtle-1',
      binder.id,
      `${pageId}:0:0`,
      false,
      created.version.revision + 1,
    );
    const slot = await db
      .prepare(
        `SELECT entry_kind, pokemon_number, assigned_card_id FROM binder_slots
         WHERE binder_page_id = ?1 AND row_index = 0 AND column_index = 0`,
      )
      .bind(pageId)
      .first<{ entry_kind: string; pokemon_number: number; assigned_card_id: string }>();
    // the target stays "any Squirtle" (pokemon_number 7); only the fulfilling
    // printing changes, unlike the legacy setSlot rewrite which would erase it.
    expect(slot).toMatchObject({
      entry_kind: 'pokemon',
      pokemon_number: 7,
      assigned_card_id: 'squirtle-1',
    });
  });

  it("converts an empty pocket into this card's exact-card target and fills it, in one step", async () => {
    const db = setup();
    const created = await createBinder(db, 'owner', 'Binder', { kind: '2x2', rows: 2, columns: 2 });
    const [binder] = await listBinders(db, 'owner');
    if (!binder?.activeVersionId) throw new Error('missing_version');
    const pageId = await firstPageId(db, binder.activeVersionId);
    await placeCard(
      db,
      'owner',
      'squirtle-1',
      binder.id,
      `${pageId}:0:0`,
      true,
      created.version.revision,
    );
    const slot = await db
      .prepare(
        `SELECT entry_kind, card_id, assigned_card_id FROM binder_slots
         WHERE binder_page_id = ?1 AND row_index = 0 AND column_index = 0`,
      )
      .bind(pageId)
      .first<{ entry_kind: string; card_id: string; assigned_card_id: string }>();
    expect(slot).toMatchObject({
      entry_kind: 'exact-card',
      card_id: 'squirtle-1',
      assigned_card_id: 'squirtle-1',
    });
    const collection = await db
      .prepare('SELECT quantity FROM collection_cards WHERE owner_id = ?1 AND card_id = ?2')
      .bind('owner', 'squirtle-1')
      .first<{ quantity: number }>();
    expect(collection?.quantity).toBe(1);
  });

  it('converts an empty pocket into an exact-card target from an existing loose copy (addCopy false)', async () => {
    const db = setup();
    const created = await createBinder(db, 'owner', 'Binder', { kind: '2x2', rows: 2, columns: 2 });
    const [binder] = await listBinders(db, 'owner');
    if (!binder?.activeVersionId) throw new Error('missing_version');
    const pageId = await firstPageId(db, binder.activeVersionId);
    await setCollectionState(db, 'owner', {
      cardId: 'squirtle-1',
      mutationId: crypto.randomUUID(),
      expectedRevision: 0,
      quantity: 1,
      notes: null,
    });
    await placeCard(
      db,
      'owner',
      'squirtle-1',
      binder.id,
      `${pageId}:0:0`,
      false,
      created.version.revision,
    );
    const slot = await db
      .prepare(
        `SELECT entry_kind, assigned_card_id FROM binder_slots
         WHERE binder_page_id = ?1 AND row_index = 0 AND column_index = 0`,
      )
      .bind(pageId)
      .first<{ entry_kind: string; assigned_card_id: string }>();
    expect(slot).toMatchObject({ entry_kind: 'exact-card', assigned_card_id: 'squirtle-1' });
    const collection = await db
      .prepare('SELECT quantity FROM collection_cards WHERE owner_id = ?1 AND card_id = ?2')
      .bind('owner', 'squirtle-1')
      .first<{ quantity: number }>();
    expect(collection?.quantity).toBe(1);
  });

  it('refuses converting an empty pocket without a loose copy (addCopy false, none owned)', async () => {
    const db = setup();
    const created = await createBinder(db, 'owner', 'Binder', { kind: '2x2', rows: 2, columns: 2 });
    const [binder] = await listBinders(db, 'owner');
    if (!binder?.activeVersionId) throw new Error('missing_version');
    const pageId = await firstPageId(db, binder.activeVersionId);
    // Real D1 surfaces this as a typed binder_assignment_quantity_exceeded
    // error; node:sqlite doesn't reproduce that message-based translation
    // (see the atomicity test above), so this only checks that it rejects
    // and, more importantly, that the slot is never left half-converted.
    await expect(
      placeCard(
        db,
        'owner',
        'squirtle-1',
        binder.id,
        `${pageId}:0:0`,
        false,
        created.version.revision,
      ),
    ).rejects.toThrow();
    const slot = await db
      .prepare(
        `SELECT entry_kind FROM binder_slots
         WHERE binder_page_id = ?1 AND row_index = 0 AND column_index = 0`,
      )
      .bind(pageId)
      .first<{ entry_kind: string }>();
    expect(slot?.entry_kind).toBe('empty');
  });

  it('increments the collection when addCopy is true', async () => {
    const db = setup();
    const created = await createBinder(db, 'owner', 'Binder', { kind: '2x2', rows: 2, columns: 2 });
    const [binder] = await listBinders(db, 'owner');
    if (!binder?.activeVersionId) throw new Error('missing_version');
    await insertBinderEntries(
      db,
      'owner',
      binder.activeVersionId,
      { page: 0, row: 0, column: 0 },
      [{ kind: 'pokemon', pokemonNumber: 7, startsNewPage: false }],
      created.version.revision,
    );
    const pageId = await firstPageId(db, binder.activeVersionId);
    await placeCard(
      db,
      'owner',
      'squirtle-1',
      binder.id,
      `${pageId}:0:0`,
      true,
      created.version.revision + 1,
    );
    const collection = await db
      .prepare('SELECT quantity FROM collection_cards WHERE owner_id = ?1 AND card_id = ?2')
      .bind('owner', 'squirtle-1')
      .first<{ quantity: number }>();
    expect(collection?.quantity).toBe(1);
  });

  it('leaves the collection quantity untouched when the slot assignment fails', async () => {
    const db = setup();
    const created = await createBinder(db, 'owner', 'Binder', { kind: '2x2', rows: 2, columns: 2 });
    const [binder] = await listBinders(db, 'owner');
    if (!binder?.activeVersionId) throw new Error('missing_version');
    const inserted = await insertBinderEntries(
      db,
      'owner',
      binder.activeVersionId,
      { page: 0, row: 0, column: 0 },
      [
        { kind: 'pokemon', pokemonNumber: 7, startsNewPage: false },
        { kind: 'pokemon', pokemonNumber: 7, startsNewPage: false },
      ],
      created.version.revision,
    );
    const pageId = await firstPageId(db, binder.activeVersionId);
    // Deliberately inconsistent seed (bypassing the normal assign path): slot
    // (0,0) already holds this printing while the owner's quantity is still
    // 0. That makes the assignment-capacity assertion for slot (0,1) fail
    // predictably - assigned-elsewhere(1) is not less than quantity(0) plus
    // the copy this batch is about to add(1) - so the batch is guaranteed to
    // reject without depending on which specific statement D1 reports.
    await db
      .prepare(
        `UPDATE binder_slots SET assigned_card_id = 'squirtle-1'
         WHERE binder_page_id = ?1 AND row_index = 0 AND column_index = 0`,
      )
      .bind(pageId)
      .run();
    // Because the increment and the assignment share one D1 batch(), that
    // failure must roll back the increment too, not just refuse the placement.
    await expect(
      placeCard(
        db,
        'owner',
        'squirtle-1',
        binder.id,
        `${pageId}:0:1`,
        true,
        inserted.version.revision,
      ),
    ).rejects.toThrow();
    const collection = await db
      .prepare('SELECT quantity FROM collection_cards WHERE owner_id = ?1 AND card_id = ?2')
      .bind('owner', 'squirtle-1')
      .first<{ quantity: number } | null>();
    expect(collection).toBeNull();
  });
});

describe('listInactiveBinderTargets', () => {
  it('lists a binder slot pointing at an inactive (Pocket) card without removing it', async () => {
    const db = setup();
    const created = await createBinder(db, 'owner', 'Binder', { kind: '2x2', rows: 2, columns: 2 });
    const [binder] = await listBinders(db, 'owner');
    if (!binder?.activeVersionId) throw new Error('missing_version');
    await insertBinderEntries(
      db,
      'owner',
      binder.activeVersionId,
      { page: 0, row: 0, column: 0 },
      [{ kind: 'exact-card', cardId: cardIdSchema.parse('pocket-mon'), startsNewPage: false }],
      created.version.revision,
    );
    const targets = await listInactiveBinderTargets(db, 'owner');
    expect(targets).toEqual([
      expect.objectContaining({ binderId: binder.id, cardId: 'pocket-mon', row: 0, column: 0 }),
    ]);
    const stillThere = await db
      .prepare("SELECT card_id FROM binder_slots WHERE card_id = 'pocket-mon'")
      .first();
    expect(stillThere).toBeTruthy();
  });
});
