CREATE TABLE migration_006_preflight (guard INTEGER NOT NULL);
CREATE TRIGGER migration_006_preflight_binder_layout
BEFORE INSERT ON migration_006_preflight
WHEN EXISTS (
  SELECT 1 FROM binder_versions
  WHERE NOT (
    (layout_kind = '2x2' AND rows = 2 AND columns = 2) OR
    (layout_kind = '3x3' AND rows = 3 AND columns = 3) OR
    (layout_kind = '4x3' AND rows = 3 AND columns = 4) OR
    (layout_kind = 'top-loader' AND rows = 2 AND columns = 2) OR
    (layout_kind = 'custom' AND rows BETWEEN 1 AND 20 AND columns BETWEEN 1 AND 20)
  )
)
BEGIN
  SELECT RAISE(ABORT, 'migration_006_binder_layout_conflict_repair_layout_before_retry');
END;
CREATE TRIGGER migration_006_preflight_binder_slots
BEFORE INSERT ON migration_006_preflight
WHEN EXISTS (
  SELECT 1
  FROM binder_slots slot
  JOIN binder_pages page ON page.id = slot.binder_page_id
  JOIN binder_versions version ON version.id = page.binder_version_id
  WHERE slot.row_index < 0 OR slot.row_index >= version.rows
    OR slot.column_index < 0 OR slot.column_index >= version.columns
)
BEGIN
  SELECT RAISE(ABORT, 'migration_006_binder_slot_out_of_bounds_repair_slot_before_retry');
END;
INSERT INTO migration_006_preflight VALUES (1);
DROP TRIGGER migration_006_preflight_binder_slots;
DROP TRIGGER migration_006_preflight_binder_layout;
DROP TABLE migration_006_preflight;

ALTER TABLE users ADD COLUMN mutation_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN backup_epoch INTEGER NOT NULL DEFAULT 0;

CREATE TABLE web_sessions (
  id_hash TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mutation_epoch INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_seen_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_web_sessions_user_active
  ON web_sessions(user_id, revoked_at, expires_at);
CREATE INDEX idx_web_sessions_expires ON web_sessions(expires_at);

ALTER TABLE backup_runs ADD COLUMN owner_id TEXT REFERENCES users(id);
UPDATE backup_runs
SET owner_id = substr(object_key, 9, instr(substr(object_key, 9), '/') - 1)
WHERE owner_id IS NULL
  AND object_key LIKE 'backups/%/%'
  AND instr(substr(object_key, 9), '/') > 1
  AND EXISTS (
    SELECT 1 FROM users
    WHERE users.id = substr(object_key, 9, instr(substr(object_key, 9), '/') - 1)
  );
CREATE INDEX idx_backup_runs_owner_created
  ON backup_runs(owner_id, created_at DESC);
CREATE TRIGGER backup_runs_require_owner_insert
BEFORE INSERT ON backup_runs
WHEN NEW.owner_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'backup_owner_required');
END;
CREATE TRIGGER backup_runs_require_owner_update
BEFORE UPDATE OF owner_id ON backup_runs
WHEN NEW.owner_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'backup_owner_required');
END;

ALTER TABLE desktop_tokens ADD COLUMN pair_code_hash TEXT;
CREATE UNIQUE INDEX idx_desktop_tokens_pair_code
  ON desktop_tokens(pair_code_hash) WHERE pair_code_hash IS NOT NULL;

ALTER TABLE art_manifest ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE art_upload_tokens ADD COLUMN expected_version INTEGER NOT NULL DEFAULT 1;
CREATE INDEX idx_art_upload_tokens_expiry
  ON art_upload_tokens(expires_at, consumed_at);
CREATE TABLE art_orphans (
  object_key TEXT PRIMARY KEY NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_art_orphans_created ON art_orphans(created_at);

CREATE TABLE backup_restore_chunks (
  run_id TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (
    kind IN ('catalogue', 'sources', 'collection', 'binders', 'versions', 'pages', 'slots', 'art_manifest')
  ),
  chunk_index INTEGER NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, kind, chunk_index)
);
CREATE INDEX idx_backup_restore_chunks_created ON backup_restore_chunks(created_at);
CREATE INDEX idx_collection_mutations_created ON collection_mutations(created_at);
CREATE INDEX idx_audit_created ON audit(created_at);

ALTER TABLE binder_versions ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE collection_cards ADD COLUMN last_mutation_id TEXT;
ALTER TABLE collection_mutations ADD COLUMN request_hash TEXT NOT NULL DEFAULT '';

WITH ranked_active AS (
  SELECT id,
    ROW_NUMBER() OVER (
      PARTITION BY binder_id
      ORDER BY COALESCE(activated_at, created_at) DESC, version_number DESC, id DESC
    ) AS active_rank
  FROM binder_versions
  WHERE status = 'active'
)
UPDATE binder_versions
SET status = 'archived'
WHERE id IN (SELECT id FROM ranked_active WHERE active_rank > 1);

UPDATE binders
SET active_version_id = (
  SELECT version.id
  FROM binder_versions version
  WHERE version.binder_id = binders.id AND version.status = 'active'
  ORDER BY COALESCE(version.activated_at, version.created_at) DESC,
    version.version_number DESC, version.id DESC
  LIMIT 1
)
WHERE EXISTS (
  SELECT 1 FROM binder_versions version
  WHERE version.binder_id = binders.id AND version.status = 'active'
);

UPDATE binders
SET active_version_id = NULL
WHERE active_version_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM binder_versions version
    WHERE version.id = binders.active_version_id
      AND version.binder_id = binders.id
      AND version.status = 'active'
  );

CREATE UNIQUE INDEX idx_binder_versions_one_active
  ON binder_versions(binder_id) WHERE status = 'active';

CREATE TRIGGER binder_versions_validate_layout_insert
BEFORE INSERT ON binder_versions
WHEN NOT (
  (NEW.layout_kind = '2x2' AND NEW.rows = 2 AND NEW.columns = 2) OR
  (NEW.layout_kind = '3x3' AND NEW.rows = 3 AND NEW.columns = 3) OR
  (NEW.layout_kind = '4x3' AND NEW.rows = 3 AND NEW.columns = 4) OR
  (NEW.layout_kind = 'top-loader' AND NEW.rows = 2 AND NEW.columns = 2) OR
  (NEW.layout_kind = 'custom' AND NEW.rows BETWEEN 1 AND 20 AND NEW.columns BETWEEN 1 AND 20)
)
BEGIN
  SELECT RAISE(ABORT, 'binder_layout_invalid');
END;
CREATE TRIGGER binder_versions_validate_layout_update
BEFORE UPDATE OF layout_kind, rows, columns ON binder_versions
WHEN NOT (
  (NEW.layout_kind = '2x2' AND NEW.rows = 2 AND NEW.columns = 2) OR
  (NEW.layout_kind = '3x3' AND NEW.rows = 3 AND NEW.columns = 3) OR
  (NEW.layout_kind = '4x3' AND NEW.rows = 3 AND NEW.columns = 4) OR
  (NEW.layout_kind = 'top-loader' AND NEW.rows = 2 AND NEW.columns = 2) OR
  (NEW.layout_kind = 'custom' AND NEW.rows BETWEEN 1 AND 20 AND NEW.columns BETWEEN 1 AND 20)
)
BEGIN
  SELECT RAISE(ABORT, 'binder_layout_invalid');
END;

CREATE TRIGGER binder_slots_validate_bounds_insert
BEFORE INSERT ON binder_slots
WHEN NOT EXISTS (
  SELECT 1
  FROM binder_pages page JOIN binder_versions version ON version.id = page.binder_version_id
  WHERE page.id = NEW.binder_page_id
    AND NEW.row_index >= 0 AND NEW.row_index < version.rows
    AND NEW.column_index >= 0 AND NEW.column_index < version.columns
)
BEGIN
  SELECT RAISE(ABORT, 'binder_slot_out_of_bounds');
END;
CREATE TRIGGER binder_slots_validate_bounds_update
BEFORE UPDATE OF binder_page_id, row_index, column_index ON binder_slots
WHEN NOT EXISTS (
  SELECT 1
  FROM binder_pages page JOIN binder_versions version ON version.id = page.binder_version_id
  WHERE page.id = NEW.binder_page_id
    AND NEW.row_index >= 0 AND NEW.row_index < version.rows
    AND NEW.column_index >= 0 AND NEW.column_index < version.columns
)
BEGIN
  SELECT RAISE(ABORT, 'binder_slot_out_of_bounds');
END;

CREATE TRIGGER binders_validate_active_version_insert
BEFORE INSERT ON binders
WHEN NEW.active_version_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM binder_versions version
    WHERE version.id = NEW.active_version_id
      AND version.binder_id = NEW.id
      AND version.status = 'active'
  )
BEGIN
  SELECT RAISE(ABORT, 'binder_active_version_invalid');
END;
CREATE TRIGGER binders_validate_active_version_update
BEFORE UPDATE OF active_version_id ON binders
WHEN NEW.active_version_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM binder_versions version
    WHERE version.id = NEW.active_version_id
      AND version.binder_id = NEW.id
      AND version.status = 'active'
  )
BEGIN
  SELECT RAISE(ABORT, 'binder_active_version_invalid');
END;

CREATE TRIGGER passkeys_revoke_sessions_after_delete
AFTER DELETE ON passkeys
BEGIN
  UPDATE users SET mutation_epoch = mutation_epoch + 1 WHERE id = OLD.user_id;
  UPDATE web_sessions SET revoked_at = unixepoch()
  WHERE user_id = OLD.user_id AND revoked_at IS NULL;
END;

CREATE TRIGGER collection_cards_epoch_after_insert
AFTER INSERT ON collection_cards
BEGIN
  UPDATE users SET backup_epoch = backup_epoch + 1 WHERE id = NEW.owner_id;
END;
CREATE TRIGGER collection_cards_epoch_after_update
AFTER UPDATE ON collection_cards
BEGIN
  UPDATE users SET backup_epoch = backup_epoch + 1 WHERE id = NEW.owner_id;
  UPDATE users SET backup_epoch = backup_epoch + 1
  WHERE id = OLD.owner_id AND OLD.owner_id <> NEW.owner_id;
END;
CREATE TRIGGER collection_cards_epoch_after_delete
AFTER DELETE ON collection_cards
BEGIN
  UPDATE users SET backup_epoch = backup_epoch + 1 WHERE id = OLD.owner_id;
END;
CREATE TRIGGER binders_epoch_after_insert
AFTER INSERT ON binders
BEGIN
  UPDATE users SET backup_epoch = backup_epoch + 1 WHERE id = NEW.owner_id;
END;
CREATE TRIGGER binders_epoch_after_update
AFTER UPDATE ON binders
BEGIN
  UPDATE users SET backup_epoch = backup_epoch + 1 WHERE id = NEW.owner_id;
  UPDATE users SET backup_epoch = backup_epoch + 1
  WHERE id = OLD.owner_id AND OLD.owner_id <> NEW.owner_id;
END;
CREATE TRIGGER binders_epoch_after_delete
AFTER DELETE ON binders
BEGIN
  UPDATE users SET backup_epoch = backup_epoch + 1 WHERE id = OLD.owner_id;
END;

-- Custom catalogue rows, their source metadata, and their art are part of every
-- owner's private backup. They have no owner column, so invalidate every owner
-- whenever that shared custom-card graph changes.
CREATE TRIGGER custom_catalogue_epoch_after_insert
AFTER INSERT ON catalogue_cards
WHEN NEW.is_custom = 1
BEGIN
  UPDATE users SET backup_epoch = backup_epoch + 1;
END;
CREATE TRIGGER custom_catalogue_epoch_after_update
AFTER UPDATE ON catalogue_cards
WHEN OLD.is_custom = 1 OR NEW.is_custom = 1
BEGIN
  UPDATE users SET backup_epoch = backup_epoch + 1;
END;
CREATE TRIGGER custom_catalogue_epoch_after_delete
AFTER DELETE ON catalogue_cards
WHEN OLD.is_custom = 1
BEGIN
  UPDATE users SET backup_epoch = backup_epoch + 1;
END;
CREATE TRIGGER custom_source_epoch_after_insert
AFTER INSERT ON card_sources
WHEN EXISTS (SELECT 1 FROM catalogue_cards WHERE id = NEW.card_id AND is_custom = 1)
BEGIN
  UPDATE users SET backup_epoch = backup_epoch + 1;
END;
CREATE TRIGGER custom_source_epoch_after_update
AFTER UPDATE ON card_sources
WHEN EXISTS (SELECT 1 FROM catalogue_cards WHERE id = OLD.card_id AND is_custom = 1)
  OR EXISTS (SELECT 1 FROM catalogue_cards WHERE id = NEW.card_id AND is_custom = 1)
BEGIN
  UPDATE users SET backup_epoch = backup_epoch + 1;
END;
CREATE TRIGGER custom_source_epoch_after_delete
AFTER DELETE ON card_sources
WHEN EXISTS (SELECT 1 FROM catalogue_cards WHERE id = OLD.card_id AND is_custom = 1)
BEGIN
  UPDATE users SET backup_epoch = backup_epoch + 1;
END;
CREATE TRIGGER custom_art_epoch_after_insert
AFTER INSERT ON art_manifest
WHEN EXISTS (SELECT 1 FROM catalogue_cards WHERE id = NEW.card_id AND is_custom = 1)
BEGIN
  UPDATE users SET backup_epoch = backup_epoch + 1;
END;
CREATE TRIGGER custom_art_epoch_after_update
AFTER UPDATE ON art_manifest
WHEN EXISTS (SELECT 1 FROM catalogue_cards WHERE id = OLD.card_id AND is_custom = 1)
  OR EXISTS (SELECT 1 FROM catalogue_cards WHERE id = NEW.card_id AND is_custom = 1)
BEGIN
  UPDATE users SET backup_epoch = backup_epoch + 1;
END;
CREATE TRIGGER custom_art_epoch_after_delete
AFTER DELETE ON art_manifest
WHEN EXISTS (SELECT 1 FROM catalogue_cards WHERE id = OLD.card_id AND is_custom = 1)
BEGIN
  UPDATE users SET backup_epoch = backup_epoch + 1;
END;

ALTER TABLE catalogue_cards ADD COLUMN number_sort INTEGER;
ALTER TABLE catalogue_stage_cards ADD COLUMN number_sort INTEGER;
UPDATE catalogue_cards
SET number_sort = CASE WHEN number GLOB '[0-9]*' THEN CAST(number AS INTEGER) ELSE NULL END;

ALTER TABLE sync_runs ADD COLUMN complete_source INTEGER NOT NULL DEFAULT 1
  CHECK (complete_source IN (0, 1));
ALTER TABLE sync_runs ADD COLUMN object_key TEXT;
CREATE TABLE sync_run_claims (
  run_id TEXT PRIMARY KEY NOT NULL REFERENCES sync_runs(id) ON DELETE CASCADE,
  claim_token TEXT NOT NULL,
  claimed_at INTEGER NOT NULL
);
CREATE INDEX idx_sync_runs_completed ON sync_runs(status, completed_at);
CREATE INDEX idx_catalogue_stage_run ON catalogue_stage_cards(run_id);
CREATE INDEX idx_catalogue_cards_search_order
  ON catalogue_cards(is_active, set_name COLLATE NOCASE, number_sort, number COLLATE NOCASE, name COLLATE NOCASE);
CREATE INDEX idx_catalogue_cards_keyset
  ON catalogue_cards(
    is_active,
    set_name,
    (number_sort IS NULL),
    COALESCE(number_sort, 0),
    number,
    name,
    id
  );
CREATE INDEX idx_card_sources_listing
  ON card_sources(provider, active, card_id, language, source_id);
CREATE INDEX idx_card_sources_language_active
  ON card_sources(provider, language, active, source_id);

CREATE TRIGGER card_sources_validate_language_insert
BEFORE INSERT ON card_sources
WHEN NOT EXISTS (
  SELECT 1 FROM catalogue_cards card
  WHERE card.id = NEW.card_id AND card.language = NEW.language
)
BEGIN
  SELECT RAISE(ABORT, 'card_source_language_mismatch');
END;
CREATE TRIGGER card_sources_validate_language_update
BEFORE UPDATE OF card_id, language ON card_sources
WHEN NOT EXISTS (
  SELECT 1 FROM catalogue_cards card
  WHERE card.id = NEW.card_id AND card.language = NEW.language
)
BEGIN
  SELECT RAISE(ABORT, 'card_source_language_mismatch');
END;

ALTER TABLE price_snapshots ADD COLUMN native_amount_micros INTEGER;
ALTER TABLE price_snapshots ADD COLUMN amount_aud_micros INTEGER;
UPDATE price_snapshots
SET native_amount_micros = MAX(1, CAST(ROUND(native_amount * 1000000) AS INTEGER)),
  amount_aud_micros = CASE
    WHEN amount_aud IS NULL THEN NULL
    ELSE CAST(ROUND(amount_aud * 1000000) AS INTEGER)
  END;
CREATE TABLE price_snapshot_migration_conflicts (
  id TEXT PRIMARY KEY NOT NULL,
  kept_snapshot_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  source TEXT NOT NULL,
  native_amount REAL NOT NULL,
  native_currency TEXT NOT NULL,
  price_kind TEXT NOT NULL,
  source_captured_at INTEGER NOT NULL,
  fx_date TEXT,
  amount_aud REAL,
  created_at INTEGER NOT NULL,
  native_amount_micros INTEGER NOT NULL,
  amount_aud_micros INTEGER,
  archived_at INTEGER NOT NULL
);
WITH ranked AS (
  SELECT snapshot.*,
    FIRST_VALUE(id) OVER observation AS kept_snapshot_id,
    ROW_NUMBER() OVER observation AS observation_rank
  FROM price_snapshots snapshot
  WINDOW observation AS (
    PARTITION BY card_id, source, source_captured_at
    ORDER BY (amount_aud IS NOT NULL) DESC, (fx_date IS NOT NULL) DESC, created_at DESC, id DESC
  )
)
INSERT INTO price_snapshot_migration_conflicts
  (id, kept_snapshot_id, card_id, source, native_amount, native_currency, price_kind,
   source_captured_at, fx_date, amount_aud, created_at, native_amount_micros,
   amount_aud_micros, archived_at)
SELECT id, kept_snapshot_id, card_id, source, native_amount, native_currency, price_kind,
  source_captured_at, fx_date, amount_aud, created_at, native_amount_micros,
  amount_aud_micros, unixepoch()
FROM ranked WHERE observation_rank > 1;
DELETE FROM price_snapshots
WHERE id IN (SELECT id FROM price_snapshot_migration_conflicts);
CREATE UNIQUE INDEX idx_price_snapshots_observation
  ON price_snapshots(card_id, source, source_captured_at);
CREATE INDEX idx_price_snapshots_retention ON price_snapshots(created_at);

CREATE TRIGGER price_snapshots_require_micros_insert
BEFORE INSERT ON price_snapshots
WHEN NEW.native_amount_micros IS NULL OR NEW.native_amount_micros <= 0
BEGIN
  SELECT RAISE(ABORT, 'price_micros_required');
END;
CREATE TRIGGER price_snapshots_require_micros_update
BEFORE UPDATE OF native_amount_micros ON price_snapshots
WHEN NEW.native_amount_micros IS NULL OR NEW.native_amount_micros <= 0
BEGIN
  SELECT RAISE(ABORT, 'price_micros_required');
END;

CREATE TABLE price_sync_runs (
  id TEXT PRIMARY KEY NOT NULL,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  status TEXT NOT NULL CHECK (status IN ('running', 'complete', 'failed')),
  row_count INTEGER NOT NULL DEFAULT 0,
  fx_date TEXT,
  error TEXT
);
CREATE INDEX idx_price_sync_runs_retention ON price_sync_runs(status, started_at);

ALTER TABLE price_stage_rows RENAME TO price_stage_rows_legacy;
CREATE TABLE price_stage_row_migration_archive (
  run_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  source TEXT NOT NULL,
  native_amount REAL NOT NULL,
  native_currency TEXT NOT NULL,
  source_captured_at INTEGER NOT NULL,
  disposition TEXT NOT NULL CHECK (disposition IN ('migrated', 'deduplicated')),
  kept_native_amount REAL NOT NULL,
  archived_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, card_id, source, native_amount)
);
CREATE INDEX idx_price_stage_migration_archive_run
  ON price_stage_row_migration_archive(run_id, disposition);
CREATE TABLE price_stage_rows (
  run_id TEXT NOT NULL REFERENCES price_sync_runs(id) ON DELETE CASCADE,
  card_id TEXT NOT NULL REFERENCES catalogue_cards(id),
  source TEXT NOT NULL CHECK (source IN ('tcgplayer', 'cardmarket')),
  native_amount_micros INTEGER NOT NULL CHECK (native_amount_micros > 0),
  native_currency TEXT NOT NULL CHECK (
    length(native_currency) = 3 AND native_currency = upper(native_currency)
  ),
  source_captured_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, card_id, source, source_captured_at)
);
INSERT INTO price_sync_runs (id, started_at, completed_at, status, row_count, error)
SELECT run_id, MIN(source_captured_at), unixepoch(), 'failed', COUNT(*),
  'legacy_stage_requires_resubmission'
FROM price_stage_rows_legacy
GROUP BY run_id;
WITH ranked AS (
  SELECT legacy.*,
    FIRST_VALUE(native_amount) OVER observation AS kept_native_amount,
    ROW_NUMBER() OVER observation AS observation_rank
  FROM price_stage_rows_legacy legacy
  WINDOW observation AS (
    PARTITION BY run_id, card_id, source, source_captured_at
    ORDER BY native_amount DESC, native_currency COLLATE BINARY, card_id
  )
)
INSERT INTO price_stage_row_migration_archive
  (run_id, card_id, source, native_amount, native_currency, source_captured_at,
   disposition, kept_native_amount, archived_at)
SELECT run_id, card_id, source, native_amount, native_currency, source_captured_at,
  CASE WHEN observation_rank = 1 THEN 'migrated' ELSE 'deduplicated' END,
  kept_native_amount, unixepoch()
FROM ranked;
INSERT INTO price_stage_rows
  (run_id, card_id, source, native_amount_micros, native_currency, source_captured_at, created_at)
SELECT run_id, card_id, source,
  MAX(1, CAST(ROUND(native_amount * 1000000) AS INTEGER)),
  upper(native_currency), source_captured_at, unixepoch()
FROM (
  SELECT legacy.*,
    ROW_NUMBER() OVER (
      PARTITION BY run_id, card_id, source, source_captured_at
      ORDER BY native_amount DESC, native_currency COLLATE BINARY, card_id
    ) AS observation_rank
  FROM price_stage_rows_legacy legacy
)
WHERE observation_rank = 1;
DROP TABLE price_stage_rows_legacy;
CREATE INDEX idx_price_stage_retention ON price_stage_rows(created_at);

CREATE TABLE card_current_prices (
  card_id TEXT PRIMARY KEY NOT NULL REFERENCES catalogue_cards(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('tcgplayer', 'cardmarket')),
  native_amount_micros INTEGER NOT NULL CHECK (native_amount_micros > 0),
  native_currency TEXT NOT NULL CHECK (
    length(native_currency) = 3 AND native_currency = upper(native_currency)
  ),
  source_captured_at INTEGER NOT NULL,
  fx_date TEXT,
  amount_aud_micros INTEGER,
  updated_at INTEGER NOT NULL
);
WITH latest AS (
  SELECT snapshot.*,
    ROW_NUMBER() OVER (
      PARTITION BY snapshot.card_id, snapshot.source
      ORDER BY snapshot.source_captured_at DESC, snapshot.created_at DESC
    ) AS source_rank
  FROM price_snapshots snapshot
), ranked AS (
  SELECT latest.*,
    ROW_NUMBER() OVER (
      PARTITION BY latest.card_id
      ORDER BY latest.amount_aud_micros IS NULL, latest.amount_aud_micros,
        latest.source_captured_at DESC
    ) AS card_rank
  FROM latest WHERE source_rank = 1
)
INSERT INTO card_current_prices
  (card_id, source, native_amount_micros, native_currency, source_captured_at,
   fx_date, amount_aud_micros, updated_at)
SELECT card_id, source, native_amount_micros, upper(native_currency), source_captured_at,
  fx_date, amount_aud_micros, unixepoch()
FROM ranked WHERE card_rank = 1;

CREATE TABLE price_sync_state (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  source_id TEXT,
  updated_at INTEGER NOT NULL
);
