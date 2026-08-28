ALTER TABLE binder_versions ADD COLUMN capacity INTEGER;

UPDATE binder_versions
SET capacity = (
  SELECT COUNT(*)
  FROM binder_slots slot
  JOIN binder_pages page ON page.id = slot.binder_page_id
  WHERE page.binder_version_id = binder_versions.id
);

CREATE TRIGGER binder_versions_capacity_insert
BEFORE INSERT ON binder_versions
WHEN NEW.capacity IS NOT NULL AND (
  NEW.capacity < 1 OR NEW.capacity % (NEW.rows * NEW.columns) <> 0
)
BEGIN
  SELECT RAISE(ABORT, 'binder_capacity_invalid');
END;

CREATE TRIGGER binder_versions_capacity_default
AFTER INSERT ON binder_versions
WHEN NEW.capacity IS NULL
BEGIN
  UPDATE binder_versions SET capacity = NEW.rows * NEW.columns WHERE id = NEW.id;
END;

CREATE TRIGGER binder_versions_capacity_update
BEFORE UPDATE OF capacity, rows, columns ON binder_versions
WHEN NEW.capacity IS NULL
  OR NEW.capacity < 1
  OR NEW.capacity % (NEW.rows * NEW.columns) <> 0
BEGIN
  SELECT RAISE(ABORT, 'binder_capacity_invalid');
END;

ALTER TABLE binder_pages ADD COLUMN kind TEXT NOT NULL DEFAULT 'slots'
  CHECK (kind IN ('slots', 'reserved'));
ALTER TABLE binder_pages ADD COLUMN label TEXT
  CHECK (label IS NULL OR length(label) BETWEEN 1 AND 120);

ALTER TABLE binder_slots ADD COLUMN entry_kind TEXT NOT NULL DEFAULT 'empty'
  CHECK (entry_kind IN ('empty', 'reserved', 'exact-card', 'pokemon'));
ALTER TABLE binder_slots ADD COLUMN label TEXT
  CHECK (label IS NULL OR length(label) BETWEEN 1 AND 120);
ALTER TABLE binder_slots ADD COLUMN pokemon_number INTEGER
  CHECK (pokemon_number IS NULL OR pokemon_number BETWEEN 1 AND 1025);
ALTER TABLE binder_slots ADD COLUMN assigned_card_id TEXT REFERENCES catalogue_cards(id);
ALTER TABLE binder_slots ADD COLUMN starts_new_page INTEGER NOT NULL DEFAULT 0
  CHECK (starts_new_page IN (0, 1));

UPDATE binder_slots
SET entry_kind = CASE WHEN card_id IS NULL THEN 'empty' ELSE 'exact-card' END;

CREATE TRIGGER binder_slots_shape_insert
BEFORE INSERT ON binder_slots
WHEN NOT (
  (NEW.entry_kind = 'empty' AND NEW.card_id IS NULL AND NEW.pokemon_number IS NULL
    AND NEW.assigned_card_id IS NULL AND NEW.label IS NULL AND NEW.starts_new_page = 0)
  OR
  (NEW.entry_kind = 'empty' AND NEW.card_id IS NOT NULL AND NEW.pokemon_number IS NULL
    AND NEW.assigned_card_id IS NULL AND NEW.label IS NULL AND NEW.starts_new_page = 0)
  OR
  (NEW.entry_kind = 'reserved' AND NEW.card_id IS NULL AND NEW.pokemon_number IS NULL
    AND NEW.assigned_card_id IS NULL AND NEW.starts_new_page = 0)
  OR
  (NEW.entry_kind = 'exact-card' AND NEW.card_id IS NOT NULL AND NEW.pokemon_number IS NULL)
  OR
  (NEW.entry_kind = 'pokemon' AND NEW.card_id IS NULL AND NEW.pokemon_number IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'binder_slot_shape_invalid');
END;

CREATE TRIGGER binder_slots_legacy_exact_insert
AFTER INSERT ON binder_slots
WHEN NEW.entry_kind = 'empty' AND NEW.card_id IS NOT NULL
BEGIN
  UPDATE binder_slots SET entry_kind = 'exact-card'
  WHERE binder_page_id = NEW.binder_page_id
    AND row_index = NEW.row_index AND column_index = NEW.column_index;
END;

CREATE TRIGGER binder_slots_shape_update
BEFORE UPDATE OF entry_kind, label, card_id, pokemon_number, assigned_card_id, starts_new_page
ON binder_slots
WHEN NOT (
  (NEW.entry_kind = 'empty' AND NEW.card_id IS NULL AND NEW.pokemon_number IS NULL
    AND NEW.assigned_card_id IS NULL AND NEW.label IS NULL AND NEW.starts_new_page = 0)
  OR
  (NEW.entry_kind = 'reserved' AND NEW.card_id IS NULL AND NEW.pokemon_number IS NULL
    AND NEW.assigned_card_id IS NULL AND NEW.starts_new_page = 0)
  OR
  (NEW.entry_kind = 'exact-card' AND NEW.card_id IS NOT NULL AND NEW.pokemon_number IS NULL)
  OR
  (NEW.entry_kind = 'pokemon' AND NEW.card_id IS NULL AND NEW.pokemon_number IS NOT NULL)
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
        AND card.pokedex_number = NEW.pokemon_number))
)
BEGIN
  SELECT RAISE(ABORT, 'binder_assignment_incompatible');
END;

CREATE TRIGGER binder_slots_assignment_update
BEFORE UPDATE OF entry_kind, card_id, pokemon_number, assigned_card_id ON binder_slots
WHEN NEW.assigned_card_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM catalogue_cards card
  WHERE card.id = NEW.assigned_card_id
    AND ((NEW.entry_kind = 'exact-card' AND card.id = NEW.card_id)
      OR (NEW.entry_kind = 'pokemon' AND card.category = 'pokemon'
        AND card.pokedex_number = NEW.pokemon_number))
)
BEGIN
  SELECT RAISE(ABORT, 'binder_assignment_incompatible');
END;

CREATE INDEX idx_binder_slots_assigned_card ON binder_slots(assigned_card_id)
WHERE assigned_card_id IS NOT NULL;

CREATE TRIGGER binder_pages_reserved_insert
BEFORE INSERT ON binder_pages
WHEN NEW.kind = 'reserved' AND EXISTS (
  SELECT 1 FROM binder_slots slot
  WHERE slot.binder_page_id = NEW.id AND slot.entry_kind <> 'empty'
)
BEGIN
  SELECT RAISE(ABORT, 'binder_reserved_page_not_empty');
END;

CREATE TRIGGER binder_pages_reserved_update
BEFORE UPDATE OF kind ON binder_pages
WHEN NEW.kind = 'reserved' AND EXISTS (
  SELECT 1 FROM binder_slots slot
  WHERE slot.binder_page_id = NEW.id AND slot.entry_kind <> 'empty'
)
BEGIN
  SELECT RAISE(ABORT, 'binder_reserved_page_not_empty');
END;

CREATE TRIGGER binder_slots_reserved_page_insert
BEFORE INSERT ON binder_slots
WHEN NEW.entry_kind <> 'empty' AND EXISTS (
  SELECT 1 FROM binder_pages page WHERE page.id = NEW.binder_page_id AND page.kind = 'reserved'
)
BEGIN
  SELECT RAISE(ABORT, 'binder_reserved_page_not_empty');
END;

CREATE TRIGGER binder_slots_reserved_page_update
BEFORE UPDATE OF entry_kind ON binder_slots
WHEN NEW.entry_kind <> 'empty' AND EXISTS (
  SELECT 1 FROM binder_pages page WHERE page.id = NEW.binder_page_id AND page.kind = 'reserved'
)
BEGIN
  SELECT RAISE(ABORT, 'binder_reserved_page_not_empty');
END;
