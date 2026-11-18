-- Incoming copies cover a target without being counted as owned inventory.
ALTER TABLE binder_slots ADD COLUMN ordered_card_id TEXT REFERENCES catalogue_cards(id);
ALTER TABLE binder_slots ADD COLUMN ordered_add_copy INTEGER NOT NULL DEFAULT 1 CHECK (ordered_add_copy IN (0,1));
ALTER TABLE binder_slots ADD COLUMN ordered_at INTEGER;
CREATE INDEX idx_binder_slots_ordered ON binder_slots(ordered_card_id) WHERE ordered_card_id IS NOT NULL;
ALTER TABLE binder_activity_snapshot ADD COLUMN status TEXT NOT NULL DEFAULT 'received';
CREATE TABLE binder_activity_sequence_v32(seq INTEGER NOT NULL);
INSERT INTO binder_activity_sequence_v32 SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='binder_activity'),0);
ALTER TABLE binder_activity RENAME TO binder_activity_v32;
CREATE TABLE binder_activity (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 binder_id TEXT NOT NULL REFERENCES binders(id) ON DELETE CASCADE,
 version_id TEXT NOT NULL,version_number INTEGER NOT NULL,
 kind TEXT NOT NULL CHECK (kind IN ('added','removed','ordered','received','cancelled')),
 card_id TEXT NOT NULL,page INTEGER NOT NULL,row_index INTEGER NOT NULL,column_index INTEGER NOT NULL,created_at INTEGER NOT NULL
);
INSERT INTO binder_activity(id,binder_id,version_id,version_number,kind,card_id,page,row_index,column_index,created_at) SELECT id,binder_id,version_id,version_number,kind,card_id,page,row_index,column_index,created_at FROM binder_activity_v32;
DROP TABLE binder_activity_v32;
UPDATE sqlite_sequence SET seq=MAX(seq,(SELECT seq FROM binder_activity_sequence_v32)) WHERE name='binder_activity';
INSERT INTO sqlite_sequence(name,seq) SELECT 'binder_activity',seq FROM binder_activity_sequence_v32 WHERE NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name='binder_activity');
DROP TABLE binder_activity_sequence_v32;
CREATE INDEX idx_binder_activity_history ON binder_activity(binder_id,id);
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

CREATE TRIGGER binder_slots_ordered_insert
BEFORE INSERT ON binder_slots
WHEN NEW.ordered_card_id IS NOT NULL AND (NEW.assigned_card_id IS NOT NULL OR NEW.ordered_at IS NULL OR NOT EXISTS (
  SELECT 1 FROM catalogue_cards card
  WHERE card.id = NEW.ordered_card_id
    AND ((NEW.entry_kind = 'exact-card' AND card.id = NEW.card_id)
      OR (NEW.entry_kind = 'pokemon' AND card.category = 'pokemon'
        AND card.pokedex_number = NEW.pokemon_number)
      OR (NEW.entry_kind = 'reserved' AND NEW.set_id IS NOT NULL
        AND card.set_id = NEW.set_id AND card.language = NEW.set_language)
      OR (NEW.entry_kind = 'reserved' AND NEW.group_kind = 'illustrator'
        AND card.artist_key = NEW.group_key)
      OR (NEW.entry_kind = 'reserved' AND NEW.group_kind = 'trainer'
        AND card.trainer_key = NEW.group_key)
      OR (NEW.entry_kind = 'reserved' AND NEW.energy_group IS NOT NULL
        AND card.category = 'energy'
        AND (NEW.energy_group = 'all' OR card.energy_key = NEW.energy_group)))
))
BEGIN
  SELECT RAISE(ABORT, 'binder_assignment_incompatible');
END;

CREATE TRIGGER binder_slots_ordered_update
BEFORE UPDATE OF entry_kind, card_id, pokemon_number, assigned_card_id, ordered_card_id, ordered_at, set_id, set_language,
  group_kind, group_key, energy_group
ON binder_slots
WHEN NEW.ordered_card_id IS NOT NULL AND (NEW.assigned_card_id IS NOT NULL OR NEW.ordered_at IS NULL OR NOT EXISTS (
  SELECT 1 FROM catalogue_cards card
  WHERE card.id = NEW.ordered_card_id
    AND ((NEW.entry_kind = 'exact-card' AND card.id = NEW.card_id)
      OR (NEW.entry_kind = 'pokemon' AND card.category = 'pokemon'
        AND card.pokedex_number = NEW.pokemon_number)
      OR (NEW.entry_kind = 'reserved' AND NEW.set_id IS NOT NULL
        AND card.set_id = NEW.set_id AND card.language = NEW.set_language)
      OR (NEW.entry_kind = 'reserved' AND NEW.group_kind = 'illustrator'
        AND card.artist_key = NEW.group_key)
      OR (NEW.entry_kind = 'reserved' AND NEW.group_kind = 'trainer'
        AND card.trainer_key = NEW.group_key)
      OR (NEW.entry_kind = 'reserved' AND NEW.energy_group IS NOT NULL
        AND card.category = 'energy'
        AND (NEW.energy_group = 'all' OR card.energy_key = NEW.energy_group)))
))
BEGIN
  SELECT RAISE(ABORT, 'binder_assignment_incompatible');
END;
