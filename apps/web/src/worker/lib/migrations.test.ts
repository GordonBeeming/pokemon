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

  it('increments mutation epochs once for each owner affected by an owner change', () => {
    const database = databaseAtMigrationFive();
    applyMigrationSix(database);

    database.exec(`
      INSERT INTO collection_cards (owner_id, card_id, quantity, revision, updated_at)
      VALUES ('owner-a', 'card-1', 1, 1, 1);
      UPDATE collection_cards SET owner_id = 'owner-b'
      WHERE owner_id = 'owner-a' AND card_id = 'card-1';
    `);

    expect(database.prepare('SELECT id, mutation_epoch FROM users ORDER BY id').all()).toEqual([
      { id: 'owner-a', mutation_epoch: 2 },
      { id: 'owner-b', mutation_epoch: 1 },
    ]);
    database.exec("DELETE FROM collection_cards WHERE owner_id = 'owner-b'");
    expect(database.prepare("SELECT mutation_epoch FROM users WHERE id = 'owner-b'").get()).toEqual(
      { mutation_epoch: 2 },
    );
  });
});
