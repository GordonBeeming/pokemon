-- Card groups beyond sets: every card by one illustrator, and every card of one trainer's
-- Pokémon ("Lillie's Comfey", "Team Rocket's Mewtwo").
--
-- Spellings vary in the source (illustrators especially), so cards carry a normalised
-- key per group that pockets and filters match on. The normalisation lives in shared
-- code SQL can't run, so these columns start NULL; the importer fills them on every
-- sync and a one-off backfill fills existing rows.
ALTER TABLE catalogue_cards ADD COLUMN artist_key TEXT;
ALTER TABLE catalogue_cards ADD COLUMN trainer_key TEXT;
CREATE INDEX idx_catalogue_cards_artist_key ON catalogue_cards(artist_key)
WHERE artist_key IS NOT NULL;
CREATE INDEX idx_catalogue_cards_trainer_key ON catalogue_cards(trainer_key)
WHERE trainer_key IS NOT NULL;
-- The sync stages each card before applying it; the keys travel with it.
ALTER TABLE catalogue_stage_cards ADD COLUMN artist_key TEXT;
ALTER TABLE catalogue_stage_cards ADD COLUMN trainer_key TEXT;

-- A pocket that takes any card from a group is stored like a set target: a 'reserved'
-- pocket that names its group, because entry_kind's CHECK can't be widened without
-- rebuilding binder_slots. Existing rows keep both columns NULL.
ALTER TABLE binder_slots ADD COLUMN group_kind TEXT
  CHECK (group_kind IS NULL OR group_kind IN ('illustrator', 'trainer'));
ALTER TABLE binder_slots ADD COLUMN group_key TEXT
  CHECK (group_key IS NULL OR length(group_key) BETWEEN 1 AND 200);

DROP TRIGGER binder_slots_shape_insert;
DROP TRIGGER binder_slots_shape_update;
DROP TRIGGER binder_slots_assignment_insert;
DROP TRIGGER binder_slots_assignment_update;

CREATE TRIGGER binder_slots_shape_insert
BEFORE INSERT ON binder_slots
WHEN NOT (
  (NEW.entry_kind = 'empty' AND NEW.card_id IS NULL AND NEW.pokemon_number IS NULL
    AND NEW.assigned_card_id IS NULL AND NEW.label IS NULL AND NEW.starts_new_page = 0
    AND NEW.set_id IS NULL AND NEW.set_language IS NULL
    AND NEW.group_kind IS NULL AND NEW.group_key IS NULL)
  OR
  (NEW.entry_kind = 'empty' AND NEW.card_id IS NOT NULL AND NEW.pokemon_number IS NULL
    AND NEW.assigned_card_id IS NULL AND NEW.label IS NULL AND NEW.starts_new_page = 0
    AND NEW.set_id IS NULL AND NEW.set_language IS NULL
    AND NEW.group_kind IS NULL AND NEW.group_key IS NULL)
  OR
  (NEW.entry_kind = 'reserved' AND NEW.card_id IS NULL AND NEW.pokemon_number IS NULL
    AND NEW.assigned_card_id IS NULL AND NEW.starts_new_page = 0
    AND NEW.set_id IS NULL AND NEW.set_language IS NULL
    AND NEW.group_kind IS NULL AND NEW.group_key IS NULL)
  OR
  (NEW.entry_kind = 'reserved' AND NEW.card_id IS NULL AND NEW.pokemon_number IS NULL
    AND NEW.label IS NULL AND NEW.set_id IS NOT NULL AND NEW.set_language IS NOT NULL
    AND NEW.group_kind IS NULL AND NEW.group_key IS NULL)
  OR
  (NEW.entry_kind = 'reserved' AND NEW.card_id IS NULL AND NEW.pokemon_number IS NULL
    AND NEW.label IS NULL AND NEW.set_id IS NULL AND NEW.set_language IS NULL
    AND NEW.group_kind IS NOT NULL AND NEW.group_key IS NOT NULL)
  OR
  (NEW.entry_kind = 'exact-card' AND NEW.card_id IS NOT NULL AND NEW.pokemon_number IS NULL
    AND NEW.set_id IS NULL AND NEW.set_language IS NULL
    AND NEW.group_kind IS NULL AND NEW.group_key IS NULL)
  OR
  (NEW.entry_kind = 'pokemon' AND NEW.card_id IS NULL AND NEW.pokemon_number IS NOT NULL
    AND NEW.set_id IS NULL AND NEW.set_language IS NULL
    AND NEW.group_kind IS NULL AND NEW.group_key IS NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'binder_slot_shape_invalid');
END;

CREATE TRIGGER binder_slots_shape_update
BEFORE UPDATE OF entry_kind, label, card_id, pokemon_number, assigned_card_id, starts_new_page,
  set_id, set_language, group_kind, group_key
ON binder_slots
WHEN NOT (
  (NEW.entry_kind = 'empty' AND NEW.card_id IS NULL AND NEW.pokemon_number IS NULL
    AND NEW.assigned_card_id IS NULL AND NEW.label IS NULL AND NEW.starts_new_page = 0
    AND NEW.set_id IS NULL AND NEW.set_language IS NULL
    AND NEW.group_kind IS NULL AND NEW.group_key IS NULL)
  OR
  (NEW.entry_kind = 'reserved' AND NEW.card_id IS NULL AND NEW.pokemon_number IS NULL
    AND NEW.assigned_card_id IS NULL AND NEW.starts_new_page = 0
    AND NEW.set_id IS NULL AND NEW.set_language IS NULL
    AND NEW.group_kind IS NULL AND NEW.group_key IS NULL)
  OR
  (NEW.entry_kind = 'reserved' AND NEW.card_id IS NULL AND NEW.pokemon_number IS NULL
    AND NEW.label IS NULL AND NEW.set_id IS NOT NULL AND NEW.set_language IS NOT NULL
    AND NEW.group_kind IS NULL AND NEW.group_key IS NULL)
  OR
  (NEW.entry_kind = 'reserved' AND NEW.card_id IS NULL AND NEW.pokemon_number IS NULL
    AND NEW.label IS NULL AND NEW.set_id IS NULL AND NEW.set_language IS NULL
    AND NEW.group_kind IS NOT NULL AND NEW.group_key IS NOT NULL)
  OR
  (NEW.entry_kind = 'exact-card' AND NEW.card_id IS NOT NULL AND NEW.pokemon_number IS NULL
    AND NEW.set_id IS NULL AND NEW.set_language IS NULL
    AND NEW.group_kind IS NULL AND NEW.group_key IS NULL)
  OR
  (NEW.entry_kind = 'pokemon' AND NEW.card_id IS NULL AND NEW.pokemon_number IS NOT NULL
    AND NEW.set_id IS NULL AND NEW.set_language IS NULL
    AND NEW.group_kind IS NULL AND NEW.group_key IS NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'binder_slot_shape_invalid');
END;

CREATE TRIGGER binder_slots_assignment_insert
BEFORE INSERT ON binder_slots
WHEN NEW.assigned_card_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM catalogue_cards card
  WHERE card.id = NEW.assigned_card_id
    AND ((NEW.entry_kind = 'exact-card' AND card.id = NEW.card_id)
      OR (NEW.entry_kind = 'pokemon' AND card.category = 'pokemon'
        AND card.pokedex_number = NEW.pokemon_number)
      OR (NEW.entry_kind = 'reserved' AND NEW.set_id IS NOT NULL
        AND card.set_id = NEW.set_id AND card.language = NEW.set_language)
      OR (NEW.entry_kind = 'reserved' AND NEW.group_kind = 'illustrator'
        AND card.artist_key = NEW.group_key)
      OR (NEW.entry_kind = 'reserved' AND NEW.group_kind = 'trainer'
        AND card.trainer_key = NEW.group_key))
)
BEGIN
  SELECT RAISE(ABORT, 'binder_assignment_incompatible');
END;

CREATE TRIGGER binder_slots_assignment_update
BEFORE UPDATE OF entry_kind, card_id, pokemon_number, assigned_card_id, set_id, set_language,
  group_kind, group_key
ON binder_slots
WHEN NEW.assigned_card_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM catalogue_cards card
  WHERE card.id = NEW.assigned_card_id
    AND ((NEW.entry_kind = 'exact-card' AND card.id = NEW.card_id)
      OR (NEW.entry_kind = 'pokemon' AND card.category = 'pokemon'
        AND card.pokedex_number = NEW.pokemon_number)
      OR (NEW.entry_kind = 'reserved' AND NEW.set_id IS NOT NULL
        AND card.set_id = NEW.set_id AND card.language = NEW.set_language)
      OR (NEW.entry_kind = 'reserved' AND NEW.group_kind = 'illustrator'
        AND card.artist_key = NEW.group_key)
      OR (NEW.entry_kind = 'reserved' AND NEW.group_kind = 'trainer'
        AND card.trainer_key = NEW.group_key))
)
BEGIN
  SELECT RAISE(ABORT, 'binder_assignment_incompatible');
END;
