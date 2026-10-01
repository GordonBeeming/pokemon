import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { type BinderEntry, cardIdSchema } from '@pokedex/shared';
import {
  arrangeBinderVersion,
  cloneBinderVersion,
  createBinder,
  fillBinderPage,
  getBinderAssignmentCandidates,
  getBinderPlannerSummary,
  getBinderVersion,
  getCardBinderMatches,
  insertBinderEntries,
  placeCard,
  searchBinderSpaces,
  setBinderEntryAssignment,
  setBinderSlot,
} from './binders';
import { setCollectionState } from './collection';
import { applyAllMigrations, sqliteD1 } from './d1-test-helper';

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function setup(): { db: D1Database; raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:');
  databases.push(raw);
  applyAllMigrations(raw);
  raw.exec(`
    INSERT INTO users(id,label,created_at) VALUES('owner','Owner',1);
    INSERT INTO catalogue_cards
      (id,name,language,category,set_id,set_name,number,pokedex_number,is_active,created_at,updated_at)
    VALUES
      ('classic-1','Pikachu','en','pokemon','30th','30th Classic','1',25,1,1,1),
      ('classic-2','Charizard','en','pokemon','30th','30th Classic','2',6,1,1,1),
      ('base-1','Squirtle','en','pokemon','base','Base','1',7,1,1,1);
    INSERT OR IGNORE INTO catalogue_sets(set_id,language,set_name,updated_at)
    VALUES ('30th','en','30th Classic',1), ('base','en','Base',1);
  `);
  return { db: sqliteD1(raw), raw };
}

const classic: BinderEntry = {
  kind: 'set',
  setId: '30th',
  setLanguage: 'en',
  startsNewPage: false,
};

async function own(db: D1Database, cardId: string): Promise<void> {
  await setCollectionState(db, 'owner', {
    cardId,
    mutationId: crypto.randomUUID(),
    expectedRevision: 0,
    quantity: 1,
    notes: null,
  });
}

async function binderWithSetTargets(db: D1Database, count: number) {
  const created = await createBinder(db, 'owner', 'Binder', { kind: '2x2', rows: 2, columns: 2 });
  const versionId = created.version.id;
  const inserted = await insertBinderEntries(
    db,
    'owner',
    versionId,
    { page: 0, row: 0, column: 0 },
    Array.from({ length: count }, () => classic),
    created.version.revision,
  );
  return { binderId: created.version.binderId, versionId, revision: inserted.version.revision };
}

async function firstPage(db: D1Database, versionId: string) {
  const view = await getBinderVersion(db, 'owner', versionId, 0, 1);
  const page = view.pages[0];
  if (!page) throw new Error('missing_page');
  return page;
}

describe('set targets', () => {
  it('reads back as a set target that names its set, stored as a reserved pocket', async () => {
    const { db, raw } = setup();
    const { versionId } = await binderWithSetTargets(db, 2);

    const page = await firstPage(db, versionId);
    expect(page.slots.slice(0, 3).map((slot) => slot.entryKind)).toEqual(['set', 'set', 'empty']);
    expect(page.slots[0]).toMatchObject({
      setId: '30th',
      setLanguage: 'en',
      setName: '30th Classic',
      assignedCardId: null,
    });
    expect(
      raw
        .prepare(
          "SELECT COUNT(*) AS count FROM binder_slots WHERE entry_kind = 'reserved' AND set_id = '30th'",
        )
        .get(),
    ).toEqual({ count: 2 });
    expect(await getBinderPlannerSummary(db, 'owner', versionId)).toMatchObject({ targets: 2 });
  });

  it('refuses a set the catalogue does not have', async () => {
    const { db } = setup();
    const created = await createBinder(db, 'owner', 'Binder', { kind: '2x2', rows: 2, columns: 2 });
    await expect(
      insertBinderEntries(
        db,
        'owner',
        created.version.id,
        { page: 0, row: 0, column: 0 },
        [{ ...classic, setId: 'nope' }],
        created.version.revision,
      ),
    ).rejects.toMatchObject({ code: 'binder_set_not_found' });
  });

  it('takes any owned card from the set and refuses one from another set', async () => {
    const { db } = setup();
    const { versionId, revision } = await binderWithSetTargets(db, 1);
    await own(db, 'classic-2');
    await own(db, 'base-1');
    const at = { page: 0, row: 0, column: 0 };

    const { candidates } = await getBinderAssignmentCandidates(db, 'owner', versionId, at);
    expect(candidates.map((candidate) => candidate.cardId)).toEqual(['classic-2']);

    await expect(
      setBinderEntryAssignment(db, 'owner', versionId, at, 'base-1', revision),
    ).rejects.toMatchObject({ code: 'binder_assignment_incompatible' });

    const placed = await setBinderEntryAssignment(
      db,
      'owner',
      versionId,
      at,
      'classic-2',
      revision,
    );
    const slot = (await firstPage(db, versionId)).slots[0];
    expect(slot).toMatchObject({ entryKind: 'set', setId: '30th', assignedCardId: 'classic-2' });

    // Taking the copy out again leaves the pocket wanting any card from the set.
    await setBinderEntryAssignment(db, 'owner', versionId, at, null, placed.version.revision);
    expect((await firstPage(db, versionId)).slots[0]).toMatchObject({
      entryKind: 'set',
      setId: '30th',
      assignedCardId: null,
    });
  });

  it('shows up as an open target for a card of that set, and "add a copy and place" fills it', async () => {
    const { db } = setup();
    const { binderId, versionId, revision } = await binderWithSetTargets(db, 1);

    let matches = await getCardBinderMatches(db, 'owner', 'classic-1');
    expect(matches[0]?.setTargets).toEqual([expect.objectContaining({ row: 0, col: 0 })]);
    expect(matches[0]?.nextTarget).toMatchObject({ row: 0, col: 0 });
    expect((await getCardBinderMatches(db, 'owner', 'base-1'))[0]?.setTargets).toEqual([]);

    const page = await firstPage(db, versionId);
    await placeCard(db, 'owner', 'classic-1', binderId, `${page.id}:0:0`, true, revision);
    matches = await getCardBinderMatches(db, 'owner', 'classic-1');
    expect(matches[0]?.setTargets).toEqual([]);
    expect(matches[0]?.placed).toEqual([expect.objectContaining({ row: 0, col: 0 })]);
    expect((await firstPage(db, versionId)).slots[0]).toMatchObject({
      entryKind: 'set',
      assignedCardId: 'classic-1',
    });
  });

  it('becomes an ordinary exact-card target when its target is changed', async () => {
    const { db, raw } = setup();
    const { versionId, revision } = await binderWithSetTargets(db, 1);
    await setBinderSlot(db, 'owner', versionId, 0, 0, 0, cardIdSchema.parse('base-1'), revision);
    expect((await firstPage(db, versionId)).slots[0]).toMatchObject({
      entryKind: 'exact-card',
      cardId: 'base-1',
    });
    expect(
      raw.prepare('SELECT COUNT(*) AS count FROM binder_slots WHERE set_id IS NOT NULL').get(),
    ).toEqual({ count: 0 });
  });

  it('stays where it is when the binder is arranged', async () => {
    const { db } = setup();
    const created = await createBinder(db, 'owner', 'Binder', { kind: '2x2', rows: 2, columns: 2 });
    const versionId = created.version.id;
    const inserted = await insertBinderEntries(
      db,
      'owner',
      versionId,
      { page: 0, row: 0, column: 0 },
      [
        { kind: 'pokemon', pokemonNumber: 25, startsNewPage: false },
        classic,
        { kind: 'pokemon', pokemonNumber: 1, startsNewPage: false },
      ],
      created.version.revision,
    );
    await arrangeBinderVersion(db, 'owner', versionId, 'pokedex-number', inserted.version.revision);
    const slots = (await firstPage(db, versionId)).slots;
    expect(slots.slice(0, 3).map((slot) => [slot.entryKind, slot.pokemonNumber ?? null])).toEqual([
      ['pokemon', 1],
      ['set', null],
      ['pokemon', 25],
    ]);
  });

  it('is copied into a draft with its set', async () => {
    const { db } = setup();
    const { versionId } = await binderWithSetTargets(db, 2);
    const draft = await cloneBinderVersion(db, 'owner', versionId);
    const page = await firstPage(db, draft.version.id);
    expect(page.slots.slice(0, 2)).toEqual([
      expect.objectContaining({ entryKind: 'set', setId: '30th' }),
      expect.objectContaining({ entryKind: 'set', setId: '30th' }),
    ]);
  });

  it('is found by its set name', async () => {
    const { db } = setup();
    const { versionId } = await binderWithSetTargets(db, 1);
    const found = await searchBinderSpaces(db, 'owner', versionId, { q: 'classic' });
    expect(found.matches[0]).toMatchObject({ kind: 'set', label: 'Any card · 30th Classic' });
  });
});

describe('fillBinderPage', () => {
  it('fills only the empty pockets of that page and moves nothing', async () => {
    const { db } = setup();
    const created = await createBinder(
      db,
      'owner',
      'Binder',
      { kind: '2x2', rows: 2, columns: 2 },
      8,
    );
    const versionId = created.version.id;
    const inserted = await insertBinderEntries(
      db,
      'owner',
      versionId,
      { page: 0, row: 0, column: 1 },
      [{ kind: 'pokemon', pokemonNumber: 7, startsNewPage: false }],
      created.version.revision,
    );
    const filled = await fillBinderPage(
      db,
      'owner',
      versionId,
      0,
      classic,
      inserted.version.revision,
    );
    expect((await firstPage(db, versionId)).slots.map((slot) => slot.entryKind)).toEqual([
      'set',
      'pokemon',
      'set',
      'set',
    ]);
    const next = await getBinderVersion(db, 'owner', versionId, 1, 1);
    expect(next.pages[0]?.slots.map((slot) => slot.entryKind)).toEqual([
      'empty',
      'empty',
      'empty',
      'empty',
    ]);

    await expect(
      fillBinderPage(
        db,
        'owner',
        versionId,
        0,
        { kind: 'pokemon', pokemonNumber: 25, startsNewPage: false },
        filled.version.revision,
      ),
    ).rejects.toMatchObject({ code: 'binder_page_no_empty_pockets' });
  });

  it('can reserve a page for one Pokémon', async () => {
    const { db } = setup();
    const created = await createBinder(db, 'owner', 'Binder', { kind: '2x2', rows: 2, columns: 2 });
    await fillBinderPage(
      db,
      'owner',
      created.version.id,
      0,
      { kind: 'pokemon', pokemonNumber: 25, startsNewPage: false },
      created.version.revision,
    );
    expect(
      (await firstPage(db, created.version.id)).slots.map((slot) => slot.pokemonNumber),
    ).toEqual([25, 25, 25, 25]);
  });
});
