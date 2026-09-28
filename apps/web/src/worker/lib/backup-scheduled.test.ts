import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { runScheduledBackups, scheduledBackupOwnerIds } from './backup';
import { applyAllMigrations, sqliteD1 } from './d1-test-helper';

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

// Migration 025 (users.disabled_at) lands in parallel with this work, so a
// scheduled run must behave whether or not it has reached a given
// environment yet. This applies only 001-024 to reproduce the pre-025 shape.
function preMultiUserDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  databases.push(database);
  const directory = new URL('../../../migrations/', import.meta.url);
  for (const name of [
    '001_auth.sql',
    '002_catalogue_collection_binders.sql',
    '003_art_upload_tokens.sql',
    '004_staged_ingestion.sql',
    '005_catalogue_arrangement_metadata.sql',
    '006_hardening_and_sync.sql',
    '007_national_pokedex.sql',
    '008_physical_printing_identity.sql',
    '009_species_discovery_cache.sql',
    '010_price_source_availability.sql',
    '011_binder_capacity_and_placement.sql',
    '012_exact_binder_capacity.sql',
    '013_collector_number_search.sql',
    '014_binder_bookmarks.sql',
    '015_binder_gap_provenance.sql',
    '016_reserved_page_manual_placement.sql',
    '017_collection_addition_order.sql',
    '018_catalogue_sets.sql',
    '019_card_types.sql',
    '020_set_codes.sql',
    '021_pocket_inactive.sql',
    '022_settings_and_binder_display.sql',
    '023_collection_events.sql',
    '024_backup_settings_events.sql',
  ])
    database.exec(readFileSync(new URL(name, directory), 'utf8'));
  return database;
}

describe('scheduledBackupOwnerIds', () => {
  it('excludes disabled owners once users.disabled_at exists', async () => {
    const raw = new DatabaseSync(':memory:');
    databases.push(raw);
    applyAllMigrations(raw);
    raw.exec(`
      INSERT INTO users(id,label,created_at) VALUES('owner','Owner',1);
      INSERT INTO users(id,label,created_at,disabled_at) VALUES('guest','Guest',1,2);
    `);
    const ids = await scheduledBackupOwnerIds(sqliteD1(raw));
    expect(ids).toEqual(['owner']);
  });

  it('includes every user when users.disabled_at does not exist yet', async () => {
    const raw = preMultiUserDatabase();
    raw.exec(`INSERT INTO users(id,label,created_at) VALUES('owner','Owner',1);`);
    const ids = await scheduledBackupOwnerIds(sqliteD1(raw));
    expect(ids).toEqual(['owner']);
  });
});

describe('runScheduledBackups', () => {
  it('starts one backup workflow per non-disabled owner and skips a disabled one', async () => {
    const raw = new DatabaseSync(':memory:');
    databases.push(raw);
    applyAllMigrations(raw);
    raw.exec(`
      INSERT INTO users(id,label,created_at) VALUES('owner','Owner',1);
      INSERT INTO users(id,label,created_at) VALUES('active-2','Active Two',1);
      INSERT INTO users(id,label,created_at,disabled_at) VALUES('guest','Guest',1,2);
    `);
    const started: string[] = [];
    await runScheduledBackups(sqliteD1(raw), (ownerId) => {
      started.push(ownerId);
      return Promise.resolve({ id: `backup-${ownerId}` });
    });
    expect(started.sort()).toEqual(['active-2', 'owner']);
  });

  it("keeps starting the rest of the owners when one owner's workflow fails to start", async () => {
    const raw = new DatabaseSync(':memory:');
    databases.push(raw);
    applyAllMigrations(raw);
    raw.exec(`
      INSERT INTO users(id,label,created_at) VALUES('broken','Broken',1);
      INSERT INTO users(id,label,created_at) VALUES('owner','Owner',2);
    `);
    const started: string[] = [];
    await expect(
      runScheduledBackups(sqliteD1(raw), (ownerId) => {
        if (ownerId === 'broken') throw new Error('workflow_create_failed');
        started.push(ownerId);
        return Promise.resolve({ id: `backup-${ownerId}` });
      }),
    ).resolves.toBeUndefined();
    expect(started).toEqual(['owner']);
  });
});
