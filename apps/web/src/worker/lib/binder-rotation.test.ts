import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { applyAllMigrations, sqliteD1 } from './d1-test-helper';
import {
  createBinder,
  setBinderSlot,
  setBinderSlotRotation,
  getBinderVersion,
  cloneBinderVersion,
  swapBinderSlots,
  insertBinderEntries,
} from './binders';
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const d of databases.splice(0)) d.close();
});
async function setup() {
  const raw = new DatabaseSync(':memory:');
  databases.push(raw);
  applyAllMigrations(raw);
  raw.exec(`INSERT INTO users(id,label,created_at) VALUES('owner','Owner',1),('other','Other',1);
 INSERT INTO catalogue_cards(id,name,language,category,set_id,set_name,number,pokedex_number,created_at,updated_at)
 VALUES('legend','Darkrai & Cresselia LEGEND','en','pokemon','test','Test','19',488,1,1);
 INSERT INTO collection_cards(owner_id,card_id,quantity,revision,updated_at)VALUES('owner','legend',1,1,1);`);
  const db = sqliteD1(raw);
  const b = await createBinder(db, 'owner', 'Legends', { kind: '3x3', rows: 3, columns: 3 }, 18);
  const placed = await setBinderSlot(
    db,
    'owner',
    b.version.id,
    0,
    0,
    0,
    'legend',
    b.version.revision,
    { action: 'existing' },
  );
  return { raw, db, b, placed };
}
it('persists quarter-turns without changing owned quantities, targets or activity', async () => {
  const { raw, db, b, placed } = await setup();
  const before = raw.prepare('SELECT COUNT(*) AS n FROM binder_activity').get();
  let revision = placed.version.revision;
  for (const rotation of [90, 180, 270, 0]) {
    const result = await setBinderSlotRotation(
      db,
      'owner',
      b.version.id,
      { page: 0, row: 0, column: 0 },
      rotation,
      revision,
    );
    revision = result.version.revision;
    const slot = (await getBinderVersion(db, 'owner', b.version.id, 0, 1)).pages[0]?.slots[0];
    expect(slot?.rotation ?? 0).toBe(rotation);
    expect(slot).toMatchObject({ cardId: 'legend', assignedCardId: 'legend' });
  }
  expect(
    raw
      .prepare("SELECT quantity FROM collection_cards WHERE owner_id='owner' AND card_id='legend'")
      .get(),
  ).toEqual({ quantity: 1 });
  expect(raw.prepare('SELECT COUNT(*) AS n FROM binder_activity').get()).toEqual(before);
});
it('enforces owner, revision, rotation bounds, archived versions and cards being present', async () => {
  const { db, b, placed, raw } = await setup();
  const at = { page: 0, row: 0, column: 0 };
  await expect(
    setBinderSlotRotation(db, 'other', b.version.id, at, 90, placed.version.revision),
  ).rejects.toMatchObject({ code: 'binder_version_not_found' });
  await expect(setBinderSlotRotation(db, 'owner', b.version.id, at, 90, 0)).rejects.toMatchObject({
    code: 'binder_revision_conflict',
  });
  await expect(
    setBinderSlotRotation(db, 'owner', b.version.id, at, 45, placed.version.revision),
  ).rejects.toMatchObject({ code: 'binder_rotation_invalid' });
  await expect(
    setBinderSlotRotation(
      db,
      'owner',
      b.version.id,
      { ...at, column: 1 },
      90,
      placed.version.revision,
    ),
  ).rejects.toMatchObject({ code: 'binder_rotation_unavailable' });
  raw.prepare("UPDATE binder_versions SET status='archived' WHERE id=?").run(b.version.id);
  await expect(
    setBinderSlotRotation(db, 'owner', b.version.id, at, 90, placed.version.revision),
  ).rejects.toMatchObject({ code: 'binder_version_archived' });
});
it('keeps rotation through version cloning, page swaps and target reflow', async () => {
  const { db, b, placed } = await setup();
  const rotated = await setBinderSlotRotation(
    db,
    'owner',
    b.version.id,
    { page: 0, row: 0, column: 0 },
    90,
    placed.version.revision,
  );
  const clone = await cloneBinderVersion(db, 'owner', b.version.id);
  expect(clone.pages[0]?.slots[0]?.rotation).toBe(90);
  const swapped = await swapBinderSlots(
    db,
    'owner',
    b.version.id,
    { page: 0, row: 0, column: 0 },
    { page: 1, row: 0, column: 0 },
    rotated.version.revision,
  );
  expect(
    (await getBinderVersion(db, 'owner', b.version.id, 1, 1)).pages[0]?.slots[0]?.rotation,
  ).toBe(90);
  await insertBinderEntries(
    db,
    'owner',
    b.version.id,
    { page: 0, row: 0, column: 0 },
    [{ kind: 'pokemon', pokemonNumber: 25, startsNewPage: false }],
    swapped.version.revision,
  );
  const all = (await getBinderVersion(db, 'owner', b.version.id, 0, 2)).pages.flatMap(
    (p) => p.slots,
  );
  expect(all.find((s) => s.assignedCardId === 'legend')?.rotation).toBe(90);
});

it('resets rotation when replacing or clearing a target but keeps it for the same printing', async () => {
  const { db, b, placed, raw } = await setup();
  raw.exec(
    "INSERT INTO catalogue_cards(id,name,language,category,set_id,set_name,number,pokedex_number,created_at,updated_at)VALUES('portrait','Pikachu','en','pokemon','test','Test','25',25,1,1)",
  );
  const rotated = await setBinderSlotRotation(
    db,
    'owner',
    b.version.id,
    { page: 0, row: 0, column: 0 },
    90,
    placed.version.revision,
  );
  const same = await setBinderSlot(
    db,
    'owner',
    b.version.id,
    0,
    0,
    0,
    'legend',
    rotated.version.revision,
  );
  expect(same.pages[0]?.slots[0]?.rotation).toBe(90);
  const replaced = await setBinderSlot(
    db,
    'owner',
    b.version.id,
    0,
    0,
    0,
    'portrait',
    same.version.revision,
  );
  expect(replaced.pages[0]?.slots[0]?.rotation ?? 0).toBe(0);
  const turned = await setBinderSlotRotation(
    db,
    'owner',
    b.version.id,
    { page: 0, row: 0, column: 0 },
    180,
    replaced.version.revision,
  );
  const cleared = await setBinderSlot(
    db,
    'owner',
    b.version.id,
    0,
    0,
    0,
    null,
    turned.version.revision,
  );
  expect(cleared.pages[0]?.slots[0]?.rotation ?? 0).toBe(0);
});
