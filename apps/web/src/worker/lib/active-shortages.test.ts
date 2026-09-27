import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { cardIdSchema, type BinderEntry } from '@pokedex/shared';
import { applyAllMigrations, sqliteD1 } from './d1-test-helper';
import {
  activeBinderShortages,
  createBinder,
  insertBinderEntries,
  setBinderEntryAssignment,
} from './binders';

it('counts exact and Pokémon shortages across report pages without counting placed copies twice', async () => {
  const database = new DatabaseSync(':memory:');
  try {
    applyAllMigrations(database);
    database.exec(
      "INSERT INTO users(id,label,created_at) VALUES('owner','Owner',1),('other','Other',1)",
    );
    for (let i = 1; i <= 120; i++)
      database
        .prepare(
          `
      INSERT INTO catalogue_cards(id,name,language,category,set_id,set_name,number,number_sort,pokedex_number,created_at,updated_at)
      VALUES(?1,?2,'en','pokemon','set','Set',?3,?4,?4,1,1)
    `,
        )
        .run(`card-${i}`, `Card ${String(i).padStart(3, '0')}`, String(i), i);
    database.exec(
      "INSERT INTO collection_cards(owner_id,card_id,quantity,notes,revision,updated_at) VALUES('owner','card-1',1,NULL,1,1)",
    );
    const db = sqliteD1(database);
    const created = await createBinder(
      db,
      'owner',
      'Full plan',
      { kind: 'custom', rows: 20, columns: 20 },
      400,
    );
    const entries: BinderEntry[] = [
      ...Array.from({ length: 120 }, (_, i) => ({
        kind: 'exact-card' as const,
        cardId: cardIdSchema.parse(`card-${i + 1}`),
        startsNewPage: false,
      })),
      ...Array.from({ length: 150 }, (_, i) => ({
        kind: 'pokemon' as const,
        pokemonNumber: i + 1,
        startsNewPage: false,
      })),
    ];
    const inserted = await insertBinderEntries(
      db,
      'owner',
      created.version.id,
      { page: 0, row: 0, column: 0 },
      entries,
      created.version.revision,
    );
    await setBinderEntryAssignment(
      db,
      'owner',
      created.version.id,
      { page: 0, row: 0, column: 0 },
      'card-1',
      inserted.version.revision,
    );
    const totals = await activeBinderShortages(db, 'owner');
    expect(totals.totalMissing).toBe(269);
    expect(totals.totalEntries).toBe(269);
    expect(totals.shortages).toHaveLength(100);
    expect(totals.pokemonShortages).toHaveLength(100);
    expect(totals.pokemonShortages[0]).toMatchObject({
      pokemonNumber: 1,
      owned: 1,
      assigned: 1,
      available: 0,
      missing: 1,
    });
    const keys: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const report = await activeBinderShortages(db, 'owner', { offset, limit: 50 });
      keys.push(
        ...report.shortages.map((item) => `card:${item.cardId}`),
        ...report.pokemonShortages.map((item) => `pokemon:${item.pokemonNumber}`),
      );
      offset = report.nextOffset;
    }
    expect(keys).toHaveLength(269);
    expect(new Set(keys).size).toBe(269);
    const before = await activeBinderShortages(db, 'owner');
    database.exec(
      "UPDATE binder_slots SET pokemon_number=151 WHERE entry_kind='pokemon' AND pokemon_number=150",
    );
    const after = await activeBinderShortages(db, 'owner');
    expect(after.totalMissing).toBe(before.totalMissing);
    expect(after.totalEntries).toBe(before.totalEntries);
    expect(after.snapshot).not.toBe(before.snapshot);
    expect(await activeBinderShortages(db, 'other')).toMatchObject({
      totalMissing: 0,
      totalEntries: 0,
      shortages: [],
      pokemonShortages: [],
      nextOffset: null,
    });
  } finally {
    database.close();
  }
});
