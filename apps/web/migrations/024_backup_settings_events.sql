-- backup_restore_chunks is a scratch table (cleared per restore run), so widening
-- its CHECK means rebuilding it rather than an in-place ALTER of the constraint.
ALTER TABLE backup_restore_chunks RENAME TO backup_restore_chunks_v18;
CREATE TABLE backup_restore_chunks (
  run_id TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (
    kind IN (
      'catalogue', 'sources', 'collection', 'species_representatives', 'binders', 'versions',
      'pages', 'slots', 'bookmarks', 'art_manifest', 'user_settings', 'collection_events'
    )
  ),
  chunk_index INTEGER NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, kind, chunk_index)
);
INSERT INTO backup_restore_chunks (run_id, owner_id, kind, chunk_index, payload_json, created_at)
SELECT run_id, owner_id, kind, chunk_index, payload_json, created_at FROM backup_restore_chunks_v18;
DROP TABLE backup_restore_chunks_v18;
CREATE INDEX idx_backup_restore_chunks_created ON backup_restore_chunks(created_at);
