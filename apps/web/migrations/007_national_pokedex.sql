CREATE TABLE IF NOT EXISTS species_representatives (
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pokedex_number INTEGER NOT NULL CHECK (pokedex_number BETWEEN 1 AND 1025),
  card_id TEXT NOT NULL REFERENCES catalogue_cards(id) ON DELETE CASCADE,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, pokedex_number)
);

CREATE INDEX IF NOT EXISTS species_representatives_card
  ON species_representatives(card_id);

CREATE TRIGGER species_representatives_epoch_after_insert
AFTER INSERT ON species_representatives
BEGIN
  UPDATE users SET backup_epoch = backup_epoch + 1 WHERE id = NEW.owner_id;
END;
CREATE TRIGGER species_representatives_epoch_after_update
AFTER UPDATE ON species_representatives
BEGIN
  UPDATE users SET backup_epoch = backup_epoch + 1 WHERE id = NEW.owner_id;
  UPDATE users SET backup_epoch = backup_epoch + 1
  WHERE id = OLD.owner_id AND OLD.owner_id <> NEW.owner_id;
END;
CREATE TRIGGER species_representatives_epoch_after_delete
AFTER DELETE ON species_representatives
BEGIN
  UPDATE users SET backup_epoch = backup_epoch + 1 WHERE id = OLD.owner_id;
END;

ALTER TABLE backup_restore_chunks RENAME TO backup_restore_chunks_v6;

CREATE TABLE backup_restore_chunks (
  run_id TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (
    kind IN ('catalogue', 'sources', 'collection', 'species_representatives', 'binders', 'versions', 'pages', 'slots', 'art_manifest')
  ),
  chunk_index INTEGER NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, kind, chunk_index)
);

INSERT INTO backup_restore_chunks
  (run_id, owner_id, kind, chunk_index, payload_json, created_at)
SELECT run_id, owner_id, kind, chunk_index, payload_json, created_at
FROM backup_restore_chunks_v6;

DROP TABLE backup_restore_chunks_v6;

CREATE INDEX idx_backup_restore_chunks_created ON backup_restore_chunks(created_at);
