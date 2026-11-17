CREATE TABLE binder_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  binder_id TEXT NOT NULL REFERENCES binders(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('added', 'removed')),
  card_id TEXT NOT NULL,
  page INTEGER NOT NULL,
  row_index INTEGER NOT NULL,
  column_index INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_binder_activity_history ON binder_activity(binder_id, id);
CREATE TABLE binder_checkpoints (
  id TEXT PRIMARY KEY NOT NULL,
  binder_id TEXT NOT NULL REFERENCES binders(id) ON DELETE CASCADE,
  after_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_binder_checkpoints_history ON binder_checkpoints(binder_id, after_id, created_at);
-- Snapshots exist only inside the placement transaction, including during reflows.
CREATE TABLE binder_activity_snapshot (
  mutation_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  page INTEGER NOT NULL,
  row_index INTEGER NOT NULL,
  column_index INTEGER NOT NULL
);
CREATE INDEX idx_binder_activity_snapshot_mutation ON binder_activity_snapshot(mutation_id);

ALTER TABLE backup_restore_chunks RENAME TO backup_restore_chunks_v29;
CREATE TABLE backup_restore_chunks (
  run_id TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('catalogue','sources','collection','species_representatives','binders','versions','pages','slots','bookmarks','activity','checkpoints','art_manifest','user_settings','collection_events')),
  chunk_index INTEGER NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, kind, chunk_index)
);
INSERT INTO backup_restore_chunks SELECT * FROM backup_restore_chunks_v29;
DROP TABLE backup_restore_chunks_v29;
CREATE INDEX idx_backup_restore_chunks_created ON backup_restore_chunks(created_at);

CREATE TRIGGER binder_checkpoints_epoch_after_insert AFTER INSERT ON binder_checkpoints BEGIN
  UPDATE users SET backup_epoch = backup_epoch + 1
    WHERE id = (SELECT owner_id FROM binders WHERE id = NEW.binder_id);
END;
CREATE TRIGGER binder_checkpoints_epoch_after_update AFTER UPDATE ON binder_checkpoints BEGIN
  UPDATE users SET backup_epoch = backup_epoch + 1
    WHERE id = (SELECT owner_id FROM binders WHERE id = NEW.binder_id);
END;
CREATE TRIGGER binder_checkpoints_epoch_after_delete AFTER DELETE ON binder_checkpoints BEGIN
  UPDATE users SET backup_epoch = backup_epoch + 1
    WHERE id = (SELECT owner_id FROM binders WHERE id = OLD.binder_id);
END;
CREATE TRIGGER binder_activity_epoch_after_insert AFTER INSERT ON binder_activity BEGIN
  UPDATE users SET backup_epoch = backup_epoch + 1
    WHERE id = (SELECT owner_id FROM binders WHERE id = NEW.binder_id);
END;
CREATE TRIGGER binder_activity_epoch_after_update AFTER UPDATE ON binder_activity BEGIN
  UPDATE users SET backup_epoch = backup_epoch + 1
    WHERE id = (SELECT owner_id FROM binders WHERE id = NEW.binder_id);
END;
CREATE TRIGGER binder_activity_epoch_after_delete AFTER DELETE ON binder_activity BEGIN
  UPDATE users SET backup_epoch = backup_epoch + 1
    WHERE id = (SELECT owner_id FROM binders WHERE id = OLD.binder_id);
END;
