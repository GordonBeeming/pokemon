import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { searchCards, listSetFacets } from './catalogue';
import {
  incrementCollectionQuantity,
  patchCollectionNotes,
  setCollectionState,
} from './collection';
import { cardIdSchema } from '@pokedex/shared';
import { applyAllMigrations, sqliteD1 } from './d1-test-helper';
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function setup(): D1Database {
  const database = new DatabaseSync(':memory:');
  databases.push(database);
  applyAllMigrations(database);
  database.exec(
    `INSERT INTO users (id,label,created_at) VALUES ('owner','Owner',1), ('other','Other',1);`,
  );
  for (let index = 1; index <= 35; index++) {
    database
      .prepare(
        `INSERT INTO catalogue_cards (id,name,language,category,set_id,set_name,number,number_sort,pokedex_number,created_at,updated_at)
      VALUES (?1,'Squirtle','en','pokemon','base','Base',?2,?3,7,1,1)`,
      )
      .run(`card-${index}`, String(index), index);
  }
  database.exec(`UPDATE catalogue_cards SET species='Squirtle';
    INSERT INTO catalogue_search (card_id,name,set_name,number,species,rarity,artist)
    SELECT id,name,set_name,number,species,'Common','Artist' FROM catalogue_cards;`);
  database.exec(`INSERT INTO collection_cards (owner_id,card_id,quantity,revision,updated_at) VALUES
    ('owner','card-30',1,1,1), ('owner','card-35',2,1,1), ('owner','card-1',0,1,1), ('other','card-34',1,1,1);`);
  return sqliteD1(database);
}
describe('catalogue ownership ordering', () => {
  it('sorts sets by oldest release first, unknown dates last, with stable cursor ties', async () => {
    const db = setup();
    for (const [id, set, name, date, number] of [
      ['card-1', 'old', 'Zulu Old', '2000-01-01', '2'],
      ['card-2', 'new', 'Alpha New', '2005-01-01', '1'],
      ['card-3', 'unknown', 'A Unknown', null, '1'],
      ['card-4', 'old', 'Zulu Old', '2000-01-01', '10'],
      ['card-5', 'tie', 'Alpha Tie', '2000-01-01', '1'],
    ])
      await db
        .prepare(
          "UPDATE catalogue_cards SET category='special',set_id=?1,set_name=?2,release_date=?3,number=?4,number_sort=?5 WHERE id=?6",
        )
        .bind(set, name, date, number, Number(number), id)
        .run();
    const filters = { category: 'special' as const, owned: false, limit: 1, offset: 0 };
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await searchCards(db, 'owner', { ...filters, cursor });
      ids.push(...page.cards.map((card) => card.id));
      cursor = page.cursor;
    } while (cursor);
    expect(ids).toEqual(['card-5', 'card-1', 'card-4', 'card-2', 'card-3']);
    expect((await listSetFacets(db, 'owner')).map((set) => set.setId)).toEqual([
      'tie',
      'old',
      'new',
      'unknown',
      'base',
    ]);
    await incrementCollectionQuantity(db, 'owner', {
      cardId: cardIdSchema.parse('card-2'),
      mutationId: crypto.randomUUID(),
      delta: 1,
    });
    expect(
      (await searchCards(db, 'owner', { category: 'special', limit: 10, offset: 0 })).cards[0]?.id,
    ).toBe('card-2');
  });
  it('promotes copy additions but not notes, removals, or retried mutations', async () => {
    const db = setup();
    const card30 = cardIdSchema.parse('card-30'),
      card35 = cardIdSchema.parse('card-35');
    const firstInput = { cardId: card30, mutationId: crypto.randomUUID(), delta: 1 };
    const first = await incrementCollectionQuantity(db, 'owner', firstInput);
    const ids = async () =>
      (await searchCards(db, 'owner', { limit: 50, offset: 0 })).cards.map((card) => card.id);
    expect((await ids()).slice(0, 2)).toEqual(['card-30', 'card-35']);
    const second = await incrementCollectionQuantity(db, 'owner', {
      cardId: card35,
      mutationId: crypto.randomUUID(),
      delta: 1,
    });
    expect((await ids()).slice(0, 2)).toEqual(['card-35', 'card-30']);
    await patchCollectionNotes(db, 'owner', {
      cardId: card30,
      mutationId: crypto.randomUUID(),
      expectedRevision: first.state.revision,
      notes: 'Only notes changed',
    });
    expect((await ids()).slice(0, 2)).toEqual(['card-35', 'card-30']);
    expect((await incrementCollectionQuantity(db, 'owner', firstInput)).replayed).toBe(true);
    expect((await ids()).slice(0, 2)).toEqual(['card-35', 'card-30']);
    const removed = await setCollectionState(db, 'owner', {
      cardId: card35,
      mutationId: crypto.randomUUID(),
      expectedRevision: second.state.revision,
      quantity: 0,
      notes: null,
    });
    expect((await ids())[0]).toBe('card-30');
    expect((await ids()).at(-1)).toBe('card-35');
    await setCollectionState(db, 'owner', {
      cardId: card35,
      mutationId: crypto.randomUUID(),
      expectedRevision: removed.state.revision,
      quantity: 1,
      notes: null,
    });
    expect((await ids()).slice(0, 2)).toEqual(['card-35', 'card-30']);
  });
  it('preserves historical fallback order and isolates other owners', async () => {
    const db = setup();
    await db.prepare("UPDATE collection_cards SET last_added_order=0 WHERE owner_id='owner'").run();
    const initial = await searchCards(db, 'owner', { limit: 50, offset: 0 });
    expect(initial.cards.slice(0, 2).map((card) => card.id)).toEqual(['card-30', 'card-35']);
    await incrementCollectionQuantity(db, 'other', {
      cardId: cardIdSchema.parse('card-34'),
      mutationId: crypto.randomUUID(),
      delta: 1,
    });
    expect(
      (await searchCards(db, 'owner', { limit: 50, offset: 0 })).cards.map((card) => card.id),
    ).toEqual(initial.cards.map((card) => card.id));
    await incrementCollectionQuantity(db, 'owner', {
      cardId: cardIdSchema.parse('card-35'),
      mutationId: crypto.randomUUID(),
      delta: 1,
    });
    expect(
      (await searchCards(db, 'owner', { limit: 50, offset: 0 })).cards
        .slice(0, 2)
        .map((card) => card.id),
    ).toEqual(['card-35', 'card-30']);
  });
  it('paginates through the addition-ranked owned group and then the numbered missing cards', async () => {
    const db = setup();
    for (const id of ['card-1', 'card-2', 'card-3'])
      await incrementCollectionQuantity(db, 'owner', {
        cardId: cardIdSchema.parse(id),
        mutationId: crypto.randomUUID(),
        delta: 1,
      });
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const result = await searchCards(db, 'owner', { limit: 1, offset: 0, cursor });
      seen.push(...result.cards.map((card) => card.id));
      cursor = result.cursor;
    } while (cursor);
    expect(seen.slice(0, 5)).toEqual(['card-3', 'card-2', 'card-1', 'card-35', 'card-30']);
    expect(new Set(seen).size).toBe(35);
    expect(seen.slice(5)).toEqual(
      Array.from({ length: 35 }, (_, i) => `card-${i + 1}`).filter(
        (id) => !seen.slice(0, 5).includes(id),
      ),
    );
  });
  it.each([
    {},
    { pokedexNumber: 7 },
    { setId: 'base', query: 'Squirtle' },
    { setId: 'base', pokedexNumber: 7 },
    { setId: 'base', species: 'Squirtle' },
  ])('shows owned cards first across cursor pages for %j', async (filters) => {
    const db = setup();
    const first = await searchCards(db, 'owner', { ...filters, limit: 24, offset: 0 });
    expect(first.cards.slice(0, 3).map((card) => card.id)).toEqual([
      'card-35',
      'card-30',
      'card-1',
    ]);
    const next = await searchCards(db, 'owner', {
      ...filters,
      limit: 24,
      offset: 0,
      cursor: first.cursor,
    });
    const ids = [...first.cards, ...next.cards].map((card) => card.id);
    expect(ids).toHaveLength(35);
    expect(new Set(ids).size).toBe(35);
    expect(next.cursor).toBeNull();
    const offset = await searchCards(db, 'owner', { ...filters, limit: 24, offset: 24 });
    expect(offset.cards.map((card) => card.id)).toEqual(next.cards.map((card) => card.id));
  });
  it('crosses from owned to unowned when the page ends on the last owned card', async () => {
    const db = setup();
    const first = await searchCards(db, 'owner', { limit: 2, offset: 0 });
    const next = await searchCards(db, 'owner', { limit: 2, offset: 0, cursor: first.cursor });
    expect(next.cards.map((card) => card.id)).toEqual(['card-1', 'card-2']);
  });
  it('preserves numbered set checklists and their pagination', async () => {
    const db = setup();
    const first = await searchCards(db, 'owner', { setId: 'base', limit: 24, offset: 0 });
    const next = await searchCards(db, 'owner', {
      setId: 'base',
      limit: 24,
      offset: 0,
      cursor: first.cursor,
    });
    expect([...first.cards, ...next.cards].map((card) => card.id)).toEqual(
      Array.from({ length: 35 }, (_, i) => `card-${i + 1}`),
    );
  });
});
