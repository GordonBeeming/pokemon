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
  it('reports an exact-card target as already placed', async () => {
    const db = setup();
    const created = await createBinder(db, 'owner', 'Binder', { kind: '2x2', rows: 2, columns: 2 });
    const [binder] = await listBinders(db, 'owner');
    if (!binder?.activeVersionId) throw new Error('missing_version');
    await insertBinderEntries(
      db,
      'owner',
      binder.activeVersionId,
      { page: 0, row: 0, column: 0 },
      [{ kind: 'exact-card', cardId: cardIdSchema.parse('squirtle-1'), startsNewPage: false }],
      created.version.revision,
    );
    const matches = await getCardBinderMatches(db, 'owner', 'squirtle-1');
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      binderId: binder.id,
      exactTargets: [expect.objectContaining({ row: 0, col: 0 })],
      placed: [expect.objectContaining({ row: 0, col: 0 })],
    });
  });

  it('reports an unfilled pokemon target as the end destination, not placed', async () => {
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
    expect(matches[0]?.pokemonTargets).toHaveLength(1);
    expect(matches[0]?.placed).toHaveLength(0);
    expect(matches[0]?.endDestination).toMatchObject({ row: 0, col: 0 });
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
