import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createBinder,
  insertBinderEntries,
  listBinders,
  setBinderEntryAssignment,
} from './binders';
import { CollectionDomainError, removeCollectionCopy, setCollectionState } from './collection';
import { applyAllMigrations, sqliteD1 } from './d1-test-helper';

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

async function setup(quantity: number): Promise<D1Database> {
  const raw = new DatabaseSync(':memory:');
  databases.push(raw);
  applyAllMigrations(raw);
  raw.exec(`
    INSERT INTO users(id,label,created_at) VALUES('owner','Owner',1);
    INSERT INTO catalogue_cards(id,name,language,category,set_id,set_name,number,pokedex_number,created_at,updated_at)
    VALUES ('card-1','Squirtle','en','pokemon','base','Base','1',7,1,1);
  `);
  const db = sqliteD1(raw);
  await setCollectionState(db, 'owner', {
    cardId: 'card-1',
    mutationId: crypto.randomUUID(),
    expectedRevision: 0,
    quantity,
    notes: null,
  });
  return db;
}

/** Creates a binder with one pokemon-kind pocket (dex #7, Squirtle) at (0,0,0)
 * and assigns card-1 to it, returning the binder id and the pocket's slotId. */
async function binderWithAssignedPocket(
  db: D1Database,
): Promise<{ binderId: string; slotId: string }> {
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
  const assigned = await setBinderEntryAssignment(
    db,
    'owner',
    binder.activeVersionId,
    { page: 0, row: 0, column: 0 },
    'card-1',
    created.version.revision + 1,
  );
  void assigned;
  const page = await db
    .prepare(
      `SELECT page.id FROM binder_pages page
       JOIN binder_versions version ON version.id = page.binder_version_id
       WHERE version.id = ?1 ORDER BY page.position LIMIT 1`,
    )
    .bind(binder.activeVersionId)
    .first<{ id: string }>();
  if (!page) throw new Error('page_not_found');
  return { binderId: binder.id, slotId: `${page.id}:0:0` };
}

async function eventCount(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS count FROM collection_events').first<{
    count: number;
  }>();
  return row?.count ?? 0;
}

describe('removeCollectionCopy', () => {
  it('removes a loose copy', async () => {
    const db = await setup(2);
    const state = await removeCollectionCopy(db, 'owner', 'card-1', { source: 'loose' });
    expect(state.quantity).toBe(1);
    expect(await eventCount(db)).toBe(2); // the initial "set" event plus this removal
  });

  it('refuses loose removal when every copy is placed', async () => {
    const db = await setup(1);
    await binderWithAssignedPocket(db);
    await expect(removeCollectionCopy(db, 'owner', 'card-1', { source: 'loose' })).rejects.toThrow(
      CollectionDomainError,
    );
  });

  it('unassigns the named pocket and decrements for a pocket removal', async () => {
    const db = await setup(1);
    const { slotId } = await binderWithAssignedPocket(db);
    const state = await removeCollectionCopy(db, 'owner', 'card-1', { source: 'pocket', slotId });
    expect(state.quantity).toBe(0);
    const assigned = await db
      .prepare("SELECT COUNT(*) AS count FROM binder_slots WHERE assigned_card_id = 'card-1'")
      .first<{ count: number }>();
    expect(assigned?.count).toBe(0);
  });

  it('refuses a pocket removal for a slot that is not actually assigned to this card', async () => {
    const db = await setup(1);
    const { binderId } = await binderWithAssignedPocket(db);
    void binderId;
    await expect(
      removeCollectionCopy(db, 'owner', 'card-1', { source: 'pocket', slotId: 'page-missing:9:9' }),
    ).rejects.toMatchObject({ code: 'collection_remove_slot_not_found' });
  });

  it('miscount takes a loose copy first when one exists', async () => {
    const db = await setup(2);
    await binderWithAssignedPocket(db);
    const state = await removeCollectionCopy(db, 'owner', 'card-1', { source: 'miscount' });
    expect(state.quantity).toBe(1);
    // the pocket assignment must survive: the loose copy was the one removed
    const assigned = await db
      .prepare("SELECT COUNT(*) AS count FROM binder_slots WHERE assigned_card_id = 'card-1'")
      .first<{ count: number }>();
    expect(assigned?.count).toBe(1);
  });

  it('miscount with nothing loose requires a slotId and lists candidates when missing', async () => {
    const db = await setup(1);
    const { binderId } = await binderWithAssignedPocket(db);
    try {
      await removeCollectionCopy(db, 'owner', 'card-1', { source: 'miscount' });
      expect.unreachable('expected a slot-required error');
    } catch (error) {
      expect(error).toBeInstanceOf(CollectionDomainError);
      const domainError = error as CollectionDomainError;
      expect(domainError.code).toBe('collection_remove_slot_required');
      expect(domainError.details).toMatchObject({
        candidates: [expect.objectContaining({ binderId })],
      });
    }
  });

  it('miscount with nothing loose and a slotId empties that pocket', async () => {
    const db = await setup(1);
    const { slotId } = await binderWithAssignedPocket(db);
    const state = await removeCollectionCopy(db, 'owner', 'card-1', { source: 'miscount', slotId });
    expect(state.quantity).toBe(0);
  });

  it('never lets quantity drop below zero', async () => {
    const db = await setup(0);
    await expect(removeCollectionCopy(db, 'owner', 'card-1', { source: 'loose' })).rejects.toThrow(
      CollectionDomainError,
    );
  });
});
