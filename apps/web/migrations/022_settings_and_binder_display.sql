CREATE TABLE user_settings (
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, key)
);

CREATE TRIGGER user_settings_epoch_after_insert AFTER INSERT ON user_settings BEGIN
  UPDATE users SET backup_epoch = backup_epoch + 1 WHERE id = NEW.owner_id;
END;
CREATE TRIGGER user_settings_epoch_after_update AFTER UPDATE ON user_settings BEGIN
  UPDATE users SET backup_epoch = backup_epoch + 1 WHERE id = NEW.owner_id;
END;
CREATE TRIGGER user_settings_epoch_after_delete AFTER DELETE ON user_settings BEGIN
  UPDATE users SET backup_epoch = backup_epoch + 1 WHERE id = OLD.owner_id;
END;

-- Per-binder display preferences: how many pockets peek from the next page,
-- and whether pockets show the coloured card frame or a raw card.
ALTER TABLE binders ADD COLUMN peek_columns INTEGER NOT NULL DEFAULT 1 CHECK (peek_columns IN (0, 1, 2));
ALTER TABLE binders ADD COLUMN show_frame INTEGER NOT NULL DEFAULT 1 CHECK (show_frame IN (0, 1));
