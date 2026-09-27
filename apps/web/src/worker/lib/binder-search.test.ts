import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createBinder, searchBinderSpaces } from './binders';
import { applyAllMigrations, sqliteD1 } from './d1-test-helper';

describe('binder space search', () => {
  it('finds targets on later pages, named reservations and empty spaces within capacity', async () => {
    const database = new DatabaseSync(':memory:');
    try {
      applyAllMigrations(database);
      database.exec(
        "INSERT INTO users(id,label,created_at) VALUES('owner','Owner',1); INSERT INTO catalogue_cards(id,name,language,category,set_id,set_name,number,created_at,updated_at) VALUES('card','Pikachu','en','pokemon','base','Base Set','58',1,1);",
      );
      const db = sqliteD1(database);
      const { version } = await createBinder(
        db,
        'owner',
        'Search',
        { kind: '2x2', rows: 2, columns: 2 },
        13,
      );
      database
        .prepare(
          "UPDATE binder_slots SET entry_kind='pokemon',pokemon_number=25 WHERE binder_page_id=(SELECT id FROM binder_pages WHERE binder_version_id=? AND position=2) AND row_index=0 AND column_index=1",
        )
        .run(version.id);
      database
        .prepare(
          "UPDATE binder_slots SET entry_kind='reserved',label='Future promos' WHERE binder_page_id=(SELECT id FROM binder_pages WHERE binder_version_id=? AND position=0) AND row_index=0 AND column_index=0",
        )
        .run(version.id);
      database
        .prepare(
          "UPDATE binder_slots SET entry_kind='exact-card',card_id='card' WHERE binder_page_id=(SELECT id FROM binder_pages WHERE binder_version_id=? AND position=0) AND row_index=1 AND column_index=1",
        )
        .run(version.id);
      database
        .prepare(
          "UPDATE binder_pages SET kind='reserved',label='Future promos page' WHERE binder_version_id=? AND position=1",
        )
        .run(version.id);
      const name = await searchBinderSpaces(db, 'owner', version.id, { q: 'PIKACHU' });
      expect(name.matches.map((item) => item.page)).toEqual([0, 2]);
      expect(name.matches[1]).toMatchObject({ row: 0, column: 1, kind: 'pokemon', placed: false });
      expect(
        (await searchBinderSpaces(db, 'owner', version.id, { q: '#0025' })).matches,
      ).toHaveLength(1);
      expect(
        (await searchBinderSpaces(db, 'owner', version.id, { q: '#25' })).matches,
      ).toHaveLength(1);
      expect((await searchBinderSpaces(db, 'owner', version.id, { q: '25' })).matches).toHaveLength(
        1,
      );
      expect(
        (await searchBinderSpaces(db, 'owner', version.id, { q: 'Base Set' })).matches[0]?.kind,
      ).toBe('exact-card');
      expect(
        (await searchBinderSpaces(db, 'owner', version.id, { q: 'Future promos' })).matches.map(
          (item) => item.kind,
        ),
      ).toEqual(['reserved', 'reserved-page']);
      const empty = await searchBinderSpaces(db, 'owner', version.id, { q: 'empty' });
      expect(empty.matches).toHaveLength(10);
      expect(empty.matches.filter((item) => item.page === 3)).toEqual([
        expect.objectContaining({ row: 0, column: 0 }),
      ]);
      expect((await searchBinderSpaces(db, 'owner', version.id, { q: '%' })).matches).toEqual([]);
      database.exec(
        "UPDATE catalogue_cards SET name='Évoli',set_name='Éclats' WHERE id='card'; UPDATE binder_slots SET label='ÜBER promos' WHERE entry_kind='reserved'; UPDATE binder_pages SET label='ÜBER page' WHERE kind='reserved';",
      );
      expect(
        (await searchBinderSpaces(db, 'owner', version.id, { q: 'évoli' })).matches,
      ).toHaveLength(1);
      expect(
        (await searchBinderSpaces(db, 'owner', version.id, { q: 'éclats' })).matches,
      ).toHaveLength(1);
      expect(
        (await searchBinderSpaces(db, 'owner', version.id, { q: 'über' })).matches,
      ).toHaveLength(2);
      await expect(
        searchBinderSpaces(db, 'someone-else', version.id, { q: 'Pikachu' }),
      ).rejects.toMatchObject({ code: 'binder_version_not_found' });
    } finally {
      database.close();
    }
  });
  it('paginates large binders without fetching their artwork', async () => {
    const database = new DatabaseSync(':memory:');
    try {
      applyAllMigrations(database);
      database.exec("INSERT INTO users(id,label,created_at) VALUES('owner','Owner',1)");
      const db = sqliteD1(database);
      const { version } = await createBinder(
        db,
        'owner',
        'Large',
        { kind: '3x3', rows: 3, columns: 3 },
        1200,
      );
      const first = await searchBinderSpaces(db, 'owner', version.id, { q: 'empty' });
      const second = await searchBinderSpaces(db, 'owner', version.id, { q: 'empty', offset: 50 });
      expect(first.matches).toHaveLength(50);
      expect(first.nextOffset).toBe(50);
      expect(second.matches[0]).toMatchObject({ page: 5, row: 1, column: 2 });
      const last = await searchBinderSpaces(db, 'owner', version.id, { q: 'empty', offset: 1150 });
      expect(last.matches).toHaveLength(50);
      expect(last.nextOffset).toBeNull();
    } finally {
      database.close();
    }
  });
});
