CREATE TABLE binder_bookmarks (
  id TEXT PRIMARY KEY,
  binder_page_id TEXT NOT NULL,
  row_index INTEGER NOT NULL,
  column_index INTEGER NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  created_at INTEGER NOT NULL,
  UNIQUE (binder_page_id, row_index, column_index),
  FOREIGN KEY (binder_page_id, row_index, column_index)
    REFERENCES binder_slots (binder_page_id, row_index, column_index) ON DELETE CASCADE
);

CREATE INDEX idx_binder_bookmarks_page ON binder_bookmarks(binder_page_id);

CREATE TRIGGER binder_bookmarks_epoch_after_insert AFTER INSERT ON binder_bookmarks BEGIN
  UPDATE users SET backup_epoch = backup_epoch + 1 WHERE id IN (
    SELECT b.owner_id FROM binders b JOIN binder_versions v ON v.binder_id = b.id
    JOIN binder_pages p ON p.binder_version_id = v.id WHERE p.id = NEW.binder_page_id
  );
END;
CREATE TRIGGER binder_bookmarks_epoch_after_update AFTER UPDATE ON binder_bookmarks BEGIN
  UPDATE users SET backup_epoch = backup_epoch + 1 WHERE id IN (
    SELECT b.owner_id FROM binders b JOIN binder_versions v ON v.binder_id = b.id
    JOIN binder_pages p ON p.binder_version_id = v.id WHERE p.id IN (NEW.binder_page_id, OLD.binder_page_id)
  );
END;
CREATE TRIGGER binder_bookmarks_epoch_after_delete AFTER DELETE ON binder_bookmarks BEGIN
  UPDATE users SET backup_epoch = backup_epoch + 1 WHERE id IN (
    SELECT b.owner_id FROM binders b JOIN binder_versions v ON v.binder_id = b.id
    JOIN binder_pages p ON p.binder_version_id = v.id WHERE p.id = OLD.binder_page_id
  );
END;

ALTER TABLE backup_restore_chunks RENAME TO backup_restore_chunks_v13;
CREATE TABLE backup_restore_chunks (
  run_id TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (
    kind IN ('catalogue', 'sources', 'collection', 'species_representatives', 'binders', 'versions', 'pages', 'slots', 'bookmarks', 'art_manifest')
  ),
  chunk_index INTEGER NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, kind, chunk_index)
);
INSERT INTO backup_restore_chunks (run_id, owner_id, kind, chunk_index, payload_json, created_at)
SELECT run_id, owner_id, kind, chunk_index, payload_json, created_at FROM backup_restore_chunks_v13;
DROP TABLE backup_restore_chunks_v13;
CREATE INDEX idx_backup_restore_chunks_created ON backup_restore_chunks(created_at);
