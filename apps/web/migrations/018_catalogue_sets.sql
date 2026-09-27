CREATE TABLE catalogue_sets (
  set_id TEXT NOT NULL,
  language TEXT NOT NULL,
  set_name TEXT NOT NULL,
  release_date TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (set_id, language)
);

-- Refuse to guess if older imports disagree about a set's release date.
CREATE TABLE set_date_preflight (valid INTEGER CHECK(valid=1));
INSERT INTO set_date_preflight
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM catalogue_cards GROUP BY set_id,language
  HAVING COUNT(DISTINCT NULLIF(release_date,''))>1
) THEN 0 ELSE 1 END;
DROP TABLE set_date_preflight;

INSERT INTO catalogue_sets(set_id,language,set_name,release_date,updated_at)
SELECT set_id,language,MIN(set_name),MIN(NULLIF(release_date,'')),MAX(updated_at)
FROM catalogue_cards GROUP BY set_id,language;
-- Keep the nullable legacy column for old clients, but no live date is stored on cards.
UPDATE catalogue_cards SET release_date=NULL WHERE release_date IS NOT NULL;
CREATE INDEX catalogue_sets_release_order ON catalogue_sets(release_date,set_id,language);

-- Set metadata is shared and appears in each owner's catalogue backup projection.
CREATE TRIGGER catalogue_sets_backup_insert AFTER INSERT ON catalogue_sets BEGIN
  UPDATE users SET backup_epoch=backup_epoch+1;
END;
CREATE TRIGGER catalogue_sets_backup_update AFTER UPDATE ON catalogue_sets BEGIN
  UPDATE users SET backup_epoch=backup_epoch+1;
END;
CREATE TRIGGER catalogue_sets_backup_delete AFTER DELETE ON catalogue_sets BEGIN
  UPDATE users SET backup_epoch=backup_epoch+1;
END;
