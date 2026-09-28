#!/usr/bin/env node
// Zero-data-loss check for migrations 019-024: loads a real (data-only) prod
// dump into a scratch D1 copy on migration 018, measures every user-data
// table, applies 019-024, and confirms nothing outside the columns those
// migrations explicitly add has changed.
//
// Uses node:sqlite directly (the same real SQLite engine the rest of this
// repo's migration tests already run against) rather than `wrangler d1`,
// so the scratch database never touches `apps/web/.wrangler` and needs no
// local dev server. What's being verified is the SQL migrations' effect on
// row content, which node:sqlite's SQLite engine reproduces faithfully;
// D1-runtime-only behaviour (e.g. trigger cascades affecting reported
// `changes()` counts) isn't in scope for a pure data-content check like this.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const dumpPath = process.argv[2];
if (!dumpPath) {
  process.stderr.write('usage: node verify-prod-copy-migrations.mjs <dump.sql>\n');
  process.exit(1);
}

function formatTable(rows) {
  const columns = Object.keys(rows[0] ?? {});
  const widths = columns.map((column) =>
    Math.max(column.length, ...rows.map((row) => String(row[column]).length)),
  );
  const line = (values) =>
    values.map((value, index) => String(value).padEnd(widths[index])).join('  ');
  return [
    line(columns),
    line(widths.map((width) => '-'.repeat(width))),
    ...rows.map((row) => line(columns.map((column) => row[column]))),
  ].join('\n');
}

const migrationsDir = fileURLToPath(new URL('../migrations/', import.meta.url));

const BASELINE_MIGRATIONS = [
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
];
const NEW_MIGRATIONS = [
  '019_card_types.sql',
  '020_set_codes.sql',
  '021_pocket_inactive.sql',
  '022_settings_and_binder_display.sql',
  '023_collection_events.sql',
  '024_backup_settings_events.sql',
];

// catalogue_cards is intentionally count-only: migration 021 flips is_active
// for Pocket cards, so its row content is *expected* to change.
const COUNT_ONLY_TABLES = new Set(['catalogue_cards']);
const COMPARE_TABLES = [
  'users',
  'passkeys',
  'collection_cards',
  'collection_mutations',
  'binders',
  'binder_versions',
  'binder_pages',
  'binder_slots',
  'binder_bookmarks',
  'species_representatives',
  'catalogue_sets',
  'catalogue_cards',
];
// Columns 019-024 add to existing tables — excluded from the content hash so
// a legitimate backfill (e.g. catalogue_sets.abbreviation) isn't flagged as
// unwanted drift.
const COLUMNS_ADDED_BY_NEW_MIGRATIONS = new Set([
  'types',
  'abbreviation',
  'abbreviation_source',
  'peek_columns',
  'show_frame',
]);
// catalogue_sets' pre-existing AFTER UPDATE trigger bumps every user's
// backup_epoch unconditionally, so the ~190-row set-code backfill in 020
// legitimately advances it a lot; that's an internal change counter, not
// user data, and is excluded from the users-table comparison for that reason
// (confirmed by hand: label/id/created_at/mutation_epoch are unaffected).
const IGNORED_COLUMNS_BY_TABLE = { users: new Set(['backup_epoch']) };

function migrationSql(name) {
  return readFileSync(join(migrationsDir, name), 'utf8');
}

function applyMigrations(db, names) {
  for (const name of names) db.exec(migrationSql(name));
}

function loadDataOnlyDump(db, path) {
  const raw = readFileSync(path, 'utf8');
  // PRAGMA defer_foreign_keys only takes effect for the connection that
  // issues it; foreign_keys=OFF (set below) is the equivalent guarantee here,
  // and issuing it via .exec on a plain SQL script would otherwise be a no-op
  // fighting the pragma we already set.
  const withoutDeferPragma = raw
    .split('\n')
    .filter((line) => !line.startsWith('PRAGMA defer_foreign_keys'))
    .join('\n');
  const triggers = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'").all();
  db.exec('PRAGMA foreign_keys = OFF;');
  for (const trigger of triggers) db.exec(`DROP TRIGGER "${trigger.name}";`);
  db.exec('BEGIN;');
  try {
    db.exec(withoutDeferPragma);
    // FTS5 content isn't in the plain-SQL dump; rebuild it exactly how the
    // importer writes it (lib/catalogue.ts's stageCatalogueCards/apply path).
    db.exec(`
      INSERT INTO catalogue_search (card_id, name, set_name, number, species, rarity, artist)
      SELECT id, name, set_name, number, COALESCE(species, ''), COALESCE(rarity, ''), COALESCE(artist, '')
      FROM catalogue_cards;
    `);
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
  for (const trigger of triggers) if (trigger.sql) db.exec(trigger.sql);
  db.exec('PRAGMA foreign_keys = ON;');
  const integrity = db.prepare('PRAGMA integrity_check').get();
  if (integrity?.integrity_check !== 'ok')
    throw new Error(`prod dump failed integrity_check: ${JSON.stringify(integrity)}`);
  const fkViolations = db.prepare('PRAGMA foreign_key_check').all();
  if (fkViolations.length > 0)
    throw new Error(`prod dump has ${fkViolations.length} foreign key violation(s)`);
}

function tableExists(db, table) {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1").get(table),
  );
}

function measureTable(db, table) {
  const { count } = db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get();
  if (COUNT_ONLY_TABLES.has(table)) return { count, hash: null };
  const columns = db.prepare(`PRAGMA table_info("${table}")`).all();
  const pkColumns = columns
    .filter((column) => column.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((column) => column.name);
  const ignored = IGNORED_COLUMNS_BY_TABLE[table] ?? new Set();
  const compareColumns = columns
    .map((column) => column.name)
    .filter((name) => !COLUMNS_ADDED_BY_NEW_MIGRATIONS.has(name) && !ignored.has(name));
  const orderBy = (pkColumns.length ? pkColumns : compareColumns).map((c) => `"${c}"`).join(', ');
  const select = compareColumns.map((c) => `"${c}"`).join(', ');
  const rows = db.prepare(`SELECT ${select} FROM "${table}" ORDER BY ${orderBy}`).all();
  const hash = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  return { count, hash };
}

function measureAll(db) {
  const measurements = {};
  for (const table of COMPARE_TABLES) {
    if (!tableExists(db, table)) {
      measurements[table] = { count: 0, hash: null, missing: true };
      continue;
    }
    measurements[table] = measureTable(db, table);
  }
  return measurements;
}

const persistDir = mkdtempSync(join(tmpdir(), 'pokedex-prod-copy-migrations-'));
const dbPath = join(persistDir, 'scratch.sqlite');
let exitCode = 0;
try {
  const db = new DatabaseSync(dbPath);
  try {
    applyMigrations(db, BASELINE_MIGRATIONS);
    loadDataOnlyDump(db, dumpPath);
    const before = measureAll(db);
    applyMigrations(db, NEW_MIGRATIONS);
    const after = measureAll(db);

    const rows = COMPARE_TABLES.map((table) => {
      const countOnly = COUNT_ONLY_TABLES.has(table);
      const countMatch = before[table].count === after[table].count;
      const hashMatch = countOnly || before[table].hash === after[table].hash;
      return {
        table,
        before_count: before[table].count,
        after_count: after[table].count,
        countMatch,
        hashMatch: countOnly ? 'n/a (count-only)' : hashMatch,
        ok: countMatch && (countOnly || hashMatch),
      };
    });

    process.stdout.write(formatTable(rows) + '\n');

    const failed = rows.filter((row) => !row.ok);
    if (failed.length > 0) {
      process.stderr.write(
        `migrations 019-024 changed data outside their declared scope: ${failed.map((r) => r.table).join(', ')}\n`,
      );
      exitCode = 1;
    } else {
      process.stdout.write(
        'prod-copy migration check passed: no unexpected drift in any owner-data table.\n',
      );
    }
  } finally {
    db.close();
  }
} finally {
  rmSync(persistDir, { recursive: true, force: true });
}
process.exitCode = exitCode;
