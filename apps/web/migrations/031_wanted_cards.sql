CREATE TABLE wanted_cards (
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  card_id TEXT NOT NULL REFERENCES catalogue_cards(id) ON DELETE CASCADE,
  binder_id TEXT REFERENCES binders(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(owner_id,scope,card_id),
  CHECK(scope = COALESCE(binder_id,'general'))
);
CREATE INDEX idx_wanted_cards_binder ON wanted_cards(binder_id);
CREATE TRIGGER wanted_cards_epoch_insert AFTER INSERT ON wanted_cards BEGIN
  UPDATE users SET backup_epoch=backup_epoch+1 WHERE id=NEW.owner_id;
END;
CREATE TRIGGER wanted_cards_epoch_update AFTER UPDATE ON wanted_cards BEGIN
  UPDATE users SET backup_epoch=backup_epoch+1 WHERE id=NEW.owner_id;
END;
CREATE TRIGGER wanted_cards_epoch_delete AFTER DELETE ON wanted_cards BEGIN
  UPDATE users SET backup_epoch=backup_epoch+1 WHERE id=OLD.owner_id;
END;
ALTER TABLE backup_restore_chunks RENAME TO backup_restore_chunks_v30;
CREATE TABLE backup_restore_chunks (
  run_id TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('catalogue','sources','collection','species_representatives','binders','versions','pages','slots','bookmarks','activity','checkpoints','art_manifest','user_settings','collection_events','wanted')),
  chunk_index INTEGER NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(run_id,kind,chunk_index)
);
INSERT INTO backup_restore_chunks SELECT * FROM backup_restore_chunks_v30;
DROP TABLE backup_restore_chunks_v30;
CREATE INDEX idx_backup_restore_chunks_created ON backup_restore_chunks(created_at);
