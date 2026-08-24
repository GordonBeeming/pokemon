ALTER TABLE users ADD COLUMN mutation_epoch INTEGER NOT NULL DEFAULT 0;

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

ALTER TABLE binder_versions ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE collection_cards ADD COLUMN last_mutation_id TEXT;
ALTER TABLE collection_mutations ADD COLUMN request_hash TEXT NOT NULL DEFAULT '';

WITH ranked_active AS (
  SELECT id,
    ROW_NUMBER() OVER (
      PARTITION BY binder_id
      ORDER BY activated_at DESC, version_number DESC, id
    ) AS active_rank
  FROM binder_versions
  WHERE status = 'active'
)
UPDATE binder_versions
SET status = 'archived'
WHERE id IN (SELECT id FROM ranked_active WHERE active_rank > 1);

UPDATE binder_versions
SET rows = CASE layout_kind
    WHEN '2x2' THEN 2
    WHEN '3x3' THEN 3
    WHEN '4x3' THEN 3
    WHEN 'top-loader' THEN 2
    ELSE rows
  END,
  columns = CASE layout_kind
    WHEN '2x2' THEN 2
    WHEN '3x3' THEN 3
    WHEN '4x3' THEN 4
    WHEN 'top-loader' THEN 2
    ELSE columns
  END;

UPDATE binders
SET active_version_id = NULL
WHERE active_version_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM binder_versions version
    WHERE version.id = binders.active_version_id
      AND version.binder_id = binders.id
      AND version.status = 'active'
  );

DELETE FROM binder_slots
WHERE NOT EXISTS (
  SELECT 1
  FROM binder_pages page JOIN binder_versions version ON version.id = page.binder_version_id
  WHERE page.id = binder_slots.binder_page_id
    AND binder_slots.row_index < version.rows
    AND binder_slots.column_index < version.columns
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
SET native_amount_micros = CAST(ROUND(native_amount * 1000000) AS INTEGER),
  amount_aud_micros = CASE
    WHEN amount_aud IS NULL THEN NULL
    ELSE CAST(ROUND(amount_aud * 1000000) AS INTEGER)
  END;
DELETE FROM price_snapshots
WHERE rowid NOT IN (
  SELECT MAX(rowid) FROM price_snapshots GROUP BY card_id, source, source_captured_at
);
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
INSERT INTO price_sync_runs (id, started_at, status, row_count, error)
SELECT DISTINCT run_id, 0, 'running', 0, 'legacy_stage' FROM price_stage_rows_legacy;
INSERT INTO price_stage_rows
  (run_id, card_id, source, native_amount_micros, native_currency, source_captured_at, created_at)
SELECT run_id, card_id, source, CAST(ROUND(native_amount * 1000000) AS INTEGER),
  upper(native_currency), source_captured_at, unixepoch()
FROM price_stage_rows_legacy;
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
SELECT card_id, source, native_amount_micros, native_currency, source_captured_at,
  fx_date, amount_aud_micros, unixepoch()
FROM ranked WHERE card_rank = 1;

CREATE TABLE price_sync_state (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  source_id TEXT,
  updated_at INTEGER NOT NULL
);
