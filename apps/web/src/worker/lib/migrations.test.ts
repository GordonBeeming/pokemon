import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

const openDatabases: DatabaseSync[] = [];
const migrationsDirectory = new URL('../../../migrations/', import.meta.url);

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

function migration(name: string): string {
  return readFileSync(new URL(name, migrationsDirectory), 'utf8');
}

function databaseAtMigrationFive(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  openDatabases.push(database);
  database.exec('PRAGMA foreign_keys = ON');
  for (const name of [
    '001_auth.sql',
    '002_catalogue_collection_binders.sql',
    '003_art_upload_tokens.sql',
    '004_staged_ingestion.sql',
    '005_catalogue_arrangement_metadata.sql',
  ]) {
    database.exec(migration(name));
  }
  database.exec(`
    INSERT INTO users (id, label, created_at) VALUES
      ('owner-a', 'Owner A', 1),
      ('owner-b', 'Owner B', 1);
    INSERT INTO catalogue_cards
      (id, name, language, category, set_id, set_name, number, created_at, updated_at)
    VALUES ('card-1', 'Card', 'en', 'pokemon', 'set-1', 'Set', '1', 1, 1);
  `);
  return database;
}

function applyMigrationSix(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec(migration('006_hardening_and_sync.sql'));
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function applyMigrationSeven(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec(migration('007_national_pokedex.sql'));
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function applyMigrationEight(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec(migration('008_physical_printing_identity.sql'));
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function applyMigrationNine(database: DatabaseSync): void {
  database.exec('BEGIN IMMEDIATE');
  try {
    database.exec(migration('009_species_discovery_cache.sql'));
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

describe('migration 006 legacy-data safety', () => {
  it('aborts before rewriting a contradictory standard layout', () => {
    const database = databaseAtMigrationFive();
    database.exec(`
      INSERT INTO binders (id, owner_id, name, created_at, updated_at)
      VALUES ('binder-1', 'owner-a', 'Binder', 1, 1);
      INSERT INTO binder_versions
        (id, binder_id, version_number, status, layout_kind, rows, columns, created_at)
      VALUES ('version-1', 'binder-1', 1, 'active', '3x3', 4, 4, 1);
      INSERT INTO binder_pages (id, binder_version_id, position)
      VALUES ('page-1', 'version-1', 0);
      INSERT INTO binder_slots (binder_page_id, row_index, column_index, card_id)
      VALUES ('page-1', 3, 3, 'card-1');
    `);

    expect(() => applyMigrationSix(database)).toThrow(
      /migration_006_binder_layout_conflict_repair_layout_before_retry/u,
    );
    expect(
      database.prepare("SELECT rows, columns FROM binder_versions WHERE id = 'version-1'").get(),
    ).toEqual({ rows: 4, columns: 4 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM binder_slots').get()).toEqual({
      count: 1,
    });
  });

  it('aborts before deleting a slot outside an otherwise canonical layout', () => {
    const database = databaseAtMigrationFive();
    database.exec(`
      INSERT INTO binders (id, owner_id, name, created_at, updated_at)
      VALUES ('binder-1', 'owner-a', 'Binder', 1, 1);
      INSERT INTO binder_versions
        (id, binder_id, version_number, status, layout_kind, rows, columns, created_at)
      VALUES ('version-1', 'binder-1', 1, 'active', '3x3', 3, 3, 1);
      INSERT INTO binder_pages (id, binder_version_id, position)
      VALUES ('page-1', 'version-1', 0);
      INSERT INTO binder_slots (binder_page_id, row_index, column_index, card_id)
      VALUES ('page-1', 3, 0, 'card-1');
    `);

    expect(() => applyMigrationSix(database)).toThrow(
      /migration_006_binder_slot_out_of_bounds_repair_slot_before_retry/u,
    );
    expect(database.prepare('SELECT COUNT(*) AS count FROM binder_slots').get()).toEqual({
      count: 1,
    });
  });

  it('preserves deterministic price conflicts and terminates legacy stage runs', () => {
    const database = databaseAtMigrationFive();
    database.exec(`
      INSERT INTO price_snapshots
        (id, card_id, source, native_amount, native_currency, source_captured_at,
         amount_aud, created_at)
      VALUES
        ('older', 'card-1', 'tcgplayer', 10, 'USD', 100, 15, 100),
        ('newer', 'card-1', 'tcgplayer', 20, 'USD', 100, NULL, 200);
      INSERT INTO price_stage_rows
        (run_id, card_id, source, native_amount, native_currency, source_captured_at)
      VALUES ('legacy-run', 'card-1', 'tcgplayer', 12, 'usd', 150);
    `);

    applyMigrationSix(database);

    expect(database.prepare('SELECT id FROM price_snapshots').all()).toEqual([{ id: 'older' }]);
    expect(
      database.prepare('SELECT id, kept_snapshot_id FROM price_snapshot_migration_conflicts').all(),
    ).toEqual([{ id: 'newer', kept_snapshot_id: 'older' }]);
    expect(
      database
        .prepare(
          "SELECT status, completed_at IS NOT NULL AS completed, row_count, error FROM price_sync_runs WHERE id = 'legacy-run'",
        )
        .get(),
    ).toEqual({
      status: 'failed',
      completed: 1,
      row_count: 1,
      error: 'legacy_stage_requires_resubmission',
    });
    expect(
      database
        .prepare(
          "SELECT native_amount, native_currency, disposition, kept_native_amount FROM price_stage_row_migration_archive WHERE run_id = 'legacy-run'",
        )
        .get(),
    ).toEqual({
      native_amount: 12,
      native_currency: 'usd',
      disposition: 'migrated',
      kept_native_amount: 12,
    });
  });

  it('normalizes every migration-002 currency case and retains positive sub-micro prices', () => {
    const database = databaseAtMigrationFive();
    database.exec(`
      INSERT INTO price_snapshots
        (id, card_id, source, native_amount, native_currency, source_captured_at, created_at)
      VALUES ('tiny', 'card-1', 'tcgplayer', 0.0000001, 'u$d', 100, 100);
      INSERT INTO price_stage_rows
        (run_id, card_id, source, native_amount, native_currency, source_captured_at)
      VALUES ('tiny-run', 'card-1', 'tcgplayer', 0.0000001, 'u$d', 100);
    `);

    applyMigrationSix(database);

    expect(
      database
        .prepare(
          "SELECT native_amount, native_currency, native_amount_micros FROM price_snapshots WHERE id = 'tiny'",
        )
        .get(),
    ).toEqual({ native_amount: 0.0000001, native_currency: 'u$d', native_amount_micros: 1 });
    expect(
      database
        .prepare(
          "SELECT native_currency, native_amount_micros FROM card_current_prices WHERE card_id = 'card-1'",
        )
        .get(),
    ).toEqual({ native_currency: 'U$D', native_amount_micros: 1 });
    expect(
      database
        .prepare(
          "SELECT native_amount_micros, native_currency FROM price_stage_rows WHERE run_id = 'tiny-run'",
        )
        .get(),
    ).toEqual({ native_amount_micros: 1, native_currency: 'U$D' });
    expect(
      database
        .prepare(
          "SELECT native_amount, native_currency FROM price_stage_row_migration_archive WHERE run_id = 'tiny-run'",
        )
        .get(),
    ).toEqual({ native_amount: 0.0000001, native_currency: 'u$d' });
  });

  it('archives every staged collision and chooses the highest amount deterministically', () => {
    const database = databaseAtMigrationFive();
    database.exec(`
      INSERT INTO price_stage_rows
        (run_id, card_id, source, native_amount, native_currency, source_captured_at)
      VALUES
        ('duplicate-run', 'card-1', 'tcgplayer', 1, 'usd', 100),
        ('duplicate-run', 'card-1', 'tcgplayer', 2, 'USD', 100);
    `);

    applyMigrationSix(database);

    expect(
      database
        .prepare(
          "SELECT native_amount_micros, native_currency FROM price_stage_rows WHERE run_id = 'duplicate-run'",
        )
        .all(),
    ).toEqual([{ native_amount_micros: 2_000_000, native_currency: 'USD' }]);
    expect(
      database
        .prepare(
          "SELECT native_amount, native_currency, disposition, kept_native_amount FROM price_stage_row_migration_archive WHERE run_id = 'duplicate-run' ORDER BY native_amount",
        )
        .all(),
    ).toEqual([
      {
        native_amount: 1,
        native_currency: 'usd',
        disposition: 'deduplicated',
        kept_native_amount: 2,
      },
      {
        native_amount: 2,
        native_currency: 'USD',
        disposition: 'migrated',
        kept_native_amount: 2,
      },
    ]);
  });

  it('chooses one active binder version deterministically and synchronizes the binder pointer', () => {
    const database = databaseAtMigrationFive();
    database.exec(`
      INSERT INTO binders (id, owner_id, name, active_version_id, created_at, updated_at)
      VALUES ('binder-1', 'owner-a', 'Binder', 'version-1', 1, 1);
      INSERT INTO binder_versions
        (id, binder_id, version_number, status, layout_kind, rows, columns, created_at, activated_at)
      VALUES
        ('version-1', 'binder-1', 1, 'active', '3x3', 3, 3, 10, 20),
        ('version-2', 'binder-1', 2, 'active', '3x3', 3, 3, 11, 20),
        ('version-3', 'binder-1', 3, 'draft', '3x3', 3, 3, 12, NULL);
    `);

    applyMigrationSix(database);

    expect(
      database.prepare('SELECT id, status FROM binder_versions ORDER BY version_number').all(),
    ).toEqual([
      { id: 'version-1', status: 'archived' },
      { id: 'version-2', status: 'active' },
      { id: 'version-3', status: 'draft' },
    ]);
    expect(
      database.prepare("SELECT active_version_id FROM binders WHERE id = 'binder-1'").get(),
    ).toEqual({ active_version_id: 'version-2' });
  });

  it('increments backup epochs without revoking sessions when personal data changes', () => {
    const database = databaseAtMigrationFive();
    applyMigrationSix(database);

    database.exec(`
      INSERT INTO collection_cards (owner_id, card_id, quantity, revision, updated_at)
      VALUES ('owner-a', 'card-1', 1, 1, 1);
      UPDATE collection_cards SET owner_id = 'owner-b'
      WHERE owner_id = 'owner-a' AND card_id = 'card-1';
    `);

    expect(
      database.prepare('SELECT id, mutation_epoch, backup_epoch FROM users ORDER BY id').all(),
    ).toEqual([
      { id: 'owner-a', mutation_epoch: 0, backup_epoch: 2 },
      { id: 'owner-b', mutation_epoch: 0, backup_epoch: 1 },
    ]);
    database.exec("DELETE FROM collection_cards WHERE owner_id = 'owner-b'");
    expect(
      database.prepare("SELECT mutation_epoch, backup_epoch FROM users WHERE id = 'owner-b'").get(),
    ).toEqual({ mutation_epoch: 0, backup_epoch: 2 });
  });

  it('invalidates every owner backup when the custom catalogue graph changes', () => {
    const database = databaseAtMigrationFive();
    applyMigrationSix(database);
    const epochs = () =>
      database.prepare('SELECT id, mutation_epoch, backup_epoch FROM users ORDER BY id').all();

    database.exec(`
      INSERT INTO catalogue_cards
        (id, name, language, category, set_id, set_name, number, is_custom, created_at, updated_at)
      VALUES ('custom-1', 'Custom', 'en', 'special', 'custom', 'Custom', '1', 1, 1, 1);
    `);
    expect(epochs()).toEqual([
      { id: 'owner-a', mutation_epoch: 0, backup_epoch: 1 },
      { id: 'owner-b', mutation_epoch: 0, backup_epoch: 1 },
    ]);

    database.exec(`
      INSERT INTO card_sources
        (provider, source_id, card_id, language, source_updated_at, checksum, imported_at)
      VALUES ('manual', 'custom-source', 'custom-1', 'en', 1, 'checksum', 1);
      INSERT INTO art_manifest
        (card_id, variant, object_key, sha256, bytes, version, updated_at)
      VALUES ('custom-1', 'high', 'cards/custom-1/high/hash.webp', '${'a'.repeat(64)}', 20, 1, 1);
    `);
    expect(epochs()).toEqual([
      { id: 'owner-a', mutation_epoch: 0, backup_epoch: 3 },
      { id: 'owner-b', mutation_epoch: 0, backup_epoch: 3 },
    ]);

    database.exec(`
      UPDATE catalogue_cards SET name = 'Custom updated' WHERE id = 'custom-1';
      UPDATE card_sources SET checksum = 'updated' WHERE source_id = 'custom-source';
      UPDATE art_manifest SET updated_at = 2 WHERE card_id = 'custom-1';
    `);
    expect(epochs()).toEqual([
      { id: 'owner-a', mutation_epoch: 0, backup_epoch: 6 },
      { id: 'owner-b', mutation_epoch: 0, backup_epoch: 6 },
    ]);

    database.exec(`
      DELETE FROM art_manifest WHERE card_id = 'custom-1';
      DELETE FROM card_sources WHERE source_id = 'custom-source';
      DELETE FROM catalogue_cards WHERE id = 'custom-1';
    `);
    expect(epochs()).toEqual([
      { id: 'owner-a', mutation_epoch: 0, backup_epoch: 9 },
      { id: 'owner-b', mutation_epoch: 0, backup_epoch: 9 },
    ]);
  });

  it('keeps an existing session valid while its backup generation advances', () => {
    const database = databaseAtMigrationFive();
    applyMigrationSix(database);
    database.exec(`
      INSERT INTO web_sessions
        (id_hash, user_id, mutation_epoch, expires_at, created_at)
      VALUES ('session-a', 'owner-a', 0, 9999999999, 1);
      INSERT INTO collection_cards (owner_id, card_id, quantity, revision, updated_at)
      VALUES ('owner-a', 'card-1', 1, 1, 1);
      INSERT INTO binders (id, owner_id, name, created_at, updated_at)
      VALUES ('binder-session', 'owner-a', 'Binder', 1, 1);
      INSERT INTO catalogue_cards
        (id, name, language, category, set_id, set_name, number, is_custom, created_at, updated_at)
      VALUES ('custom-session', 'Custom', 'en', 'special', 'custom', 'Custom', '2', 1, 1, 1);
      INSERT INTO art_manifest
        (card_id, variant, object_key, sha256, bytes, version, updated_at)
      VALUES ('custom-session', 'high', 'cards/custom-session/high/hash.webp', '${'b'.repeat(64)}', 20, 1, 1);
    `);

    expect(
      database
        .prepare(
          `SELECT u.mutation_epoch = session.mutation_epoch AS valid,
             u.mutation_epoch, u.backup_epoch
           FROM users u JOIN web_sessions session ON session.user_id = u.id
           WHERE u.id = 'owner-a'`,
        )
        .get(),
    ).toEqual({ valid: 1, mutation_epoch: 0, backup_epoch: 4 });
  });
});

describe('migration 007 National Pokédex representatives', () => {
  it('keeps one owner-scoped representative per National Pokédex number', () => {
    const database = databaseAtMigrationFive();
    applyMigrationSix(database);
    applyMigrationSeven(database);
    database.exec(`
      UPDATE catalogue_cards SET pokedex_number = 7 WHERE id = 'card-1';
      INSERT INTO species_representatives (owner_id, pokedex_number, card_id, updated_at)
      VALUES ('owner-a', 7, 'card-1', 1), ('owner-b', 7, 'card-1', 1);
    `);

    expect(
      database
        .prepare(
          'SELECT owner_id, pokedex_number, card_id FROM species_representatives ORDER BY owner_id',
        )
        .all(),
    ).toEqual([
      { owner_id: 'owner-a', pokedex_number: 7, card_id: 'card-1' },
      { owner_id: 'owner-b', pokedex_number: 7, card_id: 'card-1' },
    ]);
    expect(() =>
      database
        .prepare(
          'INSERT INTO species_representatives (owner_id, pokedex_number, card_id, updated_at) VALUES (?1, ?2, ?3, ?4)',
        )
        .run('owner-a', 0, 'card-1', 1),
    ).toThrow(/CHECK constraint/u);
  });
});

describe('migration 008 physical printing identity', () => {
  it('merges aliased source cards into one printing without losing owner state', () => {
    const database = databaseAtMigrationFive();
    applyMigrationSix(database);
    applyMigrationSeven(database);
    database.exec(`
      UPDATE catalogue_cards SET pokedex_number = 7 WHERE id = 'card-1';
      INSERT INTO catalogue_cards
        (id, name, language, category, set_id, set_name, number, number_sort,
         pokedex_number, created_at, updated_at)
      VALUES ('card-alias', 'Card', 'en', 'pokemon', 'set-alias', 'Set', '1', 1, 7, 2, 2);
      INSERT INTO card_sources
        (provider, source_id, card_id, language, source_updated_at, checksum, imported_at)
      VALUES
        ('tcgdex', 'set-1', 'card-1', 'en', 1, 'one', 1),
        ('tcgdex', 'set-alias-1', 'card-alias', 'en', 1, 'two', 1);
      INSERT INTO collection_cards (owner_id, card_id, quantity, notes, revision, updated_at)
      VALUES
        ('owner-a', 'card-1', 1, 'binder note', 1, 1),
        ('owner-a', 'card-alias', 2, 'sleeved', 1, 2);
      INSERT INTO collection_mutations
        (owner_id, mutation_id, card_id, response_json, created_at, request_hash)
      VALUES ('owner-a', 'mutation-alias', 'card-alias', '{}', 2, 'stale-hash');
      INSERT INTO binders (id, owner_id, name, created_at, updated_at)
      VALUES ('binder-merge', 'owner-a', 'Binder', 1, 1);
      INSERT INTO binder_versions
        (id, binder_id, version_number, status, layout_kind, rows, columns, created_at)
      VALUES ('version-merge', 'binder-merge', 1, 'draft', '3x3', 3, 3, 1);
      INSERT INTO binder_pages (id, binder_version_id, position)
      VALUES ('page-merge', 'version-merge', 0);
      INSERT INTO binder_slots (binder_page_id, row_index, column_index, card_id)
      VALUES ('page-merge', 0, 0, 'card-1');
      INSERT INTO species_representatives (owner_id, pokedex_number, card_id, updated_at)
      VALUES ('owner-a', 7, 'card-1', 1);
      INSERT INTO art_manifest
        (card_id, variant, object_key, sha256, bytes, version, updated_at)
      VALUES ('card-1', 'low', 'cards/card-1/low/hash.webp', '${'c'.repeat(64)}', 20, 1, 1);
    `);

    applyMigrationEight(database);

    expect(database.prepare('SELECT id FROM catalogue_cards').all()).toEqual([{ id: 'card-1' }]);
    expect(database.prepare('SELECT card_id, quantity, notes FROM collection_cards').get()).toEqual(
      { card_id: 'card-1', quantity: 3, notes: 'binder note\nsleeved' },
    );
    expect(database.prepare('SELECT * FROM collection_mutations').all()).toEqual([]);
    expect(database.prepare('SELECT card_id FROM binder_slots').get()).toEqual({
      card_id: 'card-1',
    });
    expect(database.prepare('SELECT card_id FROM species_representatives').get()).toEqual({
      card_id: 'card-1',
    });
    expect(database.prepare('SELECT card_id FROM art_manifest').get()).toEqual({
      card_id: 'card-1',
    });
    expect(database.prepare('SELECT card_id FROM card_sources ORDER BY source_id').all()).toEqual([
      { card_id: 'card-1' },
      { card_id: 'card-1' },
    ]);
    expect(() =>
      database.exec(`
        INSERT INTO catalogue_cards
          (id, name, language, category, set_id, set_name, number, created_at, updated_at)
        VALUES ('duplicate-again', 'Card', 'en', 'pokemon', 'another-id', 'Set', '1', 3, 3);
      `),
    ).toThrow(/UNIQUE constraint/u);
  });
});

describe('migration 009 species discovery cache', () => {
  it('stores one bounded refresh marker per National Pokédex species', () => {
    const database = databaseAtMigrationFive();
    applyMigrationSix(database);
    applyMigrationSeven(database);
    applyMigrationEight(database);
    applyMigrationNine(database);

    database.exec(`
      INSERT INTO species_discovery_cache
        (pokedex_number, species_name, printing_count, last_checked_at)
      VALUES (7, 'Squirtle', 33, 100);
      INSERT INTO species_discovery_cache
        (pokedex_number, species_name, printing_count, last_checked_at)
      VALUES (7, 'Squirtle', 34, 200)
      ON CONFLICT(pokedex_number) DO UPDATE SET
        printing_count = excluded.printing_count,
        last_checked_at = excluded.last_checked_at;
    `);

    expect(database.prepare('SELECT * FROM species_discovery_cache').get()).toEqual({
      pokedex_number: 7,
      species_name: 'Squirtle',
      printing_count: 34,
      last_checked_at: 200,
    });
    expect(() =>
      database.exec(`
        INSERT INTO species_discovery_cache
          (pokedex_number, species_name, printing_count, last_checked_at)
        VALUES (0, 'Invalid', 0, 1);
      `),
    ).toThrow(/CHECK constraint/u);
  });
});
