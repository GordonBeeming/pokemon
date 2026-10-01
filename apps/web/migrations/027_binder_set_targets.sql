-- Set targets: a pocket that takes any card from one set, the way a Pokémon target
-- takes any printing of one Pokémon.
--
-- entry_kind's CHECK allows only empty/reserved/exact-card/pokemon and SQLite can't
-- widen a CHECK without rebuilding the table, which is not done to a table holding
-- binder layouts. So a set target is stored as a 'reserved' pocket that names a set:
-- two nullable columns are added and nothing existing is rewritten. A plain reserved
-- sleeve keeps both columns NULL and behaves exactly as before.
ALTER TABLE binder_slots ADD COLUMN set_id TEXT
  CHECK (set_id IS NULL OR length(set_id) BETWEEN 1 AND 128);
ALTER TABLE binder_slots ADD COLUMN set_language TEXT
  CHECK (set_language IS NULL OR length(set_language) BETWEEN 2 AND 16);

CREATE INDEX idx_binder_slots_set ON binder_slots(set_id, set_language)
WHERE set_id IS NOT NULL;

-- The shape and assignment rules are triggers, so they can be replaced in place.
DROP TRIGGER binder_slots_shape_insert;
DROP TRIGGER binder_slots_shape_update;
DROP TRIGGER binder_slots_assignment_insert;
DROP TRIGGER binder_slots_assignment_update;

CREATE TRIGGER binder_slots_shape_insert
BEFORE INSERT ON binder_slots
WHEN NOT (
  (NEW.entry_kind = 'empty' AND NEW.card_id IS NULL AND NEW.pokemon_number IS NULL
    AND NEW.assigned_card_id IS NULL AND NEW.label IS NULL AND NEW.starts_new_page = 0
    AND NEW.set_id IS NULL AND NEW.set_language IS NULL)
  OR
  (NEW.entry_kind = 'empty' AND NEW.card_id IS NOT NULL AND NEW.pokemon_number IS NULL
    AND NEW.assigned_card_id IS NULL AND NEW.label IS NULL AND NEW.starts_new_page = 0
    AND NEW.set_id IS NULL AND NEW.set_language IS NULL)
  OR
  (NEW.entry_kind = 'reserved' AND NEW.card_id IS NULL AND NEW.pokemon_number IS NULL
    AND NEW.assigned_card_id IS NULL AND NEW.starts_new_page = 0
    AND NEW.set_id IS NULL AND NEW.set_language IS NULL)
  OR
  (NEW.entry_kind = 'reserved' AND NEW.card_id IS NULL AND NEW.pokemon_number IS NULL
    AND NEW.label IS NULL AND NEW.set_id IS NOT NULL AND NEW.set_language IS NOT NULL)
  OR
  (NEW.entry_kind = 'exact-card' AND NEW.card_id IS NOT NULL AND NEW.pokemon_number IS NULL
    AND NEW.set_id IS NULL AND NEW.set_language IS NULL)
  OR
  (NEW.entry_kind = 'pokemon' AND NEW.card_id IS NULL AND NEW.pokemon_number IS NOT NULL
    AND NEW.set_id IS NULL AND NEW.set_language IS NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'binder_slot_shape_invalid');
END;

CREATE TRIGGER binder_slots_shape_update
BEFORE UPDATE OF entry_kind, label, card_id, pokemon_number, assigned_card_id, starts_new_page,
  set_id, set_language
ON binder_slots
WHEN NOT (
  (NEW.entry_kind = 'empty' AND NEW.card_id IS NULL AND NEW.pokemon_number IS NULL
    AND NEW.assigned_card_id IS NULL AND NEW.label IS NULL AND NEW.starts_new_page = 0
    AND NEW.set_id IS NULL AND NEW.set_language IS NULL)
  OR
  (NEW.entry_kind = 'reserved' AND NEW.card_id IS NULL AND NEW.pokemon_number IS NULL
    AND NEW.assigned_card_id IS NULL AND NEW.starts_new_page = 0
    AND NEW.set_id IS NULL AND NEW.set_language IS NULL)
  OR
  (NEW.entry_kind = 'reserved' AND NEW.card_id IS NULL AND NEW.pokemon_number IS NULL
    AND NEW.label IS NULL AND NEW.set_id IS NOT NULL AND NEW.set_language IS NOT NULL)
  OR
  (NEW.entry_kind = 'exact-card' AND NEW.card_id IS NOT NULL AND NEW.pokemon_number IS NULL
    AND NEW.set_id IS NULL AND NEW.set_language IS NULL)
  OR
  (NEW.entry_kind = 'pokemon' AND NEW.card_id IS NULL AND NEW.pokemon_number IS NOT NULL
    AND NEW.set_id IS NULL AND NEW.set_language IS NULL)
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
        AND card.set_id = NEW.set_id AND card.language = NEW.set_language))
)
BEGIN
  SELECT RAISE(ABORT, 'binder_assignment_incompatible');
END;

CREATE TRIGGER binder_slots_assignment_update
BEFORE UPDATE OF entry_kind, card_id, pokemon_number, assigned_card_id, set_id, set_language
ON binder_slots
WHEN NEW.assigned_card_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM catalogue_cards card
  WHERE card.id = NEW.assigned_card_id
    AND ((NEW.entry_kind = 'exact-card' AND card.id = NEW.card_id)
      OR (NEW.entry_kind = 'pokemon' AND card.category = 'pokemon'
        AND card.pokedex_number = NEW.pokemon_number)
      OR (NEW.entry_kind = 'reserved' AND NEW.set_id IS NOT NULL
        AND card.set_id = NEW.set_id AND card.language = NEW.set_language))
)
BEGIN
  SELECT RAISE(ABORT, 'binder_assignment_incompatible');
END;
