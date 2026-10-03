-- Energy groups: a pocket that takes any energy card, any special energy, or any
-- energy of one basic type, so energy binders can be planned like set pages.
--
-- binder_slots.group_kind's CHECK (028) admits only illustrator and trainer, and
-- widening a CHECK means rebuilding the table, so energy pockets name their group in
-- a column of their own. Cards carry the group they belong to (the basic type, or
-- 'special'); like 028's keys it is filled by the importer and a one-off backfill.
ALTER TABLE catalogue_cards ADD COLUMN energy_key TEXT;
CREATE INDEX idx_catalogue_cards_energy_key ON catalogue_cards(energy_key)
WHERE energy_key IS NOT NULL;
ALTER TABLE catalogue_stage_cards ADD COLUMN energy_key TEXT;

ALTER TABLE binder_slots ADD COLUMN energy_group TEXT
  CHECK (energy_group IS NULL OR energy_group IN ('all', 'special', 'grass', 'fire', 'water',
    'lightning', 'psychic', 'fighting', 'darkness', 'metal', 'fairy', 'colorless'));

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
    AND NEW.group_kind IS NULL AND NEW.group_key IS NULL AND NEW.energy_group IS NULL)
  OR
  (NEW.entry_kind = 'empty' AND NEW.card_id IS NOT NULL AND NEW.pokemon_number IS NULL
    AND NEW.assigned_card_id IS NULL AND NEW.label IS NULL AND NEW.starts_new_page = 0
    AND NEW.set_id IS NULL AND NEW.set_language IS NULL
    AND NEW.group_kind IS NULL AND NEW.group_key IS NULL AND NEW.energy_group IS NULL)
  OR
  (NEW.entry_kind = 'reserved' AND NEW.card_id IS NULL AND NEW.pokemon_number IS NULL
    AND NEW.assigned_card_id IS NULL AND NEW.starts_new_page = 0
    AND NEW.set_id IS NULL AND NEW.set_language IS NULL
    AND NEW.group_kind IS NULL AND NEW.group_key IS NULL AND NEW.energy_group IS NULL)
  OR
  (NEW.entry_kind = 'reserved' AND NEW.card_id IS NULL AND NEW.pokemon_number IS NULL
    AND NEW.label IS NULL AND NEW.set_id IS NOT NULL AND NEW.set_language IS NOT NULL
    AND NEW.group_kind IS NULL AND NEW.group_key IS NULL AND NEW.energy_group IS NULL)
  OR
  (NEW.entry_kind = 'reserved' AND NEW.card_id IS NULL AND NEW.pokemon_number IS NULL
    AND NEW.label IS NULL AND NEW.set_id IS NULL AND NEW.set_language IS NULL
    AND NEW.group_kind IS NOT NULL AND NEW.group_key IS NOT NULL AND NEW.energy_group IS NULL)
  OR
  (NEW.entry_kind = 'reserved' AND NEW.card_id IS NULL AND NEW.pokemon_number IS NULL
    AND NEW.label IS NULL AND NEW.set_id IS NULL AND NEW.set_language IS NULL
    AND NEW.group_kind IS NULL AND NEW.group_key IS NULL AND NEW.energy_group IS NOT NULL)
  OR
  (NEW.entry_kind = 'exact-card' AND NEW.card_id IS NOT NULL AND NEW.pokemon_number IS NULL
    AND NEW.set_id IS NULL AND NEW.set_language IS NULL
    AND NEW.group_kind IS NULL AND NEW.group_key IS NULL AND NEW.energy_group IS NULL)
  OR
  (NEW.entry_kind = 'pokemon' AND NEW.card_id IS NULL AND NEW.pokemon_number IS NOT NULL
    AND NEW.set_id IS NULL AND NEW.set_language IS NULL
    AND NEW.group_kind IS NULL AND NEW.group_key IS NULL AND NEW.energy_group IS NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'binder_slot_shape_invalid');
END;

CREATE TRIGGER binder_slots_shape_update
BEFORE UPDATE OF entry_kind, label, card_id, pokemon_number, assigned_card_id, starts_new_page,
  set_id, set_language, group_kind, group_key, energy_group
ON binder_slots
WHEN NOT (
  (NEW.entry_kind = 'empty' AND NEW.card_id IS NULL AND NEW.pokemon_number IS NULL
    AND NEW.assigned_card_id IS NULL AND NEW.label IS NULL AND NEW.starts_new_page = 0
    AND NEW.set_id IS NULL AND NEW.set_language IS NULL
    AND NEW.group_kind IS NULL AND NEW.group_key IS NULL AND NEW.energy_group IS NULL)
  OR
  (NEW.entry_kind = 'reserved' AND NEW.card_id IS NULL AND NEW.pokemon_number IS NULL
    AND NEW.assigned_card_id IS NULL AND NEW.starts_new_page = 0
    AND NEW.set_id IS NULL AND NEW.set_language IS NULL
    AND NEW.group_kind IS NULL AND NEW.group_key IS NULL AND NEW.energy_group IS NULL)
  OR
  (NEW.entry_kind = 'reserved' AND NEW.card_id IS NULL AND NEW.pokemon_number IS NULL
    AND NEW.label IS NULL AND NEW.set_id IS NOT NULL AND NEW.set_language IS NOT NULL
    AND NEW.group_kind IS NULL AND NEW.group_key IS NULL AND NEW.energy_group IS NULL)
  OR
  (NEW.entry_kind = 'reserved' AND NEW.card_id IS NULL AND NEW.pokemon_number IS NULL
    AND NEW.label IS NULL AND NEW.set_id IS NULL AND NEW.set_language IS NULL
    AND NEW.group_kind IS NOT NULL AND NEW.group_key IS NOT NULL AND NEW.energy_group IS NULL)
  OR
  (NEW.entry_kind = 'reserved' AND NEW.card_id IS NULL AND NEW.pokemon_number IS NULL
    AND NEW.label IS NULL AND NEW.set_id IS NULL AND NEW.set_language IS NULL
    AND NEW.group_kind IS NULL AND NEW.group_key IS NULL AND NEW.energy_group IS NOT NULL)
  OR
  (NEW.entry_kind = 'exact-card' AND NEW.card_id IS NOT NULL AND NEW.pokemon_number IS NULL
    AND NEW.set_id IS NULL AND NEW.set_language IS NULL
    AND NEW.group_kind IS NULL AND NEW.group_key IS NULL AND NEW.energy_group IS NULL)
  OR
  (NEW.entry_kind = 'pokemon' AND NEW.card_id IS NULL AND NEW.pokemon_number IS NOT NULL
    AND NEW.set_id IS NULL AND NEW.set_language IS NULL
    AND NEW.group_kind IS NULL AND NEW.group_key IS NULL AND NEW.energy_group IS NULL)
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
        AND card.trainer_key = NEW.group_key)
      OR (NEW.entry_kind = 'reserved' AND NEW.energy_group IS NOT NULL
        AND card.category = 'energy'
        AND (NEW.energy_group = 'all' OR card.energy_key = NEW.energy_group)))
)
BEGIN
  SELECT RAISE(ABORT, 'binder_assignment_incompatible');
END;

CREATE TRIGGER binder_slots_assignment_update
BEFORE UPDATE OF entry_kind, card_id, pokemon_number, assigned_card_id, set_id, set_language,
  group_kind, group_key, energy_group
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
        AND card.trainer_key = NEW.group_key)
      OR (NEW.entry_kind = 'reserved' AND NEW.energy_group IS NOT NULL
        AND card.category = 'energy'
        AND (NEW.energy_group = 'all' OR card.energy_key = NEW.energy_group)))
)
BEGIN
  SELECT RAISE(ABORT, 'binder_assignment_incompatible');
END;
