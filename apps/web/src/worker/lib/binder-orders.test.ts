import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { binderActivityQuerySchema } from '@pokedex/shared';
import { applyAllMigrations, sqliteD1 } from './d1-test-helper';
import {
  createBinder,
  insertBinderEntries,
  setBinderOrderStatus,
  getBinderVersion,
  getBinderPlannerSummary,
  moveBinderEntryByOffset,
  cloneBinderVersion,
  setBinderSlot,
} from './binders';
import { createBinderCheckpoint, getBinderActivity } from './binder-activity';
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const d of databases.splice(0)) d.close();
});
async function setup() {
  const raw = new DatabaseSync(':memory:');
  databases.push(raw);
  raw.exec('PRAGMA foreign_keys=ON');
  applyAllMigrations(raw);
  raw.exec(
    `INSERT INTO users(id,label,created_at) VALUES('owner','Owner',1),('other','Other',1);INSERT INTO catalogue_cards(id,name,language,category,set_id,set_name,number,pokedex_number,created_at,updated_at) VALUES('squirtle','Squirtle','en','pokemon','base','Base','63',7,1,1),('bulbasaur','Bulbasaur','en','pokemon','base','Base','1',1,1,1);`,
  );
  const db = sqliteD1(raw);
  const created = await createBinder(
    db,
    'owner',
    'Orders',
    { kind: '2x2', rows: 2, columns: 2 },
    8,
  );
  const binder = await insertBinderEntries(
    db,
    'owner',
    created.version.id,
    { page: 0, row: 0, column: 0 },
    [{ kind: 'pokemon', pokemonNumber: 7, startsNewPage: false }],
    created.version.revision,
  );
  const versionId = binder.version.id;
  const revision = async () =>
    (await getBinderVersion(db, 'owner', versionId, 0, 1)).version.revision;
  const order = async (status: 'ordered' | 'received' | 'cancelled', cardId = 'squirtle') =>
    setBinderOrderStatus(
      db,
      'owner',
      versionId,
      { page: 0, row: 0, column: 0 },
      cardId,
      status,
      await revision(),
    );
  const qty = () =>
    raw
      .prepare(
        "SELECT COALESCE((SELECT quantity FROM collection_cards WHERE owner_id='owner' AND card_id='squirtle'),0) AS n",
      )
      .get()?.n;
  const activity = (query: Record<string, string> = {}) =>
    getBinderActivity(db, 'owner', binder.version.binderId, binderActivityQuerySchema.parse(query));
  return { db, raw, binder, versionId, revision, order, qty, activity };
}
it('covers the target without inventing owned copies and receives exactly one copy atomically', async () => {
  const s = await setup();
  await s.order('ordered');
  expect(s.qty()).toBe(0);
  expect(await getBinderPlannerSummary(s.db, 'owner', s.versionId)).toMatchObject({
    targets: 1,
    placed: 0,
    ordered: 1,
  });
  const received = await s.order('received');
  expect(s.qty()).toBe(1);
  expect(received.pages[0]?.slots[0]).toMatchObject({
    entryKind: 'pokemon',
    pokemonNumber: 7,
    assignedCardId: 'squirtle',
    orderedCardId: null,
  });
  expect(
    s.raw
      .prepare('SELECT kind FROM binder_activity ORDER BY id')
      .all()
      .map((r) => r.kind),
  ).toEqual(['ordered', 'received']);
  await s.order('received');
  expect(s.qty()).toBe(1);
  await s.order('ordered');
  await s.order('received');
  expect(s.qty()).toBe(1);
});
it('shows outstanding orders across checkpoints and clears them when received or cancelled', async () => {
  const s = await setup();
  await s.order('ordered');
  await createBinderCheckpoint(s.db, 'owner', s.binder.version.binderId);
  expect((await s.activity({ kind: 'ordered' })).events).toHaveLength(1);
  expect((await s.activity({ kind: 'ordered', batch: 'beginning' })).events).toHaveLength(1);
  await s.order('received');
  expect((await s.activity({ kind: 'ordered' })).total).toBe(0);
  expect((await s.activity({ kind: 'received' })).total).toBe(1);
  await s.order('ordered');
  await s.order('cancelled');
  expect((await s.activity({ kind: 'ordered' })).total).toBe(0);
  expect(s.qty()).toBe(1);
  expect(
    (await getBinderVersion(s.db, 'owner', s.versionId, 0, 1)).pages[0]?.slots[0],
  ).toMatchObject({ pokemonNumber: 7, cardId: null, assignedCardId: null, orderedCardId: null });
});
it('rejects stale writes, wrong owners and incompatible cards without changing inventory', async () => {
  const s = await setup();
  const old = await s.revision();
  await s.order('ordered');
  await expect(
    setBinderOrderStatus(
      s.db,
      'owner',
      s.versionId,
      { page: 0, row: 0, column: 0 },
      'squirtle',
      'received',
      old,
    ),
  ).rejects.toMatchObject({ code: 'binder_revision_conflict' });
  await expect(
    setBinderOrderStatus(
      s.db,
      'other',
      s.versionId,
      { page: 0, row: 0, column: 0 },
      'squirtle',
      'received',
      await s.revision(),
    ),
  ).rejects.toMatchObject({ code: 'binder_version_not_found' });
  await expect(s.order('ordered', 'bulbasaur')).rejects.toMatchObject({
    code: 'binder_assignment_incompatible',
  });
  expect(s.qty()).toBe(0);
  expect((await s.activity({ kind: 'ordered' })).total).toBe(1);
});
it('keeps order metadata attached through moves and draft cloning without duplicating physical stock', async () => {
  const s = await setup();
  await s.order('ordered');
  await moveBinderEntryByOffset(
    s.db,
    'owner',
    s.versionId,
    { page: 0, row: 0, column: 0 },
    1,
    await s.revision(),
  );
  const outstanding = await s.activity({ kind: 'ordered' });
  expect(outstanding.events[0]).toMatchObject({ row: 0, column: 1, cardId: 'squirtle' });
  const draft = await cloneBinderVersion(s.db, 'owner', s.versionId, await s.revision());
  expect(draft.pages[0]?.slots[1]?.orderedCardId).toBe('squirtle');
  expect((await s.activity({ kind: 'ordered' })).total).toBe(1);
  expect(s.qty()).toBe(0);
  await expect(
    setBinderOrderStatus(
      s.db,
      'owner',
      draft.version.id,
      { page: 0, row: 0, column: 1 },
      'squirtle',
      'received',
      draft.version.revision,
    ),
  ).rejects.toMatchObject({ code: 'binder_order_active_only' });
});
it('cancels an order when its target is explicitly removed', async () => {
  const s = await setup();
  await s.order('ordered');
  await setBinderSlot(s.db, 'owner', s.versionId, 0, 0, 0, null, await s.revision());
  expect((await s.activity({ kind: 'ordered' })).total).toBe(0);
  expect(
    s.raw.prepare("SELECT COUNT(*) AS n FROM binder_activity WHERE kind='cancelled'").get()?.n,
  ).toBe(1);
  expect(s.qty()).toBe(0);
});
it('does not invent another copy if a previously owned order copy was removed elsewhere', async () => {
  const s = await setup();
  await s.order('ordered');
  await s.order('received');
  await s.order('ordered');
  s.raw
    .prepare("UPDATE collection_cards SET quantity=0 WHERE owner_id='owner' AND card_id='squirtle'")
    .run();
  await expect(s.order('received')).rejects.toMatchObject({
    code: 'binder_order_copy_unavailable',
  });
  expect(s.qty()).toBe(0);
  expect((await s.activity({ kind: 'ordered' })).total).toBe(1);
});
