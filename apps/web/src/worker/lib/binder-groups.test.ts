import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { BinderEntry } from '@pokedex/shared';
import {
  cloneBinderVersion,
  createBinder,
  fillBinderPage,
  getBinderAssignmentCandidates,
  getBinderVersion,
  getCardBinderMatches,
  insertBinderEntries,
  searchBinderSpaces,
  setBinderEntryAssignment,
} from './binders';
import { cardGroupKeys, listSetFacets, searchCards } from './catalogue';
import { setCollectionState } from './collection';
import { applyAllMigrations, sqliteD1 } from './d1-test-helper';
import { getFavorites, setFavorite, setFavoriteKey } from './settings';
import { listTrainers } from './trainers';

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

const CARDS: Array<[string, string, string, string, number, string]> = [
  // id, name, set, number, dex, artist
  ['lillie-comfey', "Lillie's Comfey", 'sv9', '061', 764, 'Kagemaru Himeno'],
  ['lillie-clefairy', "Lillie's Clefairy ex", 'sv9', '056', 35, '5ban Graphics'],
  ['rocket-zapdos', "Rocket's Zapdos", 'g1', '15', 145, 'Ken Sugimori'],
  ['dark-charizard', 'Dark Charizard', 'base5', '4', 6, 'Ken Sugimori'],
  ['plain-pikachu', 'Pikachu', 'base1', '58', 25, 'Mitsuhiro Arita'],
];

function setup(): D1Database {
  const raw = new DatabaseSync(':memory:');
  databases.push(raw);
  applyAllMigrations(raw);
  raw.exec("INSERT INTO users(id,label,created_at) VALUES('owner','Owner',1)");
  const insert = raw.prepare(
    `INSERT INTO catalogue_cards
      (id,name,language,category,set_id,set_name,number,pokedex_number,artist,artist_key,trainer_key,is_active,created_at,updated_at)
     VALUES (?,?,'en','pokemon',?,?,?,?,?,?,?,1,1,1)`,
  );
  for (const [id, name, set, number, dex, artist] of CARDS) {
    const keys = cardGroupKeys({ name, artist, category: 'pokemon' });
    insert.run(id, name, set, set, number, dex, artist, keys.artistKey, keys.trainerKey);
  }
  return sqliteD1(raw);
}

async function own(db: D1Database, cardId: string): Promise<void> {
  await setCollectionState(db, 'owner', {
    cardId,
    mutationId: crypto.randomUUID(),
    expectedRevision: 0,
    quantity: 1,
    notes: null,
  });
}

async function slots(db: D1Database, versionId: string, page = 0) {
  return (await getBinderVersion(db, 'owner', versionId, page, 1)).pages[0]?.slots ?? [];
}

const lillie: BinderEntry = { kind: 'trainer', key: 'lillie', startsNewPage: false };

describe('trainer and illustrator targets', () => {
  it('reserves a page for a trainer and reads it back with the trainer named', async () => {
    const db = setup();
    const created = await createBinder(db, 'owner', 'B', { kind: '2x2', rows: 2, columns: 2 });
    await fillBinderPage(db, 'owner', created.version.id, 0, lillie, created.version.revision);
    const page = await slots(db, created.version.id);
    expect(page.map((slot) => slot.entryKind)).toEqual([
      'trainer',
      'trainer',
      'trainer',
      'trainer',
    ]);
    expect(page[0]).toMatchObject({ groupKey: 'lillie', groupName: 'Lillie' });
  });

  it('refuses a group with no cards', async () => {
    const db = setup();
    const created = await createBinder(db, 'owner', 'B', { kind: '2x2', rows: 2, columns: 2 });
    await expect(
      fillBinderPage(
        db,
        'owner',
        created.version.id,
        0,
        { kind: 'trainer', key: 'nobody', startsNewPage: false },
        created.version.revision,
      ),
    ).rejects.toMatchObject({ code: 'binder_group_not_found' });
  });

  it("takes only that trainer's Pokémon, and Rocket's is Team Rocket's", async () => {
    const db = setup();
    const created = await createBinder(db, 'owner', 'B', { kind: '2x2', rows: 2, columns: 2 });
    const inserted = await insertBinderEntries(
      db,
      'owner',
      created.version.id,
      { page: 0, row: 0, column: 0 },
      [lillie, { kind: 'trainer', key: 'teamrocket', startsNewPage: false }],
      created.version.revision,
    );
    await own(db, 'lillie-comfey');
    await own(db, 'rocket-zapdos');
    const at = { page: 0, row: 0, column: 0 };
    const { candidates } = await getBinderAssignmentCandidates(db, 'owner', created.version.id, at);
    expect(candidates.map((candidate) => candidate.cardId)).toEqual(['lillie-comfey']);
    await expect(
      setBinderEntryAssignment(
        db,
        'owner',
        created.version.id,
        at,
        'rocket-zapdos',
        inserted.version.revision,
      ),
    ).rejects.toMatchObject({ code: 'binder_assignment_incompatible' });
    const placed = await setBinderEntryAssignment(
      db,
      'owner',
      created.version.id,
      { page: 0, row: 0, column: 1 },
      'rocket-zapdos',
      inserted.version.revision,
    );
    expect((await slots(db, created.version.id))[1]).toMatchObject({
      entryKind: 'trainer',
      groupName: 'Team Rocket',
      assignedCardId: 'rocket-zapdos',
    });
    expect(placed.version.revision).toBeGreaterThan(inserted.version.revision);
  });

  it('an illustrator target takes any card they drew', async () => {
    const db = setup();
    const created = await createBinder(db, 'owner', 'B', { kind: '2x2', rows: 2, columns: 2 });
    const inserted = await insertBinderEntries(
      db,
      'owner',
      created.version.id,
      { page: 0, row: 0, column: 0 },
      [{ kind: 'illustrator', key: 'kensugimori', startsNewPage: false }],
      created.version.revision,
    );
    expect((await slots(db, created.version.id))[0]).toMatchObject({
      entryKind: 'illustrator',
      groupName: 'Ken Sugimori',
    });
    const matches = await getCardBinderMatches(db, 'owner', 'dark-charizard');
    expect(matches[0]?.groupTargets).toEqual([expect.objectContaining({ row: 0, col: 0 })]);
    await own(db, 'dark-charizard');
    await setBinderEntryAssignment(
      db,
      'owner',
      created.version.id,
      { page: 0, row: 0, column: 0 },
      'dark-charizard',
      inserted.version.revision,
    );
    const found = await searchBinderSpaces(db, 'owner', created.version.id, { q: 'charizard' });
    expect(found.matches[0]).toMatchObject({ kind: 'illustrator', placed: true });
  });

  it('is found by the trainer name and copied into a draft', async () => {
    const db = setup();
    const created = await createBinder(db, 'owner', 'B', { kind: '2x2', rows: 2, columns: 2 });
    await fillBinderPage(db, 'owner', created.version.id, 0, lillie, created.version.revision);
    const found = await searchBinderSpaces(db, 'owner', created.version.id, { q: 'Lillie' });
    expect(found.matches).toHaveLength(4);
    expect(found.matches[0]).toMatchObject({ kind: 'trainer', label: 'Any card · Lillie' });
    const draft = await cloneBinderVersion(db, 'owner', created.version.id);
    expect((await slots(db, draft.version.id)).map((slot) => slot.groupKey)).toEqual([
      'lillie',
      'lillie',
      'lillie',
      'lillie',
    ]);
  });
});

describe('trainers list and favourites', () => {
  it('lists trainers with counts, merging Rocket into Team Rocket, favourites flagged', async () => {
    const db = setup();
    await own(db, 'lillie-comfey');
    await setFavorite(db, 'owner', 'trainers', 'lillie', true);
    const trainers = await listTrainers(db, 'owner');
    expect(
      trainers.map((trainer) => [trainer.name, trainer.cardCount, trainer.ownedCount]),
    ).toEqual([
      ['Dark', 1, 0],
      ['Lillie', 2, 1],
      ['Team Rocket', 1, 0],
    ]);
    expect(trainers.find((trainer) => trainer.key === 'lillie')?.favorite).toBe(true);
    expect(trainers.find((trainer) => trainer.key === 'lillie')?.representative.id).toBe(
      'lillie-comfey',
    );
  });

  it('stars and unstars sets, and the set list reports it', async () => {
    const db = setup();
    await setFavorite(db, 'owner', 'sets', setFavoriteKey('sv9', 'en'), true);
    let sets = await listSetFacets(db, 'owner', undefined, true);
    const starred = sets.find((set) => set.setId === 'sv9');
    expect(starred?.favorite).toBe(true);
    expect(['lillie-comfey', 'lillie-clefairy']).toContain(starred?.representative?.id);
    await setFavorite(db, 'owner', 'sets', setFavoriteKey('sv9', 'en'), false);
    sets = await listSetFacets(db, 'owner');
    expect(sets.find((set) => set.setId === 'sv9')?.favorite).toBe(false);
    expect(await getFavorites(db, 'owner', 'sets')).toEqual(new Set());
  });
});

function setupEnergy(): D1Database {
  const raw = new DatabaseSync(':memory:');
  databases.push(raw);
  applyAllMigrations(raw);
  raw.exec(`
    INSERT INTO users(id,label,created_at) VALUES('owner','Owner',1);
    INSERT INTO catalogue_sets(set_id,language,set_name,release_date,updated_at) VALUES
      ('old','en','Old Set','1999-01-09',1), ('new','en','New Set','2025-09-26',1)
    ON CONFLICT(set_id,language) DO UPDATE SET release_date=excluded.release_date;
  `);
  const insert = raw.prepare(
    `INSERT INTO catalogue_cards
      (id,name,language,category,set_id,set_name,number,number_sort,energy_key,is_active,created_at,updated_at)
     VALUES (?,?,'en','energy',?,?,?,?,?,1,1,1)`,
  );
  for (const [id, name, set, number] of [
    ['fire-new', 'Basic Fire Energy', 'new', '2'],
    ['fire-old', 'Fire Energy', 'old', '98'],
    ['water-old', 'Water Energy', 'old', '102'],
    ['dce-old', 'Double Colorless Energy', 'old', '96'],
  ] as const) {
    const keys = cardGroupKeys({ name, category: 'energy' });
    insert.run(id, name, set, set, number, Number(number), keys.energyKey);
  }
  raw.exec(`
    INSERT INTO catalogue_cards
      (id,name,language,category,set_id,set_name,number,pokedex_number,is_active,created_at,updated_at)
    VALUES ('charmander','Charmander','en','pokemon','old','old','46',4,1,1,1);
  `);
  return sqliteD1(raw);
}

describe('energy targets', () => {
  it('a Fire Energy pocket takes Fire Energy only; an any-energy pocket takes any energy', async () => {
    const db = setupEnergy();
    const created = await createBinder(db, 'owner', 'E', { kind: '2x2', rows: 2, columns: 2 });
    const inserted = await insertBinderEntries(
      db,
      'owner',
      created.version.id,
      { page: 0, row: 0, column: 0 },
      [
        { kind: 'energy', key: 'fire', startsNewPage: false },
        { kind: 'energy', key: 'all', startsNewPage: false },
      ],
      created.version.revision,
    );
    for (const id of ['fire-old', 'water-old', 'charmander']) await own(db, id);
    const page = await slots(db, created.version.id);
    expect(page[0]).toMatchObject({
      entryKind: 'energy',
      groupKey: 'fire',
      groupName: 'Fire Energy',
    });
    expect(page[1]).toMatchObject({
      entryKind: 'energy',
      groupKey: 'all',
      groupName: 'Any energy',
    });

    const fire = await getBinderAssignmentCandidates(db, 'owner', created.version.id, {
      page: 0,
      row: 0,
      column: 0,
    });
    expect(fire.candidates.map((candidate) => candidate.cardId)).toEqual(['fire-old']);
    await expect(
      setBinderEntryAssignment(
        db,
        'owner',
        created.version.id,
        { page: 0, row: 0, column: 0 },
        'water-old',
        inserted.version.revision,
      ),
    ).rejects.toMatchObject({ code: 'binder_assignment_incompatible' });
    await expect(
      setBinderEntryAssignment(
        db,
        'owner',
        created.version.id,
        { page: 0, row: 0, column: 1 },
        'charmander',
        inserted.version.revision,
      ),
    ).rejects.toMatchObject({ code: 'binder_assignment_incompatible' });
    await setBinderEntryAssignment(
      db,
      'owner',
      created.version.id,
      { page: 0, row: 0, column: 1 },
      'water-old',
      inserted.version.revision,
    );
    expect((await slots(db, created.version.id))[1]).toMatchObject({
      entryKind: 'energy',
      assignedCardId: 'water-old',
    });
    const matches = await getCardBinderMatches(db, 'owner', 'fire-new');
    expect(matches[0]?.groupTargets).toEqual([expect.objectContaining({ row: 0, col: 0 })]);
    const found = await searchBinderSpaces(db, 'owner', created.version.id, { q: 'fire' });
    expect(found.matches[0]).toMatchObject({ kind: 'energy', label: 'Any card · Fire Energy' });
  });

  it('lists one energy type in release order for "every card, in order"', async () => {
    const db = setupEnergy();
    const fire = await searchCards(db, 'owner', {
      energy: 'fire',
      sort: 'release',
      limit: 50,
      offset: 0,
    });
    expect(fire.cards.map((card) => card.id)).toEqual(['fire-old', 'fire-new']);
    const all = await searchCards(db, 'owner', {
      energy: 'all',
      sort: 'release',
      limit: 50,
      offset: 0,
    });
    expect(all.cards.map((card) => card.id)).toEqual([
      'dce-old',
      'fire-old',
      'water-old',
      'fire-new',
    ]);
    const special = await searchCards(db, 'owner', {
      energy: 'special',
      limit: 50,
      offset: 0,
    });
    expect(special.cards.map((card) => card.id)).toEqual(['dce-old']);
  });
});
