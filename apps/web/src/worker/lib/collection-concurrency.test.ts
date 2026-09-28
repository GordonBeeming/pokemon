import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  activateBinderVersion,
  arrangeBinderVersion,
  cloneBinderVersion,
  placeCard,
  setBinderSlot,
} from './binders';
import {
  incrementCollectionQuantity,
  removeCollectionCopy,
  setCollectionState,
  type CollectionRemoveInput,
} from './collection';
import { applyAllMigrations, sqliteD1 } from './d1-test-helper';
import { encodeSlotId } from './db';

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

const OWNER = 'owner';
const CARD = 'card-1';
const BINDER = 'binder-1';
const VERSION = 'version-1';
const PAGE = 'page-1';
const POCKET = encodeSlotId(PAGE, 0, 0);

/**
 * One owner holding `quantity` copies of card-1, one of them assigned to
 * pocket (0,0) of an active 2x2 binder whose version sits at `revision`.
 */
function setup(quantity: number, revision = 3): { raw: DatabaseSync; db: D1Database } {
  const raw = new DatabaseSync(':memory:');
  databases.push(raw);
  applyAllMigrations(raw);
  raw.exec(`
    INSERT INTO users (id, label, created_at) VALUES ('${OWNER}', 'Owner', 1);
    INSERT INTO catalogue_cards
      (id, name, language, category, set_id, set_name, number, number_sort, pokedex_number, created_at, updated_at)
    VALUES
      ('${CARD}', 'Squirtle', 'en', 'pokemon', 'base', 'Base', '1', 1, 7, 1, 1),
      ('card-2', 'Bulbasaur', 'en', 'pokemon', 'base', 'Base', '2', 2, 1, 1, 1);
    INSERT INTO collection_cards (owner_id, card_id, quantity, revision, updated_at)
    VALUES ('${OWNER}', '${CARD}', ${quantity}, 1, 1);
    INSERT INTO binders (id, owner_id, name, created_at, updated_at)
    VALUES ('${BINDER}', '${OWNER}', 'Binder', 1, 1);
    INSERT INTO binder_versions
      (id, binder_id, version_number, status, layout_kind, rows, columns, capacity, created_at, revision)
    VALUES ('${VERSION}', '${BINDER}', 1, 'active', '2x2', 2, 2, 4, 1, ${revision});
    UPDATE binders SET active_version_id = '${VERSION}' WHERE id = '${BINDER}';
    INSERT INTO binder_pages (id, binder_version_id, position) VALUES ('${PAGE}', '${VERSION}', 0);
    INSERT INTO binder_slots (binder_page_id, row_index, column_index, card_id, assigned_card_id, entry_kind)
    VALUES
      ('${PAGE}', 0, 0, '${CARD}', '${CARD}', 'exact-card'),
      ('${PAGE}', 0, 1, 'card-2', NULL, 'exact-card'),
      ('${PAGE}', 1, 0, NULL, NULL, 'empty'),
      ('${PAGE}', 1, 1, NULL, NULL, 'empty');
  `);
  return { raw, db: sqliteD1(raw) };
}

/**
 * A D1 whose next batch() parks until released, so a test can let one
 * operation finish all of its reads, run a competing operation to completion,
 * then let the first one commit: the exact interleaving two concurrent
 * requests can produce, without relying on timing.
 */
function pausedAtBatch(inner: D1Database): {
  db: D1Database;
  arrived: Promise<void>;
  release: () => void;
} {
  let signalArrived: () => void = () => undefined;
  let release: () => void = () => undefined;
  const arrived = new Promise<void>((resolve) => {
    signalArrived = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let paused = false;
  const db = {
    prepare: (query: string) => inner.prepare(query),
    exec: (query: string) => inner.exec(query),
    dump: () => inner.dump(),
    batch: async <T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
      if (!paused) {
        paused = true;
        signalArrived();
        await gate;
      }
      return inner.batch<T>(statements);
    },
  } as unknown as D1Database;
  return { db, arrived, release };
}

async function interleave<T>(
  inner: D1Database,
  first: (db: D1Database) => Promise<T>,
  second: (db: D1Database) => Promise<unknown>,
): Promise<{ first: PromiseSettledResult<T>; second: PromiseSettledResult<unknown> }> {
  const paused = pausedAtBatch(inner);
  const pending = first(paused.db).then(
    (value): PromiseSettledResult<T> => ({ status: 'fulfilled', value }),
    (reason: unknown): PromiseSettledResult<T> => ({ status: 'rejected', reason }),
  );
  await paused.arrived;
  const secondResult = await second(inner).then(
    (value): PromiseSettledResult<unknown> => ({ status: 'fulfilled', value }),
    (reason: unknown): PromiseSettledResult<unknown> => ({ status: 'rejected', reason }),
  );
  paused.release();
  return { first: await pending, second: secondResult };
}

function snapshot(raw: DatabaseSync): Record<string, unknown[]> {
  return Object.fromEntries(
    [
      'SELECT * FROM collection_cards ORDER BY owner_id, card_id',
      'SELECT * FROM collection_events ORDER BY id',
      'SELECT * FROM collection_mutations ORDER BY owner_id, mutation_id',
      'SELECT * FROM binders ORDER BY id',
      'SELECT * FROM binder_versions ORDER BY id',
      'SELECT * FROM binder_pages ORDER BY id',
      'SELECT * FROM binder_slots ORDER BY binder_page_id, row_index, column_index',
    ].map((sql) => [sql, raw.prepare(sql).all()]),
  );
}

function inventory(raw: DatabaseSync): { quantity: unknown; assigned: unknown; events: unknown } {
  const quantity = raw
    .prepare('SELECT quantity FROM collection_cards WHERE owner_id = ? AND card_id = ?')
    .get(OWNER, CARD);
  const assigned = raw
    .prepare(
      `SELECT COUNT(*) AS count FROM binder_slots slot
       JOIN binder_pages page ON page.id = slot.binder_page_id
       JOIN binder_versions version ON version.id = page.binder_version_id
       WHERE version.status = 'active' AND slot.assigned_card_id = ?`,
    )
    .get(CARD);
  const events = raw
    .prepare('SELECT delta, source FROM collection_events WHERE card_id = ? ORDER BY created_at')
    .all(CARD);
  return { quantity, assigned, events };
}

const remove = (input: CollectionRemoveInput) => (db: D1Database) =>
  removeCollectionCopy(db, OWNER, CARD, input);

describe('concurrent removals re-check live inventory inside the batch', () => {
  it('two loose removals with one loose copy: one lands, the other changes nothing', async () => {
    const { raw, db } = setup(2);
    const results = await interleave(db, remove({ source: 'loose' }), remove({ source: 'loose' }));
    expect(results.second.status).toBe('fulfilled');
    expect(results.first).toMatchObject({
      status: 'rejected',
      reason: { code: 'collection_remove_no_loose_copies' },
    });
    expect(inventory(raw)).toEqual({
      quantity: { quantity: 1 },
      assigned: { count: 1 },
      events: [{ delta: -1, source: 'loose' }],
    });
  });

  it('two removals of the same pocket: one unassigns and decrements, the other changes nothing', async () => {
    const { raw, db } = setup(2);
    const results = await interleave(
      db,
      remove({ source: 'pocket', slotId: POCKET }),
      remove({ source: 'pocket', slotId: POCKET }),
    );
    expect(results.second.status).toBe('fulfilled');
    expect(results.first).toMatchObject({
      status: 'rejected',
      reason: { code: 'collection_remove_slot_not_found' },
    });
    expect(inventory(raw)).toEqual({
      quantity: { quantity: 1 },
      assigned: { count: 0 },
      events: [{ delta: -1, source: 'pocket' }],
    });
  });

  it('a loose removal racing a quantity set leaves the set result untouched', async () => {
    const { raw, db } = setup(2);
    const results = await interleave(db, remove({ source: 'loose' }), (inner) =>
      setCollectionState(inner, OWNER, {
        cardId: CARD,
        mutationId: crypto.randomUUID(),
        expectedRevision: 1,
        quantity: 1,
        notes: null,
      }),
    );
    expect(results.second.status).toBe('fulfilled');
    expect(results.first).toMatchObject({
      status: 'rejected',
      reason: { code: 'collection_remove_no_loose_copies' },
    });
    expect(inventory(raw)).toEqual({
      quantity: { quantity: 1 },
      assigned: { count: 1 },
      events: [{ delta: -1, source: 'set' }],
    });
  });
});

describe('pocket removal is a binder edit', () => {
  it('advances the version revision so a stale arrange cannot restore the removed assignment', async () => {
    const { raw, db } = setup(1, 3);
    const results = await interleave(
      db,
      (paused) => arrangeBinderVersion(paused, OWNER, VERSION, 'set-number', 3),
      remove({ source: 'pocket', slotId: POCKET }),
    );
    expect(results.second.status).toBe('fulfilled');
    expect(results.first).toMatchObject({
      status: 'rejected',
      reason: { code: 'binder_revision_conflict' },
    });
    expect(raw.prepare('SELECT revision FROM binder_versions WHERE id = ?').get(VERSION)).toEqual({
      revision: 4,
    });
    expect(inventory(raw)).toMatchObject({ quantity: { quantity: 0 }, assigned: { count: 0 } });
  });
});

describe("pocket removal only accepts a pocket in the owner's current active version", () => {
  async function withArchivedAndDraft(db: D1Database): Promise<{
    archivedSlot: string;
    draftSlot: string;
  }> {
    const firstClone = await cloneBinderVersion(db, OWNER, VERSION, 3);
    const activated = await activateBinderVersion(
      db,
      OWNER,
      firstClone.version.id,
      firstClone.version.revision,
    );
    const draft = await cloneBinderVersion(
      db,
      OWNER,
      activated.version.id,
      activated.version.revision,
    );
    const pageOf = async (versionId: string): Promise<string> => {
      const page = await db
        .prepare('SELECT id FROM binder_pages WHERE binder_version_id = ?1 AND position = 0')
        .bind(versionId)
        .first<{ id: string }>();
      if (!page) throw new Error('page_not_found');
      return page.id;
    };
    return {
      archivedSlot: encodeSlotId(PAGE, 0, 0),
      draftSlot: encodeSlotId(await pageOf(draft.version.id), 0, 0),
    };
  }

  it.each(['archived', 'draft'] as const)(
    'refuses a %s pocket and changes nothing',
    async (which) => {
      const { raw, db } = setup(1);
      const slots = await withArchivedAndDraft(db);
      expect(raw.prepare('SELECT status FROM binder_versions WHERE id = ?').get(VERSION)).toEqual({
        status: 'archived',
      });
      const before = snapshot(raw);
      const slotId = which === 'archived' ? slots.archivedSlot : slots.draftSlot;
      for (const source of ['pocket', 'miscount'] as const)
        await expect(
          removeCollectionCopy(db, OWNER, CARD, { source, slotId }),
        ).rejects.toMatchObject({ code: 'collection_remove_slot_not_found' });
      expect(snapshot(raw)).toEqual(before);
    },
  );
});

describe('collection_events only records mutations that applied', () => {
  it('an increment refused at the 9999 cap writes no event and changes nothing', async () => {
    const { raw, db } = setup(1);
    raw.exec(`UPDATE collection_cards SET quantity = 9999 WHERE card_id = '${CARD}'`);
    const before = snapshot(raw);
    await expect(
      incrementCollectionQuantity(db, OWNER, {
        cardId: CARD,
        mutationId: crypto.randomUUID(),
        delta: 1,
      }),
    ).rejects.toMatchObject({ code: 'collection_quantity_out_of_bounds' });
    expect(snapshot(raw)).toEqual(before);
  });

  it('a set that loses a revision race writes no event', async () => {
    const { raw, db } = setup(1);
    const set = (quantity: number) => (inner: D1Database) =>
      setCollectionState(inner, OWNER, {
        cardId: CARD,
        mutationId: crypto.randomUUID(),
        expectedRevision: 1,
        quantity,
        notes: null,
      });
    const results = await interleave(db, set(5), set(3));
    expect(results.second.status).toBe('fulfilled');
    expect(results.first).toMatchObject({
      status: 'rejected',
      reason: { code: 'collection_revision_conflict' },
    });
    expect(inventory(raw)).toMatchObject({
      quantity: { quantity: 3 },
      events: [{ delta: 2, source: 'set' }],
    });
  });

  it('a successful increment still writes exactly one event', async () => {
    const { raw, db } = setup(1);
    await incrementCollectionQuantity(db, OWNER, {
      cardId: CARD,
      mutationId: crypto.randomUUID(),
      delta: 2,
    });
    expect(inventory(raw)).toMatchObject({
      quantity: { quantity: 3 },
      events: [{ delta: 2, source: 'add' }],
    });
  });
});

describe('adding a copy while placing writes its ledger row in the same batch', () => {
  const TARGET = encodeSlotId(PAGE, 0, 1);
  const EMPTY = encodeSlotId(PAGE, 1, 0);

  function ledger(raw: DatabaseSync): unknown {
    return {
      quantity: raw
        .prepare('SELECT quantity FROM collection_cards WHERE owner_id = ? AND card_id = ?')
        .get(OWNER, 'card-2'),
      events: raw
        .prepare("SELECT delta, source FROM collection_events WHERE card_id = 'card-2'")
        .all(),
    };
  }

  it.each([
    ['an existing target', TARGET],
    ['an empty pocket', EMPTY],
  ])('place with addCopy into %s records one add event', async (_name, slotId) => {
    const { raw, db } = setup(1);
    await placeCard(db, OWNER, 'card-2', BINDER, slotId, true, 3);
    expect(ledger(raw)).toEqual({
      quantity: { quantity: 1 },
      events: [{ delta: 1, source: 'add' }],
    });
  });

  it.each([
    ['an existing target', TARGET],
    ['an empty pocket', EMPTY],
  ])(
    'place with addCopy into %s at the 9999 cap is refused with a typed error and changes nothing',
    async (_name, slotId) => {
      const { raw, db } = setup(1);
      raw.exec(`INSERT INTO collection_cards (owner_id, card_id, quantity, revision, updated_at)
        VALUES ('${OWNER}', 'card-2', 9999, 1, 1)`);
      const before = snapshot(raw);
      await expect(placeCard(db, OWNER, 'card-2', BINDER, slotId, true, 3)).rejects.toMatchObject({
        code: 'collection_quantity_out_of_bounds',
      });
      expect(snapshot(raw)).toEqual(before);
    },
  );

  it('a slot set with an added copy records one add event', async () => {
    const { raw, db } = setup(1);
    await setBinderSlot(db, OWNER, VERSION, 0, 0, 1, 'card-2', 3, {
      action: 'add',
      expectedCollectionRevision: 0,
    });
    expect(ledger(raw)).toEqual({
      quantity: { quantity: 1 },
      events: [{ delta: 1, source: 'add' }],
    });
  });

  it('a slot set with an added copy that loses a binder race writes nothing', async () => {
    const { raw, db } = setup(1);
    const results = await interleave(
      db,
      (paused) =>
        setBinderSlot(paused, OWNER, VERSION, 0, 0, 1, 'card-2', 3, {
          action: 'add',
          expectedCollectionRevision: 0,
        }),
      (inner) => setBinderSlot(inner, OWNER, VERSION, 0, 1, 1, null, 3),
    );
    expect(results.second.status).toBe('fulfilled');
    expect(results.first).toMatchObject({
      status: 'rejected',
      reason: { code: 'binder_revision_conflict' },
    });
    expect(ledger(raw)).toEqual({ quantity: undefined, events: [] });
  });
});
