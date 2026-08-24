import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { compareBinderCards, type OrderingRow } from './binders';

const openDatabases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

function database(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  openDatabases.push(db);
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

describe('collection D1 transaction patterns', () => {
  it('increments quantity and revision without a read-modify-write window', () => {
    const db = database();
    db.exec(`
      CREATE TABLE collection_cards (
        owner_id TEXT NOT NULL,
        card_id TEXT NOT NULL,
        quantity INTEGER NOT NULL CHECK (quantity BETWEEN 0 AND 9999),
        revision INTEGER NOT NULL,
        last_mutation_id TEXT,
        PRIMARY KEY (owner_id, card_id)
      );
      INSERT INTO collection_cards VALUES ('owner', 'card', 2, 1, 'initial');
    `);
    const increment = db.prepare(`
      UPDATE collection_cards
      SET quantity = quantity + ?1,
        revision = revision + 1,
        last_mutation_id = ?2
      WHERE owner_id = 'owner' AND card_id = 'card'
        AND quantity + ?1 <= 9999
    `);
    db.exec('BEGIN IMMEDIATE');
    increment.run(1, 'increment-1');
    increment.run(1, 'increment-2');
    db.exec('COMMIT');
    expect(
      db.prepare('SELECT quantity, revision, last_mutation_id FROM collection_cards').get(),
    ).toEqual({ quantity: 4, revision: 3, last_mutation_id: 'increment-2' });
  });

  it('keeps one request hash per idempotency key', () => {
    const db = database();
    db.exec(`
      CREATE TABLE collection_mutations (
        owner_id TEXT NOT NULL,
        mutation_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        response_json TEXT NOT NULL,
        PRIMARY KEY (owner_id, mutation_id)
      );
      INSERT INTO collection_mutations VALUES ('owner', 'mutation', 'hash-a', '{}');
    `);
    expect(() =>
      db
        .prepare('INSERT INTO collection_mutations VALUES (?1, ?2, ?3, ?4)')
        .run('owner', 'mutation', 'hash-b', '{}'),
    ).toThrow(/UNIQUE/u);
    expect(
      db
        .prepare(
          'SELECT request_hash FROM collection_mutations WHERE owner_id = ?1 AND mutation_id = ?2',
        )
        .get('owner', 'mutation'),
    ).toEqual({ request_hash: 'hash-a' });
  });
});

describe('binder D1 transaction patterns', () => {
  it('reorders through collision-free temporary positions', () => {
    const db = database();
    db.exec(`
      CREATE TABLE binder_pages (
        id TEXT PRIMARY KEY,
        binder_version_id TEXT NOT NULL,
        position INTEGER NOT NULL CHECK (position >= 0),
        UNIQUE (binder_version_id, position)
      );
      INSERT INTO binder_pages VALUES ('a', 'version', 0), ('b', 'version', 1), ('c', 'version', 2);
      BEGIN IMMEDIATE;
      UPDATE binder_pages SET position = position + 4 WHERE binder_version_id = 'version';
      UPDATE binder_pages SET position = 0 WHERE id = 'c';
      UPDATE binder_pages SET position = 1 WHERE id = 'b';
      UPDATE binder_pages SET position = 2 WHERE id = 'a';
      COMMIT;
    `);
    expect(
      db
        .prepare(
          "SELECT id FROM binder_pages WHERE binder_version_id = 'version' ORDER BY position",
        )
        .all()
        .map((row) => row.id),
    ).toEqual(['c', 'b', 'a']);
  });

  it('uses revision serialization to preserve the last page', () => {
    const db = database();
    db.exec(`
      CREATE TABLE binder_versions (id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
      CREATE TABLE binder_pages (
        id TEXT PRIMARY KEY,
        binder_version_id TEXT NOT NULL REFERENCES binder_versions(id),
        position INTEGER NOT NULL,
        UNIQUE (binder_version_id, position)
      );
      INSERT INTO binder_versions VALUES ('version', 1);
      INSERT INTO binder_pages VALUES ('a', 'version', 0), ('b', 'version', 1);
      BEGIN IMMEDIATE;
      DELETE FROM binder_pages
       WHERE id = 'a'
         AND EXISTS (SELECT 1 FROM binder_versions WHERE id = 'version' AND revision = 1)
         AND (SELECT COUNT(*) FROM binder_pages WHERE binder_version_id = 'version') > 1;
      UPDATE binder_versions SET revision = revision + 1 WHERE id = 'version' AND revision = 1;
      COMMIT;
    `);
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM binder_pages WHERE binder_version_id = 'version'")
        .get(),
    ).toEqual({ count: 1 });
    expect(db.prepare("SELECT revision FROM binder_versions WHERE id = 'version'").get()).toEqual({
      revision: 2,
    });
    expect(
      db
        .prepare("SELECT 1 AS valid FROM binder_versions WHERE id = 'version' AND revision = 1")
        .get(),
    ).toBeUndefined();
  });

  it('allocates concurrent clone version numbers inside the insert', () => {
    const db = database();
    db.exec(`
      CREATE TABLE binder_versions (
        id TEXT PRIMARY KEY,
        binder_id TEXT NOT NULL,
        version_number INTEGER NOT NULL,
        UNIQUE (binder_id, version_number)
      );
      INSERT INTO binder_versions VALUES ('source', 'binder', 1);
    `);
    const clone = db.prepare(`
      INSERT INTO binder_versions (id, binder_id, version_number)
      SELECT ?1, source.binder_id,
        COALESCE((SELECT MAX(version_number) FROM binder_versions WHERE binder_id = source.binder_id), 0) + 1
      FROM binder_versions source WHERE source.id = 'source'
    `);
    db.exec('BEGIN IMMEDIATE');
    clone.run('clone-a');
    db.exec('COMMIT');
    db.exec('BEGIN IMMEDIATE');
    clone.run('clone-b');
    db.exec('COMMIT');
    expect(
      db
        .prepare("SELECT version_number FROM binder_versions WHERE id LIKE 'clone-%' ORDER BY id")
        .all(),
    ).toEqual([{ version_number: 2 }, { version_number: 3 }]);
  });
});

describe('binder arrangement contract', () => {
  const base: Omit<OrderingRow, 'id' | 'number'> = {
    set_name: 'Base',
    name: 'Card',
    language: 'en',
    release_date: null,
    pokedex_number: null,
  };

  it('sorts set numbers numerically and preserves duplicate targets', () => {
    const cards: OrderingRow[] = [
      { ...base, id: 'card-10', number: '10' },
      { ...base, id: 'card-4', number: '4' },
      { ...base, id: 'card-10', number: '10' },
    ];
    expect(
      cards.sort((left, right) => compareBinderCards(left, right, 'set-number')).map((x) => x.id),
    ).toEqual(['card-4', 'card-10', 'card-10']);
  });
});
